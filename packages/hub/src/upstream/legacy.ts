/**
 * legacy (2024-11-05 ~ 2025-11-25) 업스트림 커넥터 — SDK `Client` + `StreamableHTTPClientTransport`,
 * 실패 시 HTTP+SSE(`SSEClientTransport`) 폴백 (설계문서 11.1 P1 결과, 11.2 세션 모델).
 *
 * - 커넥터 하나 = 세션 하나. 404(세션 만료)면 투명하게 다시 initialize하고 조회성 요청만 재시도한다.
 * - 401은 onUnauthorized 뒤 정확히 1회 재시도. 403 insufficient_scope는 그대로 보고.
 * - 서버 발신 요청(sampling·elicitation·roots)은 핸들러를 두지 않아 SDK가 -32601로 답한다. capabilities도 광고하지 않는다.
 * - progress는 SDK onprogress로 받아 다운스트림 토큰을 달아 전달한다. 유휴 타임아웃은 progress마다 리셋.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  McpError,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResultSchema,
  ToolListChangedNotificationSchema,
  type Notification,
  type Progress,
  type Request,
  type Result,
} from '@modelcontextprotocol/sdk/types.js';
import { DEFAULTS, normalizeToolDefinition, type ToolDefinition } from '@omnicode/shared';
import {
  UpstreamError,
  type CallContext,
  type Logger,
  type ProbeResult,
  type ProgressNotification,
  type UpstreamConnector,
  type UpstreamConnectorOptions,
  type UpstreamTimeouts,
} from '../contracts.js';
import {
  HUB_CLIENT_INFO,
  UpstreamHttpError,
  abortErrorFrom,
  createRequestClock,
  describeError,
  insufficientScopeError,
  isAbortError,
  isRecord,
  mergeHeaders,
  protocolError,
  unauthorizedError,
  unavailableError,
  type RequestClock,
} from './common.js';

const MAX_LIST_PAGES = 100;

export type LegacyTransportKind = 'streamable_http' | 'sse';
type ListKind = 'tools' | 'prompts' | 'resources';
type LegacyClient = Client<Request, Notification, Result>;

/** 열려 있는 legacy 세션. probe가 열어 커넥터에 넘길 수 있다. */
export interface LegacySession {
  client: LegacyClient;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
  kind: LegacyTransportKind;
  probe: ProbeResult;
  /** 마지막으로 본 WWW-Authenticate (GET 스트림의 401·403은 SDK 오류에 헤더가 없어서 여기서 보관) */
  auth: { wwwAuthenticate?: string };
}

export function resolveTimeouts(t: Partial<UpstreamTimeouts> | undefined): UpstreamTimeouts {
  return {
    connectMs: t?.connectMs ?? DEFAULTS.connectTimeoutMs,
    initializeMs: t?.initializeMs ?? DEFAULTS.initializeTimeoutMs,
    listMs: t?.listMs ?? DEFAULTS.listTimeoutMs,
  };
}

/**
 * SDK 전송에 주입하는 fetch. 요청마다 `headers()`를 다시 평가해 합친다(갱신된 OAuth 토큰 반영).
 * POST·DELETE의 401·403·404는 SDK가 상태만 남기고 헤더를 버리기 전에 UpstreamHttpError로 끌어낸다.
 * GET(SSE 스트림)은 SDK·EventSource가 상태 코드를 직접 다루므로 WWW-Authenticate만 기록한다.
 */
function createSessionFetch(opts: UpstreamConnectorOptions, auth: { wwwAuthenticate?: string }) {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const merged = mergeHeaders(init?.headers, await opts.headers());
    const res = await opts.fetch(url, { ...init, headers: merged });
    if (res.status === 401 || res.status === 403) {
      const www = res.headers.get('www-authenticate');
      if (www) auth.wwwAuthenticate = www;
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && (res.status === 401 || res.status === 403 || res.status === 404)) {
      const text = await res.text().catch(() => '');
      throw new UpstreamHttpError(res.status, res.headers.get('www-authenticate'), text);
    }
    return res;
  };
}

