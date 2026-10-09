/** API DTO (14장) — API와 Web이 공유한다. 비밀값은 어떤 DTO에도 들어가지 않는다. */
import type { Agent, AuditEntry, AuthType, EventRecord, OAuthClientMode, ProtocolEra, ServerSource, ServerStatus, SyncStatus, ToolAnnotations, Transport, Preset } from './types.js';

export interface BindingView {
  enabled: boolean;
  syncStatus: SyncStatus | null;
  syncedAt: string | null;
  lastError: string | null;
}
export type BindingsView = Record<Agent, BindingView>;

export interface ToolView {
  name: string;
  title: string | null;
  description: string | null;
  annotations: ToolAnnotations | null;
  enabled: boolean;
  schemaHash: string;
  approvedHash: string | null;
  /** approvedHash가 있고 schemaHash와 다르면 true (변경 감지) */
  changed: boolean;
  /** approvedHash가 없으면 true (새 도구) */
  pendingApproval: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  approvedDefinition: Record<string, unknown> | null;
}

export interface ServerSummary {
  id: string;
  displayName: string;
  status: ServerStatus;
  transport: Transport;
  authType: AuthType;
  toolCount: number;
  approvedToolCount: number;
  changedToolCount: number;
  bindings: BindingsView;
  lastError: string | null;
  updatedAt: string;
  badges: string[];
}

export interface ServerDetail extends ServerSummary {
  source: ServerSource;
  presetId: string | null;
  url: string | null;
  canonicalUrl: string | null;
  protocol: { era: ProtocolEra | null; version: string | null };
  serverInfo: Record<string, unknown> | null;
  capabilities: Record<string, unknown> | null;
  auth: {
    type: AuthType;
    headerName: string | null;
    issuer: string | null;
    clientMode: OAuthClientMode | null;
    requestedScope: string | null;
    grantedScope: string | null;
    /** OAuth 토큰 만료 시각 (있으면). 토큰 값은 절대 포함하지 않는다 */
    expiresAt: string | null;
    needsClientInput: boolean;
  };
  callTimeoutMs: number;
  cliAutoApprove: boolean;
  tools: ToolView[];
  lastProbeAt: string | null;
  toolsSyncedAt: string | null;
  createdAt: string;
  recentEvents: EventRecord[];
  warnings: string[];
}

export interface SyncOutcome {
  status: SyncStatus;
  at: string | null;
  error?: string;
  result?: { added: string[]; updated: string[]; removed: string[]; unchanged: string[] };
}

export interface ApproveResult {
  status: ServerStatus;
  approved: string[];
  sync: Record<Agent, SyncOutcome>;
}

export interface DeleteResult {
  status: 'deleting' | 'deleted';
  steps: Array<{ step: 'block' | 'sync' | 'revoke' | 'secret' | 'row'; ok: boolean; error?: string }>;
}

export interface TestResult {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
  protocol: { era: ProtocolEra | null; version: string | null };
}

export interface HubStatus {
  version: string;
  uptimeSec: number;
  hub: { host: string; port: number };
  downstreamSessions: { legacy: number; modern: number };
  agentd: { ok: boolean; version?: string; error?: string; cli?: { claude: string | null; codex: string | null; gemini: string | null } };
  lastSync: Record<Agent, SyncOutcome | null>;
  allowPrivateHosts: string[];
  allowHttpLoopback: boolean;
  tokens: Record<Agent, { rotatedAt: string | null; graceUntil: string | null }>;
}

export interface AuditPage {
  items: AuditEntry[];
  nextCursor: number | null;
}
export interface EventPage {
  items: EventRecord[];
  nextCursor: number | null;
}

export interface OAuthStartResult {
  authorizationUrl: string;
  expiresAt: string;
}

export type PresetView = Preset;

// ---------------------------------------------------------------------------
// 인증 (설계 0002 8장)
// ---------------------------------------------------------------------------
export type AuthMode = 'session' | 'dev';

export interface AuthStatus {
  mode: AuthMode;
  authenticated: boolean;
  /** 패스키가 하나도 없어 /setup 으로 첫 패스키를 등록해야 한다 */
  setupRequired: boolean;
  /** 이 시각까지는 재인증 없이 고위험 작업을 할 수 있다. null 이면 재인증이 필요하다 */
  recentAuthUntil: string | null;
  session: { id: string; createdAt: string; expiresAt: string } | null;
}

/** WebAuthn 옵션 응답. options 는 @simplewebauthn 의 *OptionsJSON 그대로다 */
export interface WebAuthnChallenge {
  challengeId: string;
  options: Record<string, unknown>;
}

export interface PasskeyView {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: 'singleDevice' | 'multiDevice';
  /** 비밀번호 관리자(iCloud·Google 등)로 동기화되는 패스키 */
  backedUp: boolean;
}

export interface SessionView {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
}

export interface ReauthResult {
  recentAuthUntil: string;
}

// ---------------------------------------------------------------------------
// 레지스트리 검색 (설계 0001 9.1, handoff D — Phase 3)
// ---------------------------------------------------------------------------
export interface RegistryRemoteView {
  type: 'streamable-http' | 'sse';
  url: string;
  /** URL 에 {변수} 가 있어 그대로는 추가할 수 없다 */
  templated: boolean;
  /** 서버가 요구하는 헤더 이름 (값은 사용자가 넣는다) */
  headers: string[];
}

export interface RegistryServerView {
  name: string;
  title: string | null;
  description: string;
  version: string;
  websiteUrl: string | null;
  repositoryUrl: string | null;
  remotes: RegistryRemoteView[];
  /** 원격이 없고 패키지(stdio)만 있다 — 실행 샌드박스(C1) 전에는 추가할 수 없다 */
  stdioOnly: boolean;
  status: 'active' | 'deprecated' | null;
}

export interface RegistrySearchResult {
  /** OMNICODE_MCP_REGISTRY_URL 이 없으면 false */
  enabled: boolean;
  source: string | null;
  items: RegistryServerView[];
  nextCursor: string | null;
}
