/**
 * Hub 내부 모듈 계약 (설계문서 8.4 패키지 구조).
 * 모듈들은 이 파일의 인터페이스로만 서로를 본다. 구현은 각 디렉터리에 있다.
 */
import type { Logger } from 'pino';
import type {
  Agent,
  AgentdStatus,
  ApproveBody,
  ApproveResult,
  AuditEntry,
  AuditPage,
  AuditQuery,
  BindingRecord,
  CreateServerBody,
  DeleteResult,
  DesiredAgentConfig,
  EventPage,
  EventRecord,
  HubStatus,
  OAuthClientMode,
  OAuthStartResult,
  PatchServerBody,
  Preset,
  ProtocolEra,
  ServerDetail,
  ServerRecord,
  ServerStatus,
  ServerSummary,
  SyncOutcome,
  SyncResult,
  TestResult,
  ToolDefinition,
  ToolRecord,
  Masker,
} from '@omnicode/shared';

export type { Logger };

// ---------------------------------------------------------------------------
// 설정 (8.5)
// ---------------------------------------------------------------------------
export interface HubConfig {
  publicUrl: string | null;            // OMNICODE_PUBLIC_URL (없으면 CIMD 비활성)
  hubHost: '127.0.0.1';
  hubPort: number;                     // OMNICODE_HUB_PORT
  dataDir: string;                     // OMNICODE_DATA_DIR
  agentdSocket: string;                // OMNICODE_AGENTD_SOCKET
  secretsPrefix: string;               // OMNICODE_SECRETS_PREFIX
  secretsBackend: 'aws' | 'file' | 'memory';
  fileSecretsDir?: string;             // secretsBackend=file 일 때
  callTimeoutMs: number;
  idleTimeoutMs: number;
  allowPrivateHosts: string[];         // 호스트 이름 또는 CIDR
  allowHttpLoopback: boolean;
  auditRetentionDays: number;
  eventRetentionDays: number;
  agentTokenGraceMs: number;
  healthIntervalMs: number;
  /** 업스트림 notifications/message 를 다운스트림 요청 스트림으로 전달할지 (D1, 11.3). 기본 true */
  forwardLogMessages: boolean;
  /**
   * OAuth 클라이언트 등록에 CIMD 를 쓸지 (10.3). 기본 true.
   * 인가 서버가 publicUrl 의 CIMD 문서를 가져갈 수 없는 배포(Tailscale 전용 ts.net 등)는 false 로 두면 DCR·직접 입력으로 넘어간다.
   */
  cimdEnabled: boolean;
  presetsDir: string;
  version: string;
}

// ---------------------------------------------------------------------------
// net/guardedFetch (16.2)
// ---------------------------------------------------------------------------
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface SsrfDecision {
  ok: boolean;
  host: string;
  addresses: string[];
  reason?: string;
}

export interface GuardedFetchOptions {
  allowPrivateHosts?: string[];
  allowHttpLoopback?: boolean;
  maxRedirects?: number;               // 기본 5
  maxResponseBytes?: number;           // 기본 LIMITS.callResultBytes
  connectTimeoutMs?: number;           // 기본 10초
  /** 테스트용 DNS 주입. 기본은 node:dns promises.lookup(all: true) */
  lookup?: (hostname: string) => Promise<string[]>;
  logger?: Logger;
}

export interface GuardedFetch {
  /** 리다이렉트를 수동으로 따라가며(최대 N단계) 매 단계 SSRF 검사를 적용한 fetch */
  fetch: FetchLike;
  /** URL 하나를 검사만 한다 (추가 마법사의 사전 검증용) */
  check(url: string | URL): Promise<SsrfDecision>;
}

export class SsrfBlockedError extends Error {
  constructor(
    readonly host: string,
    readonly reason: string,
    readonly resolved: string[] = [],
  ) {
    super(`SSRF blocked: ${host} (${reason})`);
    this.name = 'SsrfBlockedError';
  }
}

// ---------------------------------------------------------------------------
// registry (13장)
// ---------------------------------------------------------------------------
export type NewServer = Omit<ServerRecord, 'created_at' | 'updated_at'> & { created_at?: string; updated_at?: string };

