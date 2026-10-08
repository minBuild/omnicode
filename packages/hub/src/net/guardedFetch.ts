/**
 * 16.2 guardedFetch — Hub 가 바깥으로 보내는 모든 HTTP 요청이 지나는 단일 관문.
 *
 * 1. 스킴: https 만. http 는 OMNICODE_MCP_ALLOW_HTTP_LOOPBACK 일 때 127.0.0.1|localhost|[::1] 에 한해 허용.
 * 2. 호스트 이름: localhost·점 없는 이름 거부 (allowPrivateHosts 예외).
 * 3. 주소: DNS 결과 **전부**를 ipRanges.ts 로 검사 (mapped/NAT64 는 안의 IPv4 로 재검사).
 * 4. DNS 고정: 검사한 주소로 직접 연결 (undici Agent 커스텀 connect). TLS servername·Host 는 원래 이름.
 * 5. 리다이렉트: 자동 추적 없음. 최대 N단계, 매 단계 1~4 재적용, https→http 강등 거부.
 * 6. 크기·시간: 응답 본문 maxResponseBytes, 연결 connectTimeoutMs. 요청 전체 시간 제한은 호출자의 signal 몫.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit, type buildConnector } from 'undici';
import { DEFAULTS, LIMITS } from '@omnicode/shared';
import { SsrfBlockedError, type FetchLike, type GuardedFetch, type GuardedFetchOptions, type Logger, type SsrfDecision } from '../contracts.js';
import {
  addressMatchesAllowlist,
  checkAddress,
  hostMatchesAllowlist,
  isLoopbackAddress,
  parseAllowEntries,
  type AllowEntry,
} from './ipRanges.js';

// ---------------------------------------------------------------------------
// 오류
// ---------------------------------------------------------------------------
export class ResponseTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`response body exceeds ${limitBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

export class TooManyRedirectsError extends Error {
  constructor(readonly maxRedirects: number) {
    super(`too many redirects (> ${maxRedirects})`);
    this.name = 'TooManyRedirectsError';
  }
}

export class DnsLookupError extends Error {
  constructor(
    readonly host: string,
    override readonly cause: unknown,
  ) {
    super(`DNS lookup failed for ${host}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'DnsLookupError';
  }
}

export class ConnectTimeoutError extends Error {
  constructor(
    readonly address: string,
    readonly timeoutMs: number,
  ) {
    super(`connect timeout after ${timeoutMs}ms (${address})`);
    this.name = 'ConnectTimeoutError';
  }
}

// ---------------------------------------------------------------------------
// 내부 계층 (테스트 주입점)
// ---------------------------------------------------------------------------
/** 검증을 통과한 단일 요청. `addresses`는 검사된 주소 목록(연결 후보, 순서대로 시도). */
export interface RawRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: RequestInit['body'];
  signal: AbortSignal | null | undefined;
  duplex?: 'half';
  /** 괄호 없는 소문자 호스트 이름 (pin 테이블 키) */
  hostKey: string;
  addresses: string[];
}
export type RawFetch = (req: RawRequest) => Promise<Response>;

export interface GuardedFetchInternalOptions extends GuardedFetchOptions {
  /** 테스트용: 검증된 요청을 실제로 보내는 계층을 바꾼다 (기본: undici + 고정 connect) */
  rawFetch?: RawFetch;
  /** 테스트용: 소켓 생성 함수 주입 */
  tcpConnect?: typeof net.connect;
  tlsConnect?: typeof tls.connect;
}

