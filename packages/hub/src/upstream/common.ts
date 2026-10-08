/**
 * upstream 공통 도우미 — 두 세대 커넥터와 probe가 함께 쓴다 (설계문서 11장).
 *
 * 네트워크는 항상 UpstreamConnectorOptions.fetch 하나로만 나간다. 여기에는 네트워크 코드가 없고,
 * 헤더·오류 분류·JSON-RPC 형태 검사 같은 순수 도우미만 둔다.
 */
import type { FetchLike } from '../contracts.js';
import { UpstreamError } from '../contracts.js';

/** Hub가 업스트림에 알리는 자기 정보 (11.6: `_meta.clientInfo`는 Hub 자신). */
export const HUB_CLIENT_INFO = { name: 'omnicode-hub', version: '0.1.0' } as const;
export const USER_AGENT = `OmniCode-Hub/${HUB_CLIENT_INFO.version}`;

// ---------------------------------------------------------------------------
// JSON-RPC 형태
// ---------------------------------------------------------------------------
export type JsonRpcId = string | number | null;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotificationMessage {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponseMessage {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 파싱된 JSON이 JSON-RPC 오류 응답이면 error 객체를 돌려준다. */
export function jsonRpcErrorOf(body: unknown): JsonRpcErrorObject | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  const { code, message, data } = body.error;
  if (typeof code !== 'number' || typeof message !== 'string') return undefined;
  return data === undefined ? { code, message } : { code, message, data };
}

/** 메시지 하나가 JSON-RPC 알림인지 (method 있고 id 없음). */
export function isJsonRpcNotification(m: unknown): m is JsonRpcNotificationMessage {
  return isRecord(m) && typeof m.method === 'string' && !('id' in m);
}

/** 메시지 하나가 JSON-RPC 응답(result 또는 error)인지. */
export function isJsonRpcResponse(m: unknown): m is JsonRpcResponseMessage {
  return isRecord(m) && 'id' in m && !('method' in m) && ('result' in m || 'error' in m);
}

/**
 * 11.1: 400 본문이 "modern JSON-RPC 오류"인지. HeaderMismatch(-32020)이거나
 * UnsupportedProtocolVersion처럼 `data.supported`(또는 `data.supportedVersions`)에 버전 목록을 실은 것만 인정한다.
 * legacy SDK 서버의 `-32000 Bad Request: Unsupported protocol version ...`은 메시지만 비슷할 뿐이므로 메시지로 판정하지 않는다.
 */
export function isModernJsonRpcError(err: JsonRpcErrorObject | undefined): boolean {
  if (!err) return false;
  if (err.code === -32020) return true;
  return advertisedVersionsOf(err).length > 0;
}

/** UnsupportedProtocolVersion 오류가 알려 준 버전 목록. */
export function advertisedVersionsOf(err: JsonRpcErrorObject | undefined): string[] {
  if (!err || !isRecord(err.data)) return [];
  const list = err.data.supported ?? err.data.supportedVersions ?? err.data.supportedProtocolVersions;
  if (!Array.isArray(list)) return [];
  return list.filter((v): v is string => typeof v === 'string');
}

/** JSON-RPC 오류를 UpstreamError('protocol')로. */
export function protocolError(err: JsonRpcErrorObject, status?: number): UpstreamError {
  return new UpstreamError('protocol', `upstream JSON-RPC error ${err.code}: ${err.message}`, {
    ...(status !== undefined ? { status } : {}),
    rpc: err,
  });
}

// ---------------------------------------------------------------------------
// HTTP 상태 · WWW-Authenticate
// ---------------------------------------------------------------------------

/** fetch 래퍼가 401·403·404를 SDK 안쪽에서 끌어내기 위해 던지는 오류. */
export class UpstreamHttpError extends Error {
  constructor(
    readonly status: number,
    readonly wwwAuthenticate: string | null,
    readonly bodyText: string = '',
  ) {
    super(`upstream HTTP ${status}`);
    this.name = 'UpstreamHttpError';
  }
}

export interface WwwAuthenticate {
  scheme: string | null;
  params: Record<string, string>;
}

/** `Bearer realm="x", error="insufficient_scope", scope="a b"` 형태를 느슨하게 파싱한다. */
export function parseWwwAuthenticate(header: string | null | undefined): WwwAuthenticate {
  const out: WwwAuthenticate = { scheme: null, params: {} };
  if (!header) return out;
  const m = /^\s*([A-Za-z][A-Za-z0-9._~+/-]*)\s*(.*)$/s.exec(header);
  if (!m) return out;
  out.scheme = m[1] ?? null;
  const rest = m[2] ?? '';
  const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let p: RegExpExecArray | null;
  while ((p = re.exec(rest)) !== null) {
    const key = (p[1] ?? '').toLowerCase();
    const value = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : (p[3] ?? '');
    if (key) out.params[key] = value;
  }
  return out;
}

export function unauthorizedError(wwwAuthenticate: string | null | undefined, message = 'upstream returned 401'): UpstreamError {
  return new UpstreamError('unauthorized', message, {
    status: 401,
    ...(wwwAuthenticate ? { wwwAuthenticate } : {}),
  });
}

/** 403 응답이 `insufficient_scope`면 그 오류를, 아니면 undefined. */
export function insufficientScopeError(wwwAuthenticate: string | null | undefined): UpstreamError | undefined {
  const parsed = parseWwwAuthenticate(wwwAuthenticate);
  if (parsed.params.error !== 'insufficient_scope') return undefined;
  const scope = parsed.params.scope;
  return new UpstreamError('insufficient_scope', `upstream requires additional scope${scope ? `: ${scope}` : ''}`, {
    status: 403,
    ...(scope ? { scope } : {}),
    ...(wwwAuthenticate ? { wwwAuthenticate } : {}),
  });
}

export function unavailableError(message: string, status?: number): UpstreamError {
  return new UpstreamError('unavailable', message, status !== undefined ? { status } : {});
}

export function timeoutError(what: string, ms: number): UpstreamError {
  return new UpstreamError('timeout', `${what} did not complete within ${ms}ms`);
}

// ---------------------------------------------------------------------------
// 취소
// ---------------------------------------------------------------------------
export function isAbortError(e: unknown): e is Error {
  return e instanceof Error && e.name === 'AbortError';
}

/** 취소된 signal의 reason을 오류로 돌려준다 (reason이 없으면 표준 AbortError). */
export function abortErrorFrom(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException('The operation was aborted', 'AbortError');
}

export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---------------------------------------------------------------------------
// 헤더
// ---------------------------------------------------------------------------

/** init.headers 위에 extra를 덮어쓴다 (extra 우선). User-Agent가 없으면 Hub 것을 넣는다. */
export function mergeHeaders(init: HeadersInit | undefined, extra: Record<string, string>): Headers {
  const h = new Headers(init);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  if (!h.has('user-agent')) h.set('user-agent', USER_AGENT);
  return h;
}

/**
 * SDK 전송에 주입하는 fetch. 요청마다 `headers()`를 다시 평가해 합치고(갱신된 OAuth 토큰 반영),
 * 401·403·404는 SDK가 삼키기 전에 UpstreamHttpError로 끌어낸다.
 */
export function createHeaderFetch(base: FetchLike, headers: () => Promise<Record<string, string>>): FetchLike {
  return async (url, init) => {
    const merged = mergeHeaders(init?.headers, await headers());
    const res = await base(url, { ...init, headers: merged });
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      const www = res.headers.get('www-authenticate');
      const text = await res.text().catch(() => '');
      throw new UpstreamHttpError(res.status, www, text);
    }
    return res;
  };
}