/** 전송 하나로 initialize까지 마친 세션을 연다. 실패하면 원인 그대로 던진다 (분류는 classifyLegacyError). */
export async function openLegacySession(
  opts: UpstreamConnectorOptions,
  kind: LegacyTransportKind,
  o: { timeoutMs: number; signal?: AbortSignal | undefined },
): Promise<LegacySession> {
  const auth: { wwwAuthenticate?: string } = {};
  const fetchImpl = createSessionFetch(opts, auth);
  const url = new URL(opts.url);
  // 11.1: 리다이렉트는 guardedFetch가 처리하므로 SDK에는 'follow'
  const transport =
    kind === 'sse'
      ? new SSEClientTransport(url, { fetch: fetchImpl, redirectPolicy: 'follow' })
      : new StreamableHTTPClientTransport(url, { fetch: fetchImpl, redirectPolicy: 'follow' });
  let negotiated: string | undefined;
  const setVersion = transport.setProtocolVersion.bind(transport);
  transport.setProtocolVersion = (v: string) => {
    negotiated = v;
    setVersion(v);
  };
  // sampling·elicitation·roots 핸들러 없음 + capabilities 비움 → 서버 발신 요청은 SDK가 -32601로 답한다 (11.3)
  const client: LegacyClient = new Client({ ...HUB_CLIENT_INFO }, { capabilities: {} });
  client.onerror = (e) => opts.logger?.debug({ serverId: opts.serverId, err: describeError(e) }, 'upstream legacy client error');
  await client.connect(transport, { timeout: o.timeoutMs, signal: o.signal });
  const serverInfo = client.getServerVersion();
  const capabilities = client.getServerCapabilities();
  const instructions = client.getInstructions();
  return {
    client,
    transport,
    kind,
    auth,
    probe: {
      era: 'legacy',
      protocolVersion: negotiated ?? LATEST_PROTOCOL_VERSION,
      transport: kind,
      serverInfo: serverInfo ? { ...serverInfo } : null,
      capabilities: capabilities ? { ...capabilities } : null,
      ...(instructions !== undefined ? { instructions } : {}),
    },
  };
}

function stripMcpPrefix(message: string): string {
  return message.replace(/^MCP error -?\d+: /, '');
}

function fromStatus(status: number, wwwAuthenticate: string | null | undefined, detail: string): UpstreamError {
  if (status === 401) return unauthorizedError(wwwAuthenticate);
  if (status === 403) return insufficientScopeError(wwwAuthenticate) ?? unavailableError(`upstream HTTP 403: ${detail}`, 403);
  if (status === 404) return unavailableError('upstream session not found (HTTP 404)', 404);
  return unavailableError(`upstream HTTP ${status}: ${detail}`, status);
}

/** SDK·fetch 오류를 UpstreamError(또는 취소 오류)로. clock이 있으면 타임아웃·취소를 먼저 본다. */
export function classifyLegacyError(e: unknown, auth: { wwwAuthenticate?: string } | undefined, clock?: RequestClock): Error {
  if (clock?.timedOut) {
    return new UpstreamError('timeout', clock.timedOut === 'idle' ? 'upstream request went idle' : 'upstream request exceeded the total timeout');
  }
  if (clock?.cancelled) return abortErrorFrom(clock.signal);
  if (e instanceof UpstreamError) return e;
  if (e instanceof UpstreamHttpError) return fromStatus(e.status, e.wwwAuthenticate, e.bodyText.slice(0, 200));
  if (e instanceof StreamableHTTPError || e instanceof SseError) {
    const code = e.code;
    if (typeof code === 'number' && code >= 100 && code <= 599) return fromStatus(code, auth?.wwwAuthenticate, e.message);
    return unavailableError(e.message);
  }
  if (e instanceof McpError) {
    if (e.code === ErrorCode.RequestTimeout) return new UpstreamError('timeout', stripMcpPrefix(e.message));
    if (e.code === ErrorCode.ConnectionClosed) return unavailableError(`upstream connection closed: ${stripMcpPrefix(e.message)}`);
    return protocolError({ code: e.code, message: stripMcpPrefix(e.message), ...(e.data !== undefined ? { data: e.data } : {}) });
  }
  if (isAbortError(e)) return e;
  return unavailableError(`upstream request failed: ${describeError(e)}`);
}

