/** 공용 타입 — 설계문서 13장과 1:1. DB 행과 API DTO가 모두 여기서 파생된다. */

export type Agent = 'claude' | 'codex' | 'gemini';
export const AGENTS = ['claude', 'codex', 'gemini'] as const satisfies readonly Agent[];
export function isAgent(x: unknown): x is Agent {
  return typeof x === 'string' && (AGENTS as readonly string[]).includes(x);
}

export type ServerStatus =
  | 'draft'
  | 'needs_auth'
  | 'pending_approval'
  | 'active'
  | 'changed'
  | 'error'
  | 'disabled'
  | 'deleting';

export type ProtocolEra = 'legacy' | 'modern';
export type Transport = 'streamable_http' | 'sse' | 'stdio';
export type AuthType = 'none' | 'header' | 'oauth' | 'stdio_env';
export type ServerSource = 'url' | 'preset' | 'json' | 'registry';
export type OAuthClientMode = 'cimd' | 'dcr' | 'preregistered';
export type SyncStatus = 'synced' | 'pending' | 'failed';

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [k: string]: unknown;
}

/** 해시 대상이 되는 도구 정의. icons·_meta 같은 표시용 필드는 제외한다 (13장 해시 규칙). */
export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

export interface ServerRecord {
  id: string;
  display_name: string;
  source: ServerSource;
  preset_id: string | null;
  transport: Transport;
  url: string | null;
  canonical_url: string | null;
  command: string | null;
  args_json: string | null;
  env_keys_json: string | null;
  auth_type: AuthType;
  header_name: string | null;
  secret_ref: string | null;
  oauth_issuer: string | null;
  oauth_client_mode: OAuthClientMode | null;
  oauth_prm_url: string | null;
  requested_scope: string | null;
  granted_scope: string | null;
  protocol_era: ProtocolEra | null;
  protocol_version: string | null;
  server_info_json: string | null;
  capabilities_json: string | null;
  call_timeout_ms: number;
  cli_auto_approve: number;
  status: ServerStatus;
  last_error: string | null;
  last_probe_at: string | null;
  tools_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ToolRecord {
  server_id: string;
  name: string;
  title: string | null;
  description: string | null;
  definition_json: string;
  schema_hash: string;
  approved_hash: string | null;
  approved_definition_json: string | null;
  approved_at: string | null;
  annotations_json: string | null;
  enabled: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface BindingRecord {
  server_id: string;
  agent: Agent;
  enabled: number;
  sync_status: SyncStatus | null;
  synced_at: string | null;
  last_error: string | null;
}

export interface AuditEntry {
  id: number;
  ts: string;
  agent: Agent;
  job_id: string | null;
  server_id: string;
  method: string;
  tool: string | null;
  outcome: 'ok' | 'error' | 'blocked';
  error_code: number | null;
  duration_ms: number | null;
  req_bytes: number | null;
  res_bytes: number | null;
  args_sha256: string | null;
  protocol_version: string | null;
  error: string | null;
}

export type EventKind =
  | 'server.created' | 'probe' | 'auth.started' | 'auth.completed' | 'auth.failed'
  | 'tools.approved' | 'tools.changed' | 'binding.changed' | 'sync.applied' | 'sync.failed'
  | 'server.disabled' | 'server.enabled' | 'server.deleted' | 'token.rotated' | 'health.error'
  | 'credentials.saved' | 'server.updated';

export interface EventRecord {
  id: number;
  ts: string;
  kind: EventKind;
  server_id: string | null;
  agent: Agent | null;
  actor: 'user' | 'hub' | 'agentd';
  details_json: string | null;
}

/** 동기화 플래너가 agentd에 보내는 "원하는 상태" (12.2). */
export interface DesiredEntry {
  name: string;        // 'omni-<id>'
  serverId: string;
  url: string;         // http://127.0.0.1:7410/mcp/<id>
  timeoutMs: number;
  autoApprove: boolean;
}
export interface DesiredAgentConfig {
  entries: DesiredEntry[];
}
export interface SyncResult {
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
}

export interface Preset {
  id: string;
  displayName: string;
  description?: string;
  transport: 'streamable_http' | 'sse';
  url: string;
  auth: { type: 'none' | 'header' | 'oauth'; headerName?: string; scopes?: string[] };
  docs?: string;
  defaultAgents?: Agent[];
}
