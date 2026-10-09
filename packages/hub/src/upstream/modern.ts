/**
 * 2026-07-28 ("modern") 업스트림 커넥터 — 설계문서 11.1 P1 결과.
 *
 * SDK 1.32.1은 이 버전을 모르므로 직접 구현한다: 무상태 POST 1회 = JSON-RPC 요청 1개,
 * `_meta`에 버전·clientInfo·clientCapabilities, 필수 헤더(`Mcp-Method`·`Mcp-Name`·`Mcp-Param-*`),
 * SSE 응답 스트림(progress)·`resultType`·MRTR 정책(11.4), `server/discover`, `subscriptions/listen`.
 */
import { DEFAULTS, LIMITS, MODERN_MIN_PROTOCOL_VERSION, normalizeToolDefinition, truncate, type ToolDefinition } from '@omnicode/shared';
import {
  DEFAULT_FORWARD_LOG_LEVEL,
  UpstreamError,
  isLoggingLevel,
  logLevelAtLeast,
  type CallContext,
  type CallToolParams,
  type FetchLike,
  type LogMessageNotification,
  type Logger,
  type LoggingLevel,
  type ProbeResult,
  type ProgressNotification,
  type UpstreamConnector,
  type UpstreamConnectorOptions,
  type UpstreamTimeouts,
} from '../contracts.js';
import {
  HUB_CLIENT_INFO,
  USER_AGENT,
  abortErrorFrom,
  createRequestClock,
  describeError,
  encodeMcpName,
  insufficientScopeError,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isRecord,
  jsonRpcErrorOf,
  protocolError,
  sleep,
  unauthorizedError,
  unavailableError,
  type JsonRpcErrorObject,
  type JsonRpcNotificationMessage,
  type JsonRpcResponseMessage,
  type RequestClock,
} from './common.js';
import { readBodyLimited, readSseStream } from './sse.js';

export const MODERN_PROTOCOL_VERSION: string = MODERN_MIN_PROTOCOL_VERSION;
export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
/** 2026-07-28: 서버는 이 값이 있는 요청에만 notifications/message 를 보낸다 (D1) */
export const META_LOG_LEVEL = 'io.modelcontextprotocol/logLevel';
/**
 * 목록 변경 스트림의 `subscriptions/listen` 필터 (11.2). 스펙 2026-07-28 basic/patterns/subscriptions:
 * params.notifications = { toolsListChanged, promptsListChanged, resourcesListChanged, resourceSubscriptions[] }
 */
export const LISTEN_NOTIFICATIONS = { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true } as const;
/** @deprecated 예전 추정 형식의 이름. LISTEN_NOTIFICATIONS 를 쓴다 */
export const LISTEN_SUBSCRIPTIONS = Object.keys(LISTEN_NOTIFICATIONS) as Array<keyof typeof LISTEN_NOTIFICATIONS>;
/** 11.4: inputRequests 없는 input_required의 자동 재시도 상한 */
export const MAX_INPUT_REQUIRED_RETRIES = 3;
const MAX_LIST_PAGES = 100;
const ERROR_BODY_LIMIT = 64 * 1024;

/** `Mcp-Name` 헤더를 요구하는 메서드와 그 값이 들어 있는 파라미터 */
const NAME_HEADER_PARAM: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'resources/read': 'uri',
  'prompts/get': 'name',
};

const LIST_CHANGED_METHODS: Record<string, 'tools' | 'prompts' | 'resources'> = {
  'notifications/tools/list_changed': 'tools',
  'notifications/prompts/list_changed': 'prompts',
  'notifications/resources/list_changed': 'resources',
};

/** 결과 크기 제한이 조회 제한(4 MiB)인 메서드. 나머지는 호출 제한(32 MiB). */
const LIST_LIKE_METHODS = new Set(['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list', 'server/discover']);