/** 11.1 (2)→(3): Streamable HTTP initialize가 4xx(401·insufficient_scope 제외)로 실패하면 HTTP+SSE를 시도한다. */
export async function openLegacySessionWithFallback(
  opts: UpstreamConnectorOptions,
  o: { timeoutMs: number; signal?: AbortSignal | undefined; transport?: LegacyTransportKind | undefined },
): Promise<LegacySession> {
  if (o.transport === 'sse') {
    try {
      return await openLegacySession(opts, 'sse', o);
    } catch (e) {
      throw classifyLegacyError(e, undefined);
    }
  }
  let first: Error;
  try {
    return await openLegacySession(opts, 'streamable_http', o);
  } catch (e) {
    first = classifyLegacyError(e, undefined);
  }
  const status = first instanceof UpstreamError ? first.info.status : undefined;
  const fallback =
    o.transport !== 'streamable_http' &&
    first instanceof UpstreamError &&
    first.kind === 'unavailable' &&
    status !== undefined &&
    status >= 400 &&
    status < 500;
  if (!fallback) throw first;
  opts.logger?.debug({ serverId: opts.serverId, status }, 'streamable HTTP initialize rejected; trying HTTP+SSE');
  try {
    return await openLegacySession(opts, 'sse', o);
  } catch (e) {
    const second = classifyLegacyError(e, undefined);
    if (second instanceof UpstreamError && second.kind !== 'unavailable') throw second;
    if (!(second instanceof UpstreamError)) throw second; // 취소
    throw unavailableError(`streamable HTTP: ${first.message}; HTTP+SSE: ${second.message}`, status);
  }
}

export interface LegacyInternalOptions {
  /** probe가 이미 연 세션을 넘겨받는다 (initialize 중복 방지) */
  session?: LegacySession;
  /** 전송을 강제한다. 없으면 streamable_http → 4xx면 sse 폴백 */
  transport?: LegacyTransportKind;
}

interface RequestRun {
  clock: RequestClock;
  idleMs: number;
  totalMs?: number | undefined;
  onProgress?: ((p: Progress) => void) | undefined;
}

export class LegacyConnector implements UpstreamConnector {
  readonly era = 'legacy' as const;
  readonly serverId: string;

  private readonly opts: UpstreamConnectorOptions;
  private readonly timeouts: UpstreamTimeouts;
  private readonly log: Logger | undefined;
  private readonly forcedTransport: LegacyTransportKind | undefined;
  private session: LegacySession | undefined;
  private lastProbe: ProbeResult | undefined;
  private kind: LegacyTransportKind;
  private opening: Promise<LegacySession> | undefined;
  private closed = false;
  private readonly closingSessions = new WeakSet<LegacySession>();
  private readonly listChangedCbs = new Set<(kind: ListKind) => void>();
  private readonly closeCbs = new Set<(reason?: string) => void>();

  constructor(opts: UpstreamConnectorOptions, internal: LegacyInternalOptions = {}) {
    this.opts = opts;
    this.serverId = opts.serverId;
    this.log = opts.logger;
    this.timeouts = resolveTimeouts(opts.timeouts);
    this.forcedTransport = internal.transport ?? internal.session?.kind;
    this.kind = internal.session?.kind ?? internal.transport ?? 'streamable_http';
    if (internal.session) this.adopt(internal.session);
  }

  get protocolVersion(): string {
    return this.lastProbe?.protocolVersion ?? '';
  }
  get transport(): LegacyTransportKind {
    return this.kind;
  }
  get serverInfo(): Record<string, unknown> | null {
    return this.lastProbe?.serverInfo ?? null;
  }
  get capabilities(): Record<string, unknown> | null {
    return this.lastProbe?.capabilities ?? null;
  }

  // -- 연결 -----------------------------------------------------------------

  async connect(): Promise<ProbeResult> {
    const s = await this.ensureSession();
    return s.probe;
  }

  private assertOpen(): void {
    if (this.closed) throw unavailableError('upstream connector is closed');
  }

  private async ensureSession(): Promise<LegacySession> {
    this.assertOpen();
    if (this.session) return this.session;
    if (!this.opening) {
      this.opening = this.openWithAuthRetry().finally(() => {
        this.opening = undefined;
      });
    }
    return this.opening;
  }