export interface ServerRepo {
  get(id: string): ServerRecord | undefined;
  list(): ServerRecord[];
  insert(rec: NewServer): ServerRecord;
  update(id: string, patch: Partial<Omit<ServerRecord, 'id' | 'created_at'>>): ServerRecord;
  /** 상태 전이. 허용되지 않으면 InvalidTransitionError */
  setStatus(id: string, status: ServerStatus, opts?: { lastError?: string | null }): ServerRecord;
  delete(id: string): void;
}

export interface ToolUpsertDiff {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: string[];
}

export interface ToolRepo {
  listByServer(serverId: string): ToolRecord[];
  get(serverId: string, name: string): ToolRecord | undefined;
  /** 업스트림 tools/list 결과를 반영한다. 승인 해시는 건드리지 않는다 (16.5) */
  upsertFromUpstream(serverId: string, defs: ToolDefinition[], now?: string): ToolUpsertDiff;
  /** 승인. 요청 해시가 현재 해시와 다르면 StaleToolHashError */
  approve(serverId: string, approvals: Array<{ name: string; schemaHash: string; enabled?: boolean }>, now?: string): void;
  setEnabled(serverId: string, name: string, enabled: boolean): void;
}

export interface BindingRepo {
  get(serverId: string, agent: Agent): BindingRecord | undefined;
  listByServer(serverId: string): BindingRecord[];
  listByAgent(agent: Agent): BindingRecord[];
  upsert(serverId: string, agent: Agent, enabled: boolean): void;
  setSync(serverId: string, agent: Agent, status: 'synced' | 'pending' | 'failed', error?: string | null, at?: string): void;
}

