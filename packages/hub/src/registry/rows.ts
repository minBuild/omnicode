/** node:sqlite 행 → 타입 레코드 변환 보조. 컬럼 누락·형 불일치는 즉시 오류로 드러낸다. */
import type { SQLOutputValue } from 'node:sqlite';
import type { AuditEntry, BindingRecord, EventRecord, ServerRecord, ToolRecord } from '@omnicode/shared';
import type { AgentTokenRecord, OAuthStateRecord } from '../contracts.js';

export type Row = Record<string, SQLOutputValue>;

export function str(row: Row, key: string): string {
  const v = row[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  throw new TypeError(`column ${key}: expected text, got ${v === null ? 'NULL' : typeof v}`);
}

export function strOrNull(row: Row, key: string): string | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  return str(row, key);
}

export function num(row: Row, key: string): number {
  const v = row[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  throw new TypeError(`column ${key}: expected number, got ${v === null ? 'NULL' : typeof v}`);
}

export function numOrNull(row: Row, key: string): number | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  return num(row, key);
}

/** mcp_servers 컬럼 (INSERT/UPDATE 허용 목록) */
export const SERVER_COLUMNS = [
  'id',
  'display_name',
  'source',
  'preset_id',
  'transport',
  'url',
  'canonical_url',
  'command',
  'args_json',
  'env_keys_json',
  'auth_type',
  'header_name',
  'secret_ref',
  'oauth_issuer',
  'oauth_client_mode',
  'oauth_prm_url',
  'requested_scope',
  'granted_scope',
  'protocol_era',
  'protocol_version',
  'server_info_json',
  'capabilities_json',
  'call_timeout_ms',
  'cli_auto_approve',
  'status',
  'last_error',
  'last_probe_at',
  'tools_synced_at',
  'created_at',
  'updated_at',
] as const satisfies readonly (keyof ServerRecord)[];

export function toServerRecord(row: Row): ServerRecord {
  return {
    id: str(row, 'id'),
    display_name: str(row, 'display_name'),
    source: str(row, 'source') as ServerRecord['source'],
    preset_id: strOrNull(row, 'preset_id'),
    transport: str(row, 'transport') as ServerRecord['transport'],
    url: strOrNull(row, 'url'),
    canonical_url: strOrNull(row, 'canonical_url'),
    command: strOrNull(row, 'command'),
    args_json: strOrNull(row, 'args_json'),
    env_keys_json: strOrNull(row, 'env_keys_json'),
    auth_type: str(row, 'auth_type') as ServerRecord['auth_type'],
    header_name: strOrNull(row, 'header_name'),
    secret_ref: strOrNull(row, 'secret_ref'),
    oauth_issuer: strOrNull(row, 'oauth_issuer'),
    oauth_client_mode: strOrNull(row, 'oauth_client_mode') as ServerRecord['oauth_client_mode'],
    oauth_prm_url: strOrNull(row, 'oauth_prm_url'),
    requested_scope: strOrNull(row, 'requested_scope'),
    granted_scope: strOrNull(row, 'granted_scope'),
    protocol_era: strOrNull(row, 'protocol_era') as ServerRecord['protocol_era'],
    protocol_version: strOrNull(row, 'protocol_version'),
    server_info_json: strOrNull(row, 'server_info_json'),
    capabilities_json: strOrNull(row, 'capabilities_json'),
    call_timeout_ms: num(row, 'call_timeout_ms'),
    cli_auto_approve: num(row, 'cli_auto_approve'),
    status: str(row, 'status') as ServerRecord['status'],
    last_error: strOrNull(row, 'last_error'),
    last_probe_at: strOrNull(row, 'last_probe_at'),
    tools_synced_at: strOrNull(row, 'tools_synced_at'),
    created_at: str(row, 'created_at'),
    updated_at: str(row, 'updated_at'),
  };
}

export function toToolRecord(row: Row): ToolRecord {
  return {
    server_id: str(row, 'server_id'),
    name: str(row, 'name'),
    title: strOrNull(row, 'title'),
    description: strOrNull(row, 'description'),
    definition_json: str(row, 'definition_json'),
    schema_hash: str(row, 'schema_hash'),
    approved_hash: strOrNull(row, 'approved_hash'),
    approved_definition_json: strOrNull(row, 'approved_definition_json'),
    approved_at: strOrNull(row, 'approved_at'),
    annotations_json: strOrNull(row, 'annotations_json'),
    enabled: num(row, 'enabled'),
    first_seen_at: str(row, 'first_seen_at'),
    last_seen_at: str(row, 'last_seen_at'),
  };
}

export function toBindingRecord(row: Row): BindingRecord {
  return {
    server_id: str(row, 'server_id'),
    agent: str(row, 'agent') as BindingRecord['agent'],
    enabled: num(row, 'enabled'),
    sync_status: strOrNull(row, 'sync_status') as BindingRecord['sync_status'],
    synced_at: strOrNull(row, 'synced_at'),
    last_error: strOrNull(row, 'last_error'),
  };
}

export function toOAuthStateRecord(row: Row): OAuthStateRecord {
  return {
    state: str(row, 'state'),
    server_id: str(row, 'server_id'),
    code_verifier: str(row, 'code_verifier'),
    issuer: str(row, 'issuer'),
    client_id: str(row, 'client_id'),
    scope: strOrNull(row, 'scope'),
    omnicode_session_id: strOrNull(row, 'omnicode_session_id'),
    created_at: str(row, 'created_at'),
    expires_at: str(row, 'expires_at'),
    used_at: strOrNull(row, 'used_at'),
  };
}

export function toAgentTokenRecord(row: Row): AgentTokenRecord {
  return {
    agent: str(row, 'agent') as AgentTokenRecord['agent'],
    token_sha256: str(row, 'token_sha256'),
    prev_sha256: strOrNull(row, 'prev_sha256'),
    prev_valid_until: strOrNull(row, 'prev_valid_until'),
    rotated_at: str(row, 'rotated_at'),
  };
}

export function toEventRecord(row: Row): EventRecord {
  return {
    id: num(row, 'id'),
    ts: str(row, 'ts'),
    kind: str(row, 'kind') as EventRecord['kind'],
    server_id: strOrNull(row, 'server_id'),
    agent: strOrNull(row, 'agent') as EventRecord['agent'],
    actor: str(row, 'actor') as EventRecord['actor'],
    details_json: strOrNull(row, 'details_json'),
  };
}

export function toAuditEntry(row: Row): AuditEntry {
  return {
    id: num(row, 'id'),
    ts: str(row, 'ts'),
    agent: str(row, 'agent') as AuditEntry['agent'],
    job_id: strOrNull(row, 'job_id'),
    server_id: str(row, 'server_id'),
    method: str(row, 'method'),
    tool: strOrNull(row, 'tool'),
    outcome: str(row, 'outcome') as AuditEntry['outcome'],
    error_code: numOrNull(row, 'error_code'),
    duration_ms: numOrNull(row, 'duration_ms'),
    req_bytes: numOrNull(row, 'req_bytes'),
    res_bytes: numOrNull(row, 'res_bytes'),
    args_sha256: strOrNull(row, 'args_sha256'),
    protocol_version: strOrNull(row, 'protocol_version'),
    error: strOrNull(row, 'error'),
  };
}