export interface GuardedFetchHandle extends GuardedFetch {
  /** 커넥션 풀을 닫는다 */
  close(): Promise<void>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function hostKeyOf(hostname: string): string {
  const h = hostname.toLowerCase();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const results = await dnsLookup(hostname, { all: true, order: 'verbatim' });
  return results.map((r) => r.address);
}

// ---------------------------------------------------------------------------
// pin 테이블 + 고정 connect
// ---------------------------------------------------------------------------
/** 호스트 키 → 검사 완료된 주소 목록. 항목은 항상 검사된 주소만 담는다. */
export class PinTable {
  private readonly map = new Map<string, string[]>();
  constructor(private readonly max = 1024) {}
  set(hostKey: string, addresses: string[]): void {
    this.map.delete(hostKey);
    this.map.set(hostKey, [...addresses]);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  get(hostKey: string): string[] | undefined {
    return this.map.get(hostKey);
  }
}

export interface PinnedConnectorOptions {
  pins: PinTable;
  connectTimeoutMs: number;
  tcpConnect?: typeof net.connect;
  tlsConnect?: typeof tls.connect;
}

/**
 * undici `connect` 구현. 원래 호스트 이름이 아니라 pin 테이블의 검사된 주소로 소켓을 연다.
 * TLS servername 은 원래 호스트 이름(IP 리터럴이면 생략)이라 인증서 검증은 그대로 동작한다.
 */
export function createPinnedConnector(opts: PinnedConnectorOptions): buildConnector.connector {
  const tcpConnect = opts.tcpConnect ?? net.connect;
  const tlsConnect = opts.tlsConnect ?? tls.connect;
  return function connect({ hostname, protocol, port, servername }, callback) {
    const addresses = opts.pins.get(hostKeyOf(hostname));
    if (!addresses || addresses.length === 0) {
      callback(new SsrfBlockedError(hostname, 'unpinned_host'), null);
      return;
    }
    const secure = protocol === 'https:';
    const portNum = Number(port) || (secure ? 443 : 80);
    const sni = servername || (net.isIP(hostname) ? undefined : hostname);

    const attempt = (index: number): void => {
      const address = addresses[index];
      if (address === undefined) {
        callback(new Error('no address to connect'), null);
        return;
      }
      let settled = false;
      const socket = secure
        ? tlsConnect({ host: address, port: portNum, servername: sni, ALPNProtocols: ['http/1.1'] })
        : tcpConnect({ host: address, port: portNum });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const err = new ConnectTimeoutError(address, opts.connectTimeoutMs);
        socket.destroy(err);
        callback(err, null);
      }, opts.connectTimeoutMs);
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 60_000);
        callback(null, socket);
      });
      socket.once('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (index + 1 < addresses.length) attempt(index + 1);
        else callback(err, null);
      });
    };
    attempt(0);
  };
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------
export function createGuardedFetch(opts: GuardedFetchInternalOptions = {}): GuardedFetchHandle {
  const allow: AllowEntry[] = parseAllowEntries(opts.allowPrivateHosts ?? []);
  const allowHttpLoopback = opts.allowHttpLoopback ?? false;
  const maxRedirects = opts.maxRedirects ?? LIMITS.maxRedirects;
  const maxResponseBytes = opts.maxResponseBytes ?? LIMITS.callResultBytes;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
  const lookup = opts.lookup ?? defaultLookup;
  const logger: Logger | undefined = opts.logger;

  const pins = new PinTable();
  let agent: Agent | null = null;
  const getAgent = (): Agent => {
    agent ??= new Agent({
      connect: createPinnedConnector({ pins, connectTimeoutMs, tcpConnect: opts.tcpConnect, tlsConnect: opts.tlsConnect }),
      // 요청 수준 시간 제한은 호출자의 signal 로 건다 (11.7: tools/call 은 최대 600초 이상도 가능)
      headersTimeout: 0,
      bodyTimeout: 0,
      allowH2: false,
    });
    return agent;
  };

  const defaultRawFetch: RawFetch = async (req) => {
    pins.set(req.hostKey, req.addresses);
    const init: UndiciRequestInit = {
      method: req.method,
      headers: req.headers as unknown as UndiciRequestInit['headers'],
      body: req.body as unknown as UndiciRequestInit['body'],
      signal: req.signal ?? null,
      redirect: 'manual',
      dispatcher: getAgent(),
    };
    if (req.duplex) init.duplex = req.duplex;
    const res = await undiciFetch(req.url, init);
    return res as unknown as Response;
  };
  const rawFetch = opts.rawFetch ?? defaultRawFetch;

  /** 1~3단계: 연결 없이 판정만 한다 */
  async function evaluate(url: URL): Promise<SsrfDecision> {
    const hostname = url.hostname;
    if (!hostname) return { ok: false, host: '', addresses: [], reason: 'invalid_url' };
    const host = hostKeyOf(hostname);
    const hostAllowed = hostMatchesAllowlist(host, allow);
    const loopbackHttp = allowHttpLoopback && url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(hostname);

    if (url.protocol !== 'https:' && !loopbackHttp) return { ok: false, host, addresses: [], reason: `scheme_not_https (${url.protocol})` };

    const isLiteral = net.isIP(host) !== 0;
    if (!isLiteral && !hostAllowed && !loopbackHttp) {
      if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, host, addresses: [], reason: 'localhost' };
      if (!host.includes('.')) return { ok: false, host, addresses: [], reason: 'dotless_hostname' };
    }

    let addresses: string[];
    if (isLiteral) addresses = [host];
    else {
      try {
        addresses = await lookup(host);
      } catch (e) {
        return { ok: false, host, addresses: [], reason: `dns_error: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    if (addresses.length === 0) return { ok: false, host, addresses, reason: 'no_addresses' };

    for (const address of addresses) {
      const c = checkAddress(address);
      if (c.kind === 'invalid') return { ok: false, host, addresses, reason: `invalid_address (${address})` };
      if (loopbackHttp) {
        // 개발용 예외는 정확히 루프백 주소로만 간다
        if (!isLoopbackAddress(address)) return { ok: false, host, addresses, reason: `loopback_expected (${address})` };
        continue;
      }
      if (c.kind === 'blocked' && !hostAllowed && !addressMatchesAllowlist(c.effective, allow)) {
        return { ok: false, host, addresses, reason: `private_address (${address} in ${c.range})` };
      }
    }
    return { ok: true, host, addresses };
  }

  async function check(input: string | URL): Promise<SsrfDecision> {
    let url: URL;
    try {
      url = input instanceof URL ? input : new URL(input);
    } catch {
      return { ok: false, host: String(input), addresses: [], reason: 'invalid_url' };
    }
    return evaluate(url);
  }

  const fetch: FetchLike = async (input, init = {}) => {
    let url: URL;
    try {
      url = input instanceof URL ? new URL(input.href) : new URL(input);
    } catch {
      throw new TypeError(`invalid URL: ${String(input)}`);
    }
    let method = (init.method ?? 'GET').toUpperCase();
    let body: RequestInit['body'] = init.body ?? null;
    const headers = new Headers(init.headers ?? undefined);
    const duplex = (init as { duplex?: 'half' }).duplex;

    for (let hop = 0; ; hop++) {
      const decision = await evaluate(url);
      if (!decision.ok) {
        const reason = decision.reason ?? 'blocked';
        logger?.warn({ host: decision.host, reason, hop }, 'guardedFetch blocked');
        if (reason.startsWith('dns_error')) throw new DnsLookupError(decision.host, reason);
        throw new SsrfBlockedError(decision.host, reason, decision.addresses);
      }

      const res = await rawFetch({ url, method, headers, body, signal: init.signal, duplex, hostKey: decision.host, addresses: decision.addresses });
      const location = res.headers.get('location');
      if (!REDIRECT_STATUSES.has(res.status) || location === null) return limitBody(res, maxResponseBytes);

      await discardBody(res);
      if (hop >= maxRedirects) throw new TooManyRedirectsError(maxRedirects);

      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new SsrfBlockedError(location, 'invalid_redirect_location');
      }
      if (url.protocol === 'https:' && next.protocol !== 'https:') {
        throw new SsrfBlockedError(hostKeyOf(next.hostname), `redirect_downgrade (${next.protocol})`);
      }
      // HTTP 의미론: 303 은 GET 으로, 301/302 의 POST 도 GET 으로. 307/308 은 메서드·본문 유지.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = null;
        for (const h of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location', 'transfer-encoding']) headers.delete(h);
      } else if (body !== null && !isReplayableBody(body)) {
        throw new TypeError('cannot follow redirect: request body is a stream and cannot be replayed');
      }
      if (next.origin !== url.origin) {
        for (const h of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(h);
      }
      logger?.debug({ from: hostKeyOf(url.hostname), to: hostKeyOf(next.hostname), status: res.status, hop: hop + 1 }, 'guardedFetch redirect');
      url = next;
    }
  };

  return {
    fetch,
    check,
    async close() {
      const a = agent;
      agent = null;
      if (a) await a.close();
    },
  };
}

// ---------------------------------------------------------------------------
// 보조
// ---------------------------------------------------------------------------
function isReplayableBody(body: NonNullable<RequestInit['body']>): boolean {
  if (typeof body === 'string') return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  if (body instanceof URLSearchParams) return true;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
  return false;
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // 이미 닫힌 본문
  }
}

/** 응답 본문을 maxBytes 로 제한한다. 초과하면 스트림을 오류로 끝내고(연결 중단) ResponseTooLargeError 를 낸다. */
export function limitBody(res: Response, maxBytes: number): Response {
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    void discardBody(res);
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!res.body) return res;
  let seen = 0;
  const limited = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(new ResponseTooLargeError(maxBytes));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  const out = new Response(limited, { status: res.status, statusText: res.statusText, headers: res.headers });
  Object.defineProperty(out, 'url', { value: res.url, configurable: true });
  Object.defineProperty(out, 'redirected', { value: res.redirected, configurable: true });
  return out;
}