export interface OAuthStateRecord {
  state: string;
  server_id: string;
  code_verifier: string;
  issuer: string;
  client_id: string;
  scope: string | null;
  omnicode_session_id: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export interface OAuthStateRepo {
  create(rec: OAuthStateRecord): void;
  /** 유효하면 used_at을 찍고 반환, 없거나 만료·사용됨이면 undefined (1회용) */
  consume(state: string, now?: string): OAuthStateRecord | undefined;
  purgeExpired(now?: string): number;
}

export interface AgentTokenRecord {
  agent: Agent;
  token_sha256: string;
  prev_sha256: string | null;
  prev_valid_until: string | null;
  rotated_at: string;
}

export interface AgentTokenRepo {
  get(agent: Agent): AgentTokenRecord | undefined;
  all(): AgentTokenRecord[];
  set(agent: Agent, tokenSha256: string, prev?: { sha256: string; validUntil: string } | null, rotatedAt?: string): void;
}

export interface EventRepo {
  add(e: { kind: EventRecord['kind']; server_id?: string | null; agent?: Agent | null; actor: EventRecord['actor']; details?: unknown; ts?: string }): void;
  list(q: { serverId?: string; agent?: Agent; since?: string; cursor?: number; limit?: number }): EventPage;
  purgeOlderThan(iso: string): number;
}

export interface AuditRepo {
  add(e: Omit<AuditEntry, 'id'>): void;
  list(q: AuditQuery): AuditPage;
  purgeOlderThan(iso: string): number;
}

export interface Registry {
  servers: ServerRepo;
  tools: ToolRepo;
  bindings: BindingRepo;
  oauthStates: OAuthStateRepo;
  agentTokens: AgentTokenRepo;
  events: EventRepo;
  audit: AuditRepo;
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** 9.2 전이표. 삭제는 어디서나 가능. */
export const TRANSITIONS: Record<ServerStatus, readonly ServerStatus[]> = {
  draft: ['needs_auth', 'pending_approval', 'error', 'deleting'],
  needs_auth: ['pending_approval', 'active', 'error', 'deleting'],
  pending_approval: ['active', 'needs_auth', 'error', 'deleting'],
  active: ['changed', 'needs_auth', 'error', 'disabled', 'deleting'],
  changed: ['active', 'needs_auth', 'error', 'disabled', 'deleting'],
  error: ['active', 'changed', 'needs_auth', 'disabled', 'deleting'],
  disabled: ['active', 'changed', 'needs_auth', 'deleting'],
  deleting: [],
};

export function canTransition(from: ServerStatus, to: ServerStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly serverId: string,
    readonly from: ServerStatus,
    readonly to: ServerStatus,
  ) {
    super(`invalid transition ${from} -> ${to} (${serverId})`);
    this.name = 'InvalidTransitionError';
  }
}

export class StaleToolHashError extends Error {
  constructor(
    readonly serverId: string,
    readonly tools: ToolRecord[],
  ) {
    super(`tool definitions changed since they were shown (${serverId})`);
    this.name = 'StaleToolHashError';
  }
}

export class NotFoundError extends Error {
  constructor(readonly what: string) {
    super(`not found: ${what}`);
    this.name = 'NotFoundError';
  }
}

// ---------------------------------------------------------------------------
// secrets (10.6)
// ---------------------------------------------------------------------------
export interface HeaderSecret {
  type: 'header';
  header_name: string;
  value: string;
}
export interface OAuthSecret {
  type: 'oauth';
  issuer: string;
  client_mode: OAuthClientMode;
  client_id: string;
  client_secret: string | null;
  token_endpoint_auth_method: string;
  registration_access_token: string | null;
  registration_client_uri: string | null;
  resource: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  scope: string | null;
  obtained_at: string | null;
}
export interface StdioEnvSecret {
  type: 'stdio_env';
  env: Record<string, string>;
}
export interface HubTokensSecret {
  claude: string;
  codex: string;
  gemini: string;
  rotated_at: Partial<Record<Agent, string>>;
}
export type SecretValue = HeaderSecret | OAuthSecret | StdioEnvSecret | HubTokensSecret;

export interface SecretStore {
  get<T extends SecretValue = SecretValue>(ref: string): Promise<T | undefined>;
  put(ref: string, value: SecretValue): Promise<void>;
  /** 복구 유예 없이 즉시 삭제 (D13). 없으면 조용히 성공 */
  delete(ref: string): Promise<void>;
}

/** Secrets Manager 참조 이름 규칙 */
export function secretRefFor(prefix: string, serverId: string): string {
  return `${prefix}/mcp/${serverId}`;
}
export function hubTokensRef(prefix: string): string {
  return `${prefix}/hub-tokens`;
}

// ---------------------------------------------------------------------------
// upstream (11장)
// ---------------------------------------------------------------------------
export interface ProgressNotification {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
}

/** MCP 로그 수준 (RFC 5424 순서). 2026-07-28 에서 Logging 은 Deprecated 지만 legacy 서버는 계속 보낸다 */
export type LoggingLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';
export const LOGGING_LEVELS: readonly LoggingLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
/** 다운스트림이 수준을 정하지 않았을 때 전달하는 최소 수준 */
export const DEFAULT_FORWARD_LOG_LEVEL: LoggingLevel = 'info';

export function isLoggingLevel(x: unknown): x is LoggingLevel {
  return typeof x === 'string' && (LOGGING_LEVELS as readonly string[]).includes(x);
}
/** level 이 min 이상인가 */
export function logLevelAtLeast(level: LoggingLevel, min: LoggingLevel): boolean {
  return LOGGING_LEVELS.indexOf(level) >= LOGGING_LEVELS.indexOf(min);
}

/** 업스트림이 요청 스트림에 보낸 notifications/message 의 params */
export interface LogMessageNotification {
  level: LoggingLevel;
  logger?: string;
  data: unknown;
}

export interface CallContext {
  agent: Agent;
  jobId?: string;
  signal: AbortSignal;
  downstreamEra: ProtocolEra;
  clientCapabilities?: Record<string, unknown>;
  /** 다운스트림이 보낸 Mcp-Param-* 헤더 (그대로 전달) */
  mcpParamHeaders: Record<string, string>;
  onProgress: (n: ProgressNotification) => void;
  timeoutMs: number;
  idleTimeoutMs: number;
  /** 다운스트림이 logging/setLevel 로 요청한 최소 수준. 없으면 DEFAULT_FORWARD_LOG_LEVEL (D1) */
  logLevel?: LoggingLevel;
  /**
   * 업스트림이 이 요청에 딸려 보낸 notifications/message (D1). 없으면 전달하지 않는다.
   * 커넥터는 수준(logLevel) 필터를 적용한 뒤 부른다. 요청과 묶을 수 없는 메시지(세션 스트림)는 버린다.
   */
  onMessage?: (n: LogMessageNotification) => void;
}

export interface ProbeResult {
  era: ProtocolEra;
  protocolVersion: string;
  transport: 'streamable_http' | 'sse';
  serverInfo: Record<string, unknown> | null;
  capabilities: Record<string, unknown> | null;
  instructions?: string;
}

export type UpstreamErrorKind =
  | 'unauthorized'        // 401 → wwwAuthenticate
  | 'insufficient_scope'  // 403 insufficient_scope → scope
  | 'timeout'
  | 'unavailable'         // 연결 실패, 5xx, 세션 재초기화 실패
  | 'too_large'
  | 'input_required'      // modern input_required를 처리할 수 없을 때
  | 'protocol';           // 업스트림 JSON-RPC 오류 (code/message/data 보존)

export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamErrorKind,
    message: string,
    readonly info: { wwwAuthenticate?: string; scope?: string; status?: number; rpc?: { code: number; message: string; data?: unknown } } = {},
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface UpstreamTimeouts {
  connectMs: number;
  initializeMs: number;
  listMs: number;
}

export interface UpstreamConnectorOptions {
  serverId: string;
  url: string;
  fetch: FetchLike;
  /** 호출마다 업스트림 자격증명 헤더를 받는다 (OAuth면 필요 시 refresh 선행) */
  headers: () => Promise<Record<string, string>>;
  /** 401을 받았을 때. 'retry'면 커넥터가 정확히 한 번 재시도한다 (10.4) */
  onUnauthorized?: (wwwAuthenticate?: string) => Promise<'retry' | 'needs_auth'>;
  timeouts?: Partial<UpstreamTimeouts>;
  logger?: Logger;
  /** 세대를 강제한다 (probe 결과를 저장해 두었다가 재연결 시 사용) */
  era?: ProtocolEra;
}

/** tools/call params (D9). 알려진 필드 외에는 넣지 않는다 */
export interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  /** 2026-07-28 MRTR: InputRequiredResult 의 inputRequests 에 대한 응답 */
  inputResponses?: Record<string, unknown>;
  /** 2026-07-28 MRTR: 서버가 준 불투명 상태. 그대로 되돌려 보낸다 */
  requestState?: string;
}