// ---------------------------------------------------------------------------
// Mcp-Name 센티널 인코딩 (2026-07-28)
// ---------------------------------------------------------------------------
const SENTINEL_RE = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/;

/** 그대로 헤더에 실을 수 있는 값: 비어 있지 않고, 보이는 ASCII(+내부 공백)만, 앞뒤 공백 없음, 센티널 모양 아님. */
export function isPlainHeaderValue(value: string): boolean {
  if (value.length === 0) return false;
  if (!/^[\x20-\x7e]+$/.test(value)) return false;
  if (value.startsWith(' ') || value.endsWith(' ')) return false;
  if (/^=\?.*\?=$/.test(value)) return false;
  return true;
}

export function encodeMcpName(value: string): string {
  if (isPlainHeaderValue(value)) return value;
  return `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function decodeMcpName(value: string): string {
  const m = SENTINEL_RE.exec(value);
  if (!m) return value;
  return Buffer.from(m[1] ?? '', 'base64').toString('utf8');
}

// ---------------------------------------------------------------------------
// 타이머 묶음 — 총 타임아웃 · 유휴 타임아웃 · 외부 취소를 AbortController 하나로 모은다
// ---------------------------------------------------------------------------
export interface RequestClock {
  signal: AbortSignal;
  /** progress가 오면 유휴 타이머를 되돌린다 */
  touch(): void;
  /** 타임아웃으로 끝났으면 'idle' | 'total', 아니면 undefined */
  readonly timedOut: 'idle' | 'total' | undefined;
  /** 외부 signal 때문에 취소되었는지 */
  readonly cancelled: boolean;
  dispose(): void;
}

export function createRequestClock(o: { signal?: AbortSignal; idleMs?: number; totalMs?: number }): RequestClock {
  const ac = new AbortController();
  let timedOut: 'idle' | 'total' | undefined;
  let cancelled = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;

  const fire = (kind: 'idle' | 'total') => {
    if (ac.signal.aborted) return;
    timedOut = kind;
    ac.abort(new UpstreamError('timeout', `${kind} timeout`));
  };
  const armIdle = () => {
    if (!o.idleMs || o.idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fire('idle'), o.idleMs);
  };
  const onAbort = () => {
    if (ac.signal.aborted) return;
    cancelled = true;
    ac.abort(o.signal?.reason);
  };

  if (o.signal) {
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener('abort', onAbort, { once: true });
  }
  if (o.totalMs && o.totalMs > 0) totalTimer = setTimeout(() => fire('total'), o.totalMs);
  armIdle();

  return {
    signal: ac.signal,
    touch: armIdle,
    get timedOut() {
      return timedOut;
    },
    get cancelled() {
      return cancelled;
    },
    dispose() {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      o.signal?.removeEventListener('abort', onAbort);
    },
  };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortErrorFrom(signal));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortErrorFrom(signal as AbortSignal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