// ---------------------------------------------------------------------------
// 요청 1개 = POST 1개
// ---------------------------------------------------------------------------
export interface ModernPostOptions {
  fetch: FetchLike;
  url: string;
  headers: () => Promise<Record<string, string>>;
  protocolVersion: string;
  id: number;
  method: string;
  params?: Record<string, unknown> | undefined;
  clientCapabilities: Record<string, unknown>;
  mcpParamHeaders?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  /** 응답 본문 최대 바이트 (Infinity면 제한 없음) */
  maxBytes: number;
  /** SSE 응답 스트림의 알림 (progress · message · list_changed) */
  onNotification?: ((n: JsonRpcNotificationMessage) => void) | undefined;
  /** 있으면 _meta.logLevel 로 이 요청의 로그를 요청한다 (D1) */
  logLevel?: LoggingLevel | undefined;
}

export type ModernPostOutcome =
  | { kind: 'result'; result: Record<string, unknown>; status: number }
  | { kind: 'rpc_error'; error: JsonRpcErrorObject; status: number }
  | { kind: 'http_error'; status: number; wwwAuthenticate: string | null; bodyText: string; rpcError?: JsonRpcErrorObject };

export function buildModernHeaders(o: {
  protocolVersion: string;
  method: string;
  params?: Record<string, unknown> | undefined;
  mcpParamHeaders?: Record<string, string> | undefined;
  auth: Record<string, string>;
}): Headers {
  const h = new Headers();
  h.set('content-type', 'application/json');
  h.set('accept', 'application/json, text/event-stream');
  h.set('mcp-protocol-version', o.protocolVersion);
  h.set('mcp-method', o.method);
  const nameParam = NAME_HEADER_PARAM[o.method];
  if (nameParam) {
    const v = o.params?.[nameParam];
    if (typeof v === 'string') h.set('mcp-name', encodeMcpName(v));
  }
  for (const [k, v] of Object.entries(o.mcpParamHeaders ?? {})) {
    if (/^mcp-param-/i.test(k)) h.set(k, v);
  }
  for (const [k, v] of Object.entries(o.auth)) h.set(k, v);
  if (!h.has('user-agent')) h.set('user-agent', USER_AGENT);
  return h;
}

export function buildModernBody(o: {
  id: number;
  method: string;
  params?: Record<string, unknown> | undefined;
  protocolVersion: string;
  clientCapabilities: Record<string, unknown>;
  /** 있으면 _meta 에 logLevel 을 넣어 이 요청의 로그를 받는다 (D1) */
  logLevel?: LoggingLevel | undefined;
}): Record<string, unknown> {
  const params = o.params ?? {};
  const meta = isRecord(params._meta) ? params._meta : {};
  return {
    jsonrpc: '2.0',
    id: o.id,
    method: o.method,
    params: {
      ...params,
      _meta: {
        ...meta,
        [META_PROTOCOL_VERSION]: o.protocolVersion,
        [META_CLIENT_INFO]: { ...HUB_CLIENT_INFO },
        [META_CLIENT_CAPABILITIES]: o.clientCapabilities,
        ...(o.logLevel ? { [META_LOG_LEVEL]: o.logLevel } : {}),
      },
    },
  };
}