export interface UpstreamConnector {
  readonly serverId: string;
  readonly era: ProtocolEra;
  readonly protocolVersion: string;
  readonly transport: 'streamable_http' | 'sse';
  readonly serverInfo: Record<string, unknown> | null;
  readonly capabilities: Record<string, unknown> | null;
  /** 마지막 tools/list 결과의 ttlMs (modern 의 CacheableResult). legacy 나 미조회면 null (17.3, D8) */
  readonly lastToolsTtlMs: number | null;
  /** 연결·세대 감지·initialize 또는 server/discover. 401이면 UpstreamError('unauthorized') */
  connect(): Promise<ProbeResult>;
  listTools(signal?: AbortSignal): Promise<ToolDefinition[]>;
  /**
   * tools/call. 결과는 CallToolResult JSON 그대로. 재시도하지 않는다 (401 후 1회 제외).
   * modern MRTR 재시도의 inputResponses·requestState 는 params 최상위 필드로 그대로 전달한다 (11.4, D9).
   */
  callTool(params: CallToolParams, ctx: CallContext): Promise<Record<string, unknown>>;
  /** resources/list, resources/templates/list, resources/read, prompts/list, prompts/get, completion/complete */
  forward(method: string, params: Record<string, unknown> | undefined, ctx: CallContext): Promise<Record<string, unknown>>;
  /** 업스트림이 보낸 목록 변경 알림 */
  onListChanged(cb: (kind: 'tools' | 'prompts' | 'resources') => void): () => void;
  onClose(cb: (reason?: string) => void): () => void;
  close(): Promise<void>;
}

/** 세대 감지 + 커넥터 생성. era 미지정이면 11.1 절차로 감지한다 */
export type CreateUpstreamConnector = (opts: UpstreamConnectorOptions) => UpstreamConnector;

// ---------------------------------------------------------------------------
// oauth (10장)
// ---------------------------------------------------------------------------
export interface OAuthPrepareResult {
  issuer: string;
  clientMode: OAuthClientMode;
  scope: string | null;
  /** 사전 등록 입력이 필요하면 true (CIMD·DCR 모두 불가) */
  needsClientInput: boolean;
}