  private async openWithAuthRetry(): Promise<LegacySession> {
    let authRetried = false;
    for (;;) {
      this.assertOpen();
      try {
        const s = await openLegacySessionWithFallback(this.opts, { timeoutMs: this.timeouts.initializeMs, transport: this.forcedTransport });
        if (this.closed) {
          await this.teardown(s);
          throw unavailableError('upstream connector is closed');
        }
        this.adopt(s);
        return s;
      } catch (e) {
        if (e instanceof UpstreamError && e.kind === 'unauthorized' && !authRetried && this.opts.onUnauthorized) {
          authRetried = true;
          if ((await this.opts.onUnauthorized(e.info.wwwAuthenticate)) === 'retry') continue;
        }
        throw e;
      }
    }
  }

  private adopt(s: LegacySession): void {
    this.session = s;
    this.kind = s.kind;
    this.lastProbe = s.probe;
    s.client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.emitListChanged('tools'));
    s.client.setNotificationHandler(PromptListChangedNotificationSchema, () => this.emitListChanged('prompts'));
    s.client.setNotificationHandler(ResourceListChangedNotificationSchema, () => this.emitListChanged('resources'));
    s.client.onclose = () => {
      if (this.closingSessions.has(s) || this.session !== s) return;
      this.session = undefined;
      this.log?.warn({ serverId: this.serverId }, 'upstream legacy transport closed; will re-initialize on next request');
      this.fireClose('transport closed');
    };
  }

  private async teardown(s: LegacySession): Promise<void> {
    this.closingSessions.add(s);
    if (s.kind === 'streamable_http') {
      await (s.transport as StreamableHTTPClientTransport).terminateSession().catch(() => undefined);
    }
    await s.client.close().catch(() => undefined);
  }

  /** 404(세션 만료) 뒤: 죽은 세션을 버리고 새로 initialize 한다. */
  private async reinitialize(stale: LegacySession): Promise<LegacySession> {
    if (this.session === stale) {
      this.session = undefined;
      void this.teardown(stale);
    }
    this.log?.info({ serverId: this.serverId }, 'upstream session expired (404); re-initializing');
    return this.ensureSession();
  }

  // -- 공개 메서드 ------------------------------------------------------------

  async listTools(signal?: AbortSignal): Promise<ToolDefinition[]> {
    return this.retryOnce(['unavailable', 'timeout'], async () => {
      const clock = createRequestClock({ signal, totalMs: this.timeouts.listMs });
      try {
        const tools: ToolDefinition[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const result = await this.request(
            { method: 'tools/list', params: cursor ? { cursor } : {} },
            { clock, idleMs: this.timeouts.listMs },
            true,
          );
          if (Array.isArray(result.tools)) {
            for (const t of result.tools) {
              if (isRecord(t) && typeof t.name === 'string') tools.push(normalizeToolDefinition(t));
            }
          }
          cursor = typeof result.nextCursor === 'string' && result.nextCursor !== '' ? result.nextCursor : undefined;
          if (++pages > MAX_LIST_PAGES) throw protocolError({ code: -32603, message: `tools/list exceeded ${MAX_LIST_PAGES} pages` });
        } while (cursor);
        return tools;
      } finally {
        clock.dispose();
      }
    });
  }

  async callTool(
    params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> },
    ctx: CallContext,
  ): Promise<Record<string, unknown>> {
    const callerToken = progressTokenOf(params._meta);
    const run = this.runFor(ctx, callerToken);
    try {
      // 11.7: tools/call은 재시도하지 않는다 (401 뒤 1회 제외). 404면 재초기화만 하고 오류를 돌려준다.
      return await this.request({ method: 'tools/call', params }, run, false);
    } finally {
      run.clock.dispose();
    }
  }

  async forward(method: string, params: Record<string, unknown> | undefined, ctx: CallContext): Promise<Record<string, unknown>> {
    const callerToken = progressTokenOf(isRecord(params?._meta) ? params._meta : undefined);
    const run = this.runFor(ctx, callerToken);
    try {
      return await this.retryOnce(['unavailable'], () => this.request({ method, params }, run, true));
    } finally {
      run.clock.dispose();
    }
  }

  onListChanged(cb: (kind: ListKind) => void): () => void {
    this.listChangedCbs.add(cb);
    return () => {
      this.listChangedCbs.delete(cb);
    };
  }

  onClose(cb: (reason?: string) => void): () => void {
    this.closeCbs.add(cb);
    return () => {
      this.closeCbs.delete(cb);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const opening = this.opening;
    if (opening) await opening.then(() => undefined, () => undefined);
    const s = this.session;
    this.session = undefined;
    if (s) await this.teardown(s);
    this.fireClose('closed');
  }

  // -- 요청 파이프라인 -----------------------------------------------------------

  private runFor(ctx: CallContext, callerToken: string | number | undefined): RequestRun {
    const idleMs = ctx.idleTimeoutMs > 0 ? ctx.idleTimeoutMs : DEFAULTS.idleTimeoutMs;
    const totalMs = ctx.timeoutMs > 0 ? ctx.timeoutMs : DEFAULTS.callTimeoutMs;
    return {
      clock: createRequestClock({ signal: ctx.signal, totalMs }),
      idleMs,
      totalMs,
      onProgress:
        callerToken !== undefined
          ? (p) => {
              const n: ProgressNotification = { progressToken: callerToken, progress: p.progress };
              if (typeof p.total === 'number') n.total = p.total;
              if (typeof p.message === 'string') n.message = p.message;
              ctx.onProgress(n);
            }
          : undefined,
    };
  }

  private async retryOnce<T>(kinds: ReadonlyArray<UpstreamError['kind']>, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!this.closed && e instanceof UpstreamError && kinds.includes(e.kind)) {
        this.log?.debug({ serverId: this.serverId, kind: e.kind, err: e.message }, 'retrying idempotent upstream request once');
        return await fn();
      }
      throw e;
    }
  }

  /**
   * JSON-RPC 요청 1개. 401은 onUnauthorized 뒤 1회 재시도. 404는 재초기화 뒤 idempotent일 때만 1회 재시도.
   * SDK의 timeout(유휴, progress로 리셋)·maxTotalTimeout에 더해 clock의 총 타이머가 취소를 보장한다.
   */
  private async request(req: { method: string; params?: Record<string, unknown> | undefined }, run: RequestRun, idempotent: boolean): Promise<Record<string, unknown>> {
    let authRetried = false;
    let reinitialized = false;
    for (;;) {
      const s = await this.ensureSession();
      try {
        const result = await s.client.request(req as Request, ResultSchema, {
          signal: run.clock.signal,
          timeout: run.idleMs,
          resetTimeoutOnProgress: true,
          ...(run.totalMs !== undefined ? { maxTotalTimeout: run.totalMs } : {}),
          // onprogress를 항상 달아야 SDK가 progressToken을 붙이고 유휴 타이머를 리셋한다. 전달은 다운스트림 토큰이 있을 때만.
          onprogress: (p) => run.onProgress?.(p),
        });
        return result as Record<string, unknown>;
      } catch (e) {
        const err = classifyLegacyError(e, s.auth, run.clock);
        if (!(err instanceof UpstreamError)) throw err;
        if (err.kind === 'unauthorized' && !authRetried && this.opts.onUnauthorized) {
          authRetried = true;
          if ((await this.opts.onUnauthorized(err.info.wwwAuthenticate)) === 'retry') continue;
          throw err;
        }
        if (err.info.status === 404 && err.kind === 'unavailable') {
          await this.reinitialize(s);
          if (idempotent && !reinitialized) {
            reinitialized = true;
            continue;
          }
          throw unavailableError(`upstream session expired (HTTP 404); re-initialized, ${req.method} was not retried`, 404);
        }
        throw err;
      }
    }
  }

  private emitListChanged(kind: ListKind): void {
    for (const cb of this.listChangedCbs) {
      try {
        cb(kind);
      } catch (e) {
        this.log?.warn({ serverId: this.serverId, err: describeError(e) }, 'onListChanged callback threw');
      }
    }
  }

  private fireClose(reason: string): void {
    for (const cb of this.closeCbs) {
      try {
        cb(reason);
      } catch (e) {
        this.log?.warn({ serverId: this.serverId, err: describeError(e) }, 'onClose callback threw');
      }
    }
  }
}

function progressTokenOf(meta: Record<string, unknown> | undefined): string | number | undefined {
  const t = meta?.progressToken;
  return typeof t === 'string' || typeof t === 'number' ? t : undefined;
}