function mediaTypeOf(header: string | null): string {
  return (header ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function outcomeFromResponse(msg: unknown, status: number): ModernPostOutcome {
  if (!isJsonRpcResponse(msg)) {
    throw protocolError({ code: -32603, message: 'upstream sent a malformed JSON-RPC response' }, status);
  }
  if (msg.error) return { kind: 'rpc_error', error: msg.error, status };
  if (!isRecord(msg.result)) {
    throw protocolError({ code: -32603, message: 'upstream result is not an object' }, status);
  }
  return { kind: 'result', result: msg.result, status };
}

/** 2026-07-28 요청 하나를 보내고 응답(JSON 또는 SSE)을 끝까지 읽는다. 네트워크·취소 오류는 그대로 던진다. */
export async function modernPost(o: ModernPostOptions): Promise<ModernPostOutcome> {
  const headers = buildModernHeaders({
    protocolVersion: o.protocolVersion,
    method: o.method,
    params: o.params,
    mcpParamHeaders: o.mcpParamHeaders,
    auth: await o.headers(),
  });
  const body = JSON.stringify(
    buildModernBody({
      id: o.id,
      method: o.method,
      params: o.params,
      protocolVersion: o.protocolVersion,
      clientCapabilities: o.clientCapabilities,
      logLevel: o.logLevel,
    }),
  );
  const res = await o.fetch(o.url, { method: 'POST', headers, body, signal: o.signal });

  if (!res.ok) {
    const text = await readBodyLimited(res, ERROR_BODY_LIMIT).catch(() => '');
    let rpcError: JsonRpcErrorObject | undefined;
    try {
      rpcError = jsonRpcErrorOf(JSON.parse(text));
    } catch {
      rpcError = undefined;
    }
    return {
      kind: 'http_error',
      status: res.status,
      wwwAuthenticate: res.headers.get('www-authenticate'),
      bodyText: text,
      ...(rpcError ? { rpcError } : {}),
    };
  }

  const mediaType = mediaTypeOf(res.headers.get('content-type'));
  if (mediaType === 'application/json') {
    const text = await readBodyLimited(res, o.maxBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw protocolError({ code: -32700, message: 'upstream sent invalid JSON' }, res.status);
    }
    const msg = Array.isArray(parsed) ? parsed.find(isJsonRpcResponse) : parsed;
    return outcomeFromResponse(msg, res.status);
  }

  if (mediaType === 'text/event-stream') {
    let final: JsonRpcResponseMessage | undefined;
    await readSseStream(res.body, {
      maxBytes: o.maxBytes,
      onEvent: (ev) => {
        if (!ev.data || (ev.event && ev.event !== 'message')) return;
        let msg: unknown;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (isJsonRpcNotification(msg)) {
          o.onNotification?.(msg);
          return;
        }
        if (isJsonRpcResponse(msg)) {
          final = msg;
          return 'stop';
        }
      },
    });
    if (!final) throw unavailableError('upstream closed the stream before responding', res.status);
    return outcomeFromResponse(final, res.status);
  }

  await res.body?.cancel().catch(() => undefined);
  throw protocolError({ code: -32603, message: `unexpected upstream content type: ${mediaType || '(none)'}` }, res.status);
}

// ---------------------------------------------------------------------------
// server/discover 결과
// ---------------------------------------------------------------------------
export interface DiscoverInfo {
  protocolVersion: string;
  /** 서버가 광고한 버전 목록 (없으면 빈 배열) */
  protocolVersions: string[];
  serverInfo: Record<string, unknown> | null;
  capabilities: Record<string, unknown> | null;
  instructions?: string;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function parseDiscoverResult(result: Record<string, unknown>, protocolVersion: string): DiscoverInfo {
  const versions = stringArray(result.protocolVersions ?? result.supportedVersions ?? result.supportedProtocolVersions ?? result.versions);
  const info: DiscoverInfo = {
    protocolVersion,
    protocolVersions: versions,
    serverInfo: isRecord(result.serverInfo) ? result.serverInfo : null,
    capabilities: isRecord(result.capabilities) ? result.capabilities : null,
  };
  if (typeof result.instructions === 'string') info.instructions = result.instructions;
  return info;
}

// ---------------------------------------------------------------------------
// 커넥터
// ---------------------------------------------------------------------------
export interface ModernInternalOptions {
  /** 테스트용 크기 제한 덮어쓰기 */
  limits?: { callResultBytes?: number; toolsListBytes?: number };
  /** listen 재연결 백오프 (기본 1s → 30s) */
  listenBackoff?: { initialMs: number; maxMs: number };
  /** probe가 이미 받은 discover 결과 — connect()에서 다시 묻지 않는다 */
  discovered?: DiscoverInfo;
}

interface RpcOptions {
  clock?: RequestClock;
  signal?: AbortSignal | undefined;
  idleMs?: number;
  totalMs?: number;
  maxBytes: number;
  clientCapabilities: Record<string, unknown>;
  mcpParamHeaders?: Record<string, string> | undefined;
  /** 다운스트림이 progressToken을 보냈을 때만 전달 */
  onProgress?: ((n: ProgressNotification) => void) | undefined;
  /** 이 요청의 로그 (D1). 있으면 _meta.logLevel 을 보낸다 */
  onMessage?: ((n: LogMessageNotification) => void) | undefined;
  logLevel?: LoggingLevel | undefined;
}

type ListKind = 'tools' | 'prompts' | 'resources';

export class ModernConnector implements UpstreamConnector {
  readonly era = 'modern' as const;
  readonly transport = 'streamable_http' as const;
  readonly serverId: string;
  protocolVersion: string;
  serverInfo: Record<string, unknown> | null = null;
  /** 마지막 tools/list 의 ttlMs (페이지 중 가장 짧은 값). 17.3 상태 점검 간격에 쓴다 */
  lastToolsTtlMs: number | null = null;
  capabilities: Record<string, unknown> | null = null;
  /** discover가 알려 준 버전 목록 */
  supportedVersions: string[] = [];

  private readonly opts: UpstreamConnectorOptions;
  private readonly timeouts: UpstreamTimeouts;
  private readonly limits: { callResultBytes: number; toolsListBytes: number };
  private readonly backoff: { initialMs: number; maxMs: number };
  private readonly log: Logger | undefined;
  private discovered: DiscoverInfo | undefined;
  private instructions: string | undefined;
  private nextId = 1;
  private nextProgressToken = 1;
  private closed = false;
  private connected = false;
  private connecting: Promise<ProbeResult> | undefined;
  private readonly listChangedCbs = new Set<(kind: ListKind) => void>();
  private readonly closeCbs = new Set<(reason?: string) => void>();
  private listen: { ac: AbortController; done: Promise<void> } | undefined;
  /** 리소스 구독 스트림 (C3). 구독 URI 집합이 바뀌면 새 필터로 다시 연다 (필터는 스트림을 열 때 정해진다) */
  private resourceListen: { ac: AbortController; done: Promise<void> } | undefined;
  private readonly resourceUris = new Set<string>();
  private readonly resourceUpdatedCbs = new Set<(uri: string) => void>();

  constructor(opts: UpstreamConnectorOptions, internal: ModernInternalOptions = {}) {
    this.opts = opts;
    this.serverId = opts.serverId;
    this.log = opts.logger;
    this.timeouts = {
      connectMs: opts.timeouts?.connectMs ?? DEFAULTS.connectTimeoutMs,
      initializeMs: opts.timeouts?.initializeMs ?? DEFAULTS.initializeTimeoutMs,
      listMs: opts.timeouts?.listMs ?? DEFAULTS.listTimeoutMs,
    };
    this.limits = {
      callResultBytes: internal.limits?.callResultBytes ?? LIMITS.callResultBytes,
      toolsListBytes: internal.limits?.toolsListBytes ?? LIMITS.toolsListBytes,
    };
    this.backoff = internal.listenBackoff ?? { initialMs: 1_000, maxMs: 30_000 };
    this.discovered = internal.discovered;
    this.protocolVersion = internal.discovered?.protocolVersion ?? MODERN_PROTOCOL_VERSION;
  }

  // -- 연결 -----------------------------------------------------------------

  async connect(): Promise<ProbeResult> {
    this.assertOpen();
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        if (!this.discovered) {
          const result = await this.rpc('server/discover', {}, {
            totalMs: this.timeouts.initializeMs,
            maxBytes: this.limits.toolsListBytes,
            clientCapabilities: {},
          });
          this.discovered = parseDiscoverResult(result, this.protocolVersion);
        }
        this.applyDiscover(this.discovered);
        this.connected = true;
        this.startListen();
        return this.probeResult();
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  private applyDiscover(d: DiscoverInfo): void {
    this.protocolVersion = d.protocolVersion;
    this.supportedVersions = d.protocolVersions;
    this.serverInfo = d.serverInfo;
    this.capabilities = d.capabilities;
    this.instructions = d.instructions;
  }

  private probeResult(): ProbeResult {
    return {
      era: 'modern',
      protocolVersion: this.protocolVersion,
      transport: 'streamable_http',
      serverInfo: this.serverInfo,
      capabilities: this.capabilities,
      ...(this.instructions !== undefined ? { instructions: this.instructions } : {}),
    };
  }

  private async ensureConnected(): Promise<void> {
    this.assertOpen();
    if (!this.connected) await this.connect();
  }

  private assertOpen(): void {
    if (this.closed) throw unavailableError('upstream connector is closed');
  }

  // -- 공개 메서드 ------------------------------------------------------------

  async listTools(signal?: AbortSignal): Promise<ToolDefinition[]> {
    await this.ensureConnected();
    return this.retryOnce(['unavailable', 'timeout'], async () => {
      const clock = createRequestClock({ signal, totalMs: this.timeouts.listMs });
      try {
        const tools: ToolDefinition[] = [];
        let cursor: string | undefined;
        let pages = 0;
        let ttl: number | null = null;
        do {
          const result = await this.rpc('tools/list', cursor ? { cursor } : {}, {
            clock,
            maxBytes: this.limits.toolsListBytes,
            clientCapabilities: {},
          });
          if (typeof result.ttlMs === 'number' && Number.isFinite(result.ttlMs) && result.ttlMs >= 0) {
            ttl = ttl === null ? result.ttlMs : Math.min(ttl, result.ttlMs);
          }
          if (Array.isArray(result.tools)) {
            for (const t of result.tools) {
              if (isRecord(t) && typeof t.name === 'string') tools.push(normalizeToolDefinition(t));
            }
          }
          cursor = typeof result.nextCursor === 'string' && result.nextCursor !== '' ? result.nextCursor : undefined;
          if (++pages > MAX_LIST_PAGES) {
            throw protocolError({ code: -32603, message: `tools/list exceeded ${MAX_LIST_PAGES} pages` });
          }
        } while (cursor);
        this.lastToolsTtlMs = ttl;
        return tools;
      } finally {
        clock.dispose();
      }
    });
  }

  async callTool(params: CallToolParams, ctx: CallContext): Promise<Record<string, unknown>> {
    await this.ensureConnected();
    const callerToken = progressTokenOf(params._meta);
    // 다운스트림 토큰이 없어도 업스트림에는 토큰을 붙여 progress를 받는다 (유휴 타임아웃 리셋용). 전달은 하지 않는다.
    const meta = { ...(params._meta ?? {}), progressToken: callerToken ?? `omnicode-hub:${this.nextProgressToken++}` };
    const clock = this.clockFor(ctx);
    try {
      return await this.requestWithInputPolicy('tools/call', { ...params, _meta: meta }, ctx, {
        clock,
        maxBytes: this.limits.callResultBytes,
        clientCapabilities: capabilitiesFor(ctx),
        mcpParamHeaders: ctx.mcpParamHeaders,
        onProgress: callerToken !== undefined ? (n) => ctx.onProgress({ ...n, progressToken: callerToken }) : undefined,
        ...logOptions(ctx),
      });
    } finally {
      clock.dispose();
    }
  }

  async forward(method: string, params: Record<string, unknown> | undefined, ctx: CallContext): Promise<Record<string, unknown>> {
    await this.ensureConnected();
    const callerToken = progressTokenOf(isRecord(params?._meta) ? params._meta : undefined);
    const clock = this.clockFor(ctx);
    try {
      const rpcOpts: RpcOptions = {
        clock,
        maxBytes: LIST_LIKE_METHODS.has(method) ? this.limits.toolsListBytes : this.limits.callResultBytes,
        clientCapabilities: capabilitiesFor(ctx),
        mcpParamHeaders: ctx.mcpParamHeaders,
        onProgress: callerToken !== undefined ? (n) => ctx.onProgress({ ...n, progressToken: callerToken }) : undefined,
        ...logOptions(ctx),
      };
      // 조회성 요청: 연결 실패에 한해 1회 재시도 (11.7)
      return await this.retryOnce(['unavailable'], () => this.requestWithInputPolicy(method, params ?? {}, ctx, rpcOpts));
    } finally {
      clock.dispose();
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
    this.connected = false;
    const listen = this.listen;
    this.listen = undefined;
    if (listen) {
      listen.ac.abort();
      await listen.done;
    }
    await this.stopResourceListen();
    for (const cb of this.closeCbs) {
      try {
        cb('closed');
      } catch (e) {
        this.log?.warn({ serverId: this.serverId, err: describeError(e) }, 'onClose callback threw');
      }
    }
  }

  // -- 11.4 MRTR 정책 ----------------------------------------------------------

  private async requestWithInputPolicy(
    method: string,
    params: Record<string, unknown>,
    ctx: CallContext,
    rpcOpts: RpcOptions,
  ): Promise<Record<string, unknown>> {
    let current = params;
    let result = await this.rpc(method, current, rpcOpts);
    for (let retries = 0; ; retries++) {
      if (result.resultType !== 'input_required') return result;
      // modern 다운스트림: 통과. inputResponses·requestState 재시도도 평범한 params로 들어와 그대로 전달된다.
      if (ctx.downstreamEra === 'modern') return result;
      const inputRequests = result.inputRequests;
      if (Array.isArray(inputRequests) && inputRequests.length > 0) {
        throw new UpstreamError('input_required', 'upstream requires additional input (MRTR) that this downstream cannot answer');
      }
      if (retries >= MAX_INPUT_REQUIRED_RETRIES) {
        throw new UpstreamError('input_required', `upstream still requires input after ${MAX_INPUT_REQUIRED_RETRIES} automatic retries`);
      }
      current = result.requestState !== undefined ? { ...current, requestState: result.requestState } : current;
      result = await this.rpc(method, current, rpcOpts);
    }
  }

  // -- 요청 파이프라인 -----------------------------------------------------------

  private clockFor(ctx: CallContext): RequestClock {
    return createRequestClock({
      signal: ctx.signal,
      idleMs: ctx.idleTimeoutMs > 0 ? ctx.idleTimeoutMs : DEFAULTS.idleTimeoutMs,
      totalMs: ctx.timeoutMs > 0 ? ctx.timeoutMs : DEFAULTS.callTimeoutMs,
    });
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

  /** JSON-RPC 요청 1개. 401은 onUnauthorized 뒤 정확히 1회 재시도. 그 밖의 재시도는 하지 않는다. */
  private async rpc(method: string, params: Record<string, unknown> | undefined, o: RpcOptions): Promise<Record<string, unknown>> {
    this.assertOpen();
    const ownClock = o.clock === undefined;
    const clock = o.clock ?? createRequestClock({ signal: o.signal, idleMs: o.idleMs, totalMs: o.totalMs });
    let authRetried = false;
    try {
      for (;;) {
        if (clock.signal.aborted) throw this.mapFailure(abortErrorFrom(clock.signal), clock, method);
        let outcome: ModernPostOutcome;
        try {
          outcome = await modernPost({
            fetch: this.opts.fetch,
            url: this.opts.url,
            headers: this.opts.headers,
            protocolVersion: this.protocolVersion,
            id: this.nextId++,
            method,
            params,
            clientCapabilities: o.clientCapabilities,
            mcpParamHeaders: o.mcpParamHeaders,
            logLevel: o.onMessage ? o.logLevel : undefined,
            signal: clock.signal,
            maxBytes: o.maxBytes,
            onNotification: (n) => this.onStreamNotification(n, o, clock),
          });
        } catch (e) {
          throw this.mapFailure(e, clock, method);
        }
        switch (outcome.kind) {
          case 'result':
            return outcome.result;
          case 'rpc_error':
            throw protocolError(outcome.error, outcome.status);
          case 'http_error': {
            if (outcome.status === 401) {
              if (!authRetried && this.opts.onUnauthorized) {
                authRetried = true;
                const decision = await this.opts.onUnauthorized(outcome.wwwAuthenticate ?? undefined);
                if (decision === 'retry') continue;
              }
              throw unauthorizedError(outcome.wwwAuthenticate);
            }
            if (outcome.status === 403) {
              const scoped = insufficientScopeError(outcome.wwwAuthenticate);
              if (scoped) throw scoped;
            }
            if (outcome.rpcError) throw protocolError(outcome.rpcError, outcome.status);
            throw unavailableError(
              `upstream HTTP ${outcome.status}${outcome.bodyText ? `: ${truncate(outcome.bodyText, 200)}` : ''}`,
              outcome.status,
            );
          }
        }
      }
    } finally {
      if (ownClock) clock.dispose();
    }
  }

  private onStreamNotification(n: JsonRpcNotificationMessage, o: RpcOptions, clock: RequestClock): void {
    if (n.method === 'notifications/progress') {
      clock.touch();
      const p = n.params;
      if (o.onProgress && isRecord(p) && typeof p.progress === 'number' && (typeof p.progressToken === 'string' || typeof p.progressToken === 'number')) {
        o.onProgress({
          progressToken: p.progressToken,
          progress: p.progress,
          ...(typeof p.total === 'number' ? { total: p.total } : {}),
          ...(typeof p.message === 'string' ? { message: p.message } : {}),
        });
      }
      return;
    }
    if (n.method === 'notifications/message') {
      const p = n.params;
      if (!o.onMessage || !isRecord(p) || !isLoggingLevel(p.level)) return;
      if (!logLevelAtLeast(p.level, o.logLevel ?? DEFAULT_FORWARD_LOG_LEVEL)) return;
      o.onMessage({ level: p.level, ...(typeof p.logger === 'string' ? { logger: p.logger } : {}), data: p.data });
      return;
    }
    const kind = LIST_CHANGED_METHODS[n.method];
    if (kind) this.emitListChanged(kind);
  }

  private mapFailure(e: unknown, clock: RequestClock, method: string): Error {
    if (clock.timedOut) return timeoutErrorFor(method, clock.timedOut);
    if (clock.cancelled) return abortErrorFrom(clock.signal);
    if (e instanceof UpstreamError) return e;
    return unavailableError(`upstream ${method} failed: ${describeError(e)}`);
  }

  // -- subscriptions/listen -----------------------------------------------------

  private emitListChanged(kind: ListKind): void {
    for (const cb of this.listChangedCbs) {
      try {
        cb(kind);
      } catch (e) {
        this.log?.warn({ serverId: this.serverId, err: describeError(e) }, 'onListChanged callback threw');
      }
    }
  }

  private startListen(): void {
    if (this.listen || this.closed) return;
    const ac = new AbortController();
    this.listen = {
      ac,
      done: this.listenLoop(ac.signal, { notifications: { ...LISTEN_NOTIFICATIONS } }, (n) => {
        const kind = LIST_CHANGED_METHODS[n.method];
        if (kind) this.emitListChanged(kind);
      }).catch(() => undefined),
    };
  }

  // -- 리소스 구독 (C3) ------------------------------------------------------------

  async subscribeResource(uri: string): Promise<void> {
    await this.ensureConnected();
    if (this.resourceUris.has(uri)) return;
    this.resourceUris.add(uri);
    await this.restartResourceListen();
  }

  async unsubscribeResource(uri: string): Promise<void> {
    if (!this.resourceUris.delete(uri)) return;
    await this.restartResourceListen();
  }

  onResourceUpdated(cb: (uri: string) => void): () => void {
    this.resourceUpdatedCbs.add(cb);
    return () => {
      this.resourceUpdatedCbs.delete(cb);
    };
  }

  private async stopResourceListen(): Promise<void> {
    const r = this.resourceListen;
    this.resourceListen = undefined;
    if (r) {
      r.ac.abort();
      await r.done;
    }
  }

  private async restartResourceListen(): Promise<void> {
    await this.stopResourceListen();
    if (this.closed || this.resourceUris.size === 0) return;
    const uris = [...this.resourceUris];
    const ac = new AbortController();
    this.resourceListen = {
      ac,
      done: this.listenLoop(ac.signal, { notifications: { resourceSubscriptions: uris } }, (n) => {
        if (n.method !== 'notifications/resources/updated' || !isRecord(n.params) || typeof n.params.uri !== 'string') return;
        const uri = n.params.uri;
        if (!this.resourceUris.has(uri)) return;
        for (const cb of this.resourceUpdatedCbs) {
          try {
            cb(uri);
          } catch (e) {
            this.log?.warn({ serverId: this.serverId, err: describeError(e) }, 'onResourceUpdated callback threw');
          }
        }
      }).catch(() => undefined),
    };
  }

  private async listenLoop(signal: AbortSignal, params: Record<string, unknown>, onEvent: (n: JsonRpcNotificationMessage) => void): Promise<void> {
    let delay = this.backoff.initialMs;
    let authRetried = false;
    while (!signal.aborted && !this.closed) {
      let gotEvent = false;
      let giveUp: string | undefined;
      try {
        const outcome = await modernPost({
          fetch: this.opts.fetch,
          url: this.opts.url,
          headers: this.opts.headers,
          protocolVersion: this.protocolVersion,
          id: this.nextId++,
          method: 'subscriptions/listen',
          params,
          clientCapabilities: {},
          signal,
          maxBytes: Number.POSITIVE_INFINITY,
          onNotification: (n) => {
            gotEvent = true;
            if (n.method === 'notifications/subscriptions/acknowledged') {
              // 서버가 받아들인 필터. 요청한 종류가 빠졌으면 그 종류는 오지 않는다 (스펙 SHOULD 확인)
              this.log?.debug({ serverId: this.serverId, acknowledged: isRecord(n.params) ? n.params.notifications : undefined }, 'upstream listen acknowledged');
              return;
            }
            onEvent(n);
          },
        });
        if (outcome.kind === 'http_error') {
          if (outcome.status === 401) {
            if (!authRetried && this.opts.onUnauthorized) {
              authRetried = true;
              if ((await this.opts.onUnauthorized(outcome.wwwAuthenticate ?? undefined)) === 'retry') continue;
            }
            giveUp = 'upstream listen stream unauthorized';
          } else if (outcome.status >= 400 && outcome.status < 500 && outcome.status !== 408 && outcome.status !== 429) {
            giveUp = `upstream does not accept subscriptions/listen (HTTP ${outcome.status})`;
          }
        } else if (outcome.kind === 'rpc_error') {
          if (outcome.error.code === -32601 || outcome.error.code === -32602) {
            giveUp = `upstream does not support subscriptions/listen (${outcome.error.code})`;
          }
        } else {
          authRetried = false;
        }
      } catch (e) {
        if (signal.aborted || this.closed) return;
        this.log?.debug({ serverId: this.serverId, err: describeError(e) }, 'upstream listen stream failed');
      }
      if (giveUp) {
        this.log?.warn({ serverId: this.serverId }, giveUp);
        return;
      }
      if (gotEvent) delay = this.backoff.initialMs;
      try {
        await sleep(delay, signal);
      } catch {
        return;
      }
      delay = Math.min(delay * 2, this.backoff.maxMs);
    }
  }
}

function timeoutErrorFor(method: string, kind: 'idle' | 'total'): UpstreamError {
  return new UpstreamError('timeout', `upstream ${method} ${kind === 'idle' ? 'went idle' : 'exceeded the total timeout'}`);
}

function progressTokenOf(meta: Record<string, unknown> | undefined): string | number | undefined {
  const t = meta?.progressToken;
  return typeof t === 'string' || typeof t === 'number' ? t : undefined;
}

/** 11.4: legacy 다운스트림이면 clientCapabilities를 비워 보낸다. modern이면 그대로. */
/** 다운스트림이 로그를 받을 때만 업스트림에 logLevel 을 요청한다 (2026-07-28 은 요청한 요청에만 로그를 보낸다) */
function logOptions(ctx: CallContext): Pick<RpcOptions, 'onMessage' | 'logLevel'> {
  if (!ctx.onMessage) return {};
  return { onMessage: ctx.onMessage, logLevel: ctx.logLevel ?? DEFAULT_FORWARD_LOG_LEVEL };
}

function capabilitiesFor(ctx: CallContext): Record<string, unknown> {
  return ctx.downstreamEra === 'modern' ? (ctx.clientCapabilities ?? {}) : {};
}