export interface OAuthCallbackParams {
  code?: string;
  state?: string;
  iss?: string;
  error?: string;
  error_description?: string;
}

export interface OAuthCallbackResult {
  serverId: string | null;
  ok: boolean;
  error?: string;
}

export interface OAuthManager {
  /** 401 응답을 바탕으로 PRM·AS 메타데이터 탐색, issuer·등록 방식 결정, 서버 레코드 갱신 */
  prepare(serverId: string, wwwAuthenticate?: string): Promise<OAuthPrepareResult>;
  /** 인가 URL 생성 (PKCE, resource, state 저장). 10분 만료 */
  start(serverId: string, opts?: { sessionId?: string | null }): Promise<OAuthStartResult>;
  /** 콜백 처리: state 소진, iss 검증, 토큰 교환, 시크릿 저장, 상태 전이 */
  handleCallback(params: OAuthCallbackParams): Promise<OAuthCallbackResult>;
  setPreregisteredClient(serverId: string, clientId: string, clientSecret?: string): Promise<void>;
  /** 업스트림 요청용 헤더. 만료 임박이면 refresh (단일 비행) */
  headersFor(serverId: string): Promise<Record<string, string>>;
  /** 401을 받았을 때: refresh 성공이면 'retry', 아니면 서버를 needs_auth로 바꾸고 'needs_auth' */
  onUnauthorized(serverId: string, wwwAuthenticate?: string): Promise<'retry' | 'needs_auth'>;
  /** 403 insufficient_scope: requested_scope 합집합 갱신 + needs_auth */
  onInsufficientScope(serverId: string, scope: string): Promise<void>;
  /** RFC 7009 best effort */
  revoke(serverId: string): Promise<void>;
  /** 토큰 만료 시각 (화면 표시용) */
  expiresAt(serverId: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// agentd 클라이언트 (12.2)
// ---------------------------------------------------------------------------
export interface AgentdClient {
  syncPlan(agent: Agent, desired: DesiredAgentConfig): Promise<SyncResult>;
  syncApply(agent: Agent, desired: DesiredAgentConfig): Promise<SyncResult>;
  writeToken(agent: Agent, token: string): Promise<void>;
  status(): Promise<AgentdStatus>;
}

export class AgentdUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentdUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Hub 파사드 (API가 쓰는 것, 14장)
// ---------------------------------------------------------------------------
export interface HubServers {
  list(): ServerSummary[];
  get(id: string): Promise<ServerDetail | undefined>;
  create(input: CreateServerBody): Promise<ServerDetail>;
  patch(id: string, patch: PatchServerBody): Promise<ServerDetail>;
  approve(id: string, body: ApproveBody): Promise<ApproveResult>;
  probe(id: string): Promise<ServerDetail>;
  test(id: string): Promise<TestResult>;
  delete(id: string, opts?: { force?: boolean }): Promise<DeleteResult>;
  setCredentials(id: string, headerName: string, value: string): Promise<void>;
}

export interface HubSync {
  all(): Promise<Record<Agent, SyncOutcome>>;
  plan(): Promise<Record<Agent, SyncOutcome>>;
  server(id: string): Promise<Record<Agent, SyncOutcome>>;
}

export interface HubTokens {
  rotate(agents: Agent[]): Promise<{ rotatedAt: string; graceUntil: string }>;
  /** 다운스트림 인증: 토큰 → 에이전트 (유예 중인 이전 토큰 포함). 아니면 null */
  authenticate(token: string): Agent | null;
}

export interface Hub {
  readonly config: HubConfig;
  readonly registry: Registry;
  readonly servers: HubServers;
  readonly oauth: OAuthManager;
  readonly sync: HubSync;
  readonly tokens: HubTokens;
  readonly masker: Masker;
  readonly logger: Logger;
  audit(q: AuditQuery): AuditPage;
  events(q: { serverId?: string; agent?: Agent; since?: string; cursor?: number; limit?: number }): EventPage;
  presets(): Preset[];
  status(): Promise<HubStatus>;
  /** 127.0.0.1:port 리스너 시작, 상태 점검 타이머 시작 */
  start(): Promise<void>;
  stop(): Promise<void>;
}
