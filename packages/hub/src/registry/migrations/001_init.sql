-- 설계문서 13장 스키마 (초기). 비밀값 컬럼은 두지 않는다.
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

CREATE TABLE mcp_servers (
  id                 TEXT PRIMARY KEY,   -- 'fish-audio' ([a-z0-9-]{1,40}). CLI 항목 이름은 'omni-' || id
  display_name       TEXT NOT NULL,
  source             TEXT NOT NULL,      -- url | preset | json | registry
  preset_id          TEXT,
  transport          TEXT NOT NULL,      -- streamable_http | sse | stdio
  url                TEXT,               -- 입력한 원격 서버 URL
  canonical_url      TEXT,               -- OAuth resource 파라미터용 정규화 URL
  command            TEXT,               -- stdio (Phase 2)
  args_json          TEXT,               -- stdio
  env_keys_json      TEXT,               -- stdio 환경변수 이름 목록 (값은 Secrets Manager)
  auth_type          TEXT NOT NULL,      -- none | header | oauth | stdio_env
  header_name        TEXT,               -- header 인증의 헤더 이름 (값은 시크릿)
  secret_ref         TEXT,               -- 'omnicode/mcp/fish-audio'
  oauth_issuer       TEXT,
  oauth_client_mode  TEXT,               -- cimd | dcr | preregistered
  oauth_prm_url      TEXT,               -- 마지막으로 쓴 Protected Resource Metadata URL
  requested_scope    TEXT,
  granted_scope      TEXT,
  protocol_era       TEXT,               -- legacy | modern
  protocol_version   TEXT,               -- 협상된 MCP 버전
  server_info_json   TEXT,               -- 업스트림 serverInfo (표시용)
  capabilities_json  TEXT,               -- 업스트림 capabilities
  call_timeout_ms    INTEGER NOT NULL DEFAULT 600000,
  cli_auto_approve   INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL,      -- draft | needs_auth | pending_approval | active | changed | error | disabled | deleting
  last_error         TEXT,               -- 마스킹 후 저장
  last_probe_at      TEXT,
  tools_synced_at    TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE mcp_tools (
  server_id                 TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  name                      TEXT NOT NULL,
  title                     TEXT,
  description               TEXT,
  definition_json           TEXT NOT NULL,   -- 현재 정의 (name, title, description, inputSchema, outputSchema, annotations)
  schema_hash               TEXT NOT NULL,   -- sha256(JCS(definition))
  approved_hash             TEXT,            -- 사용자가 승인한 시점의 해시
  approved_definition_json  TEXT,            -- 승인 시점 정의 (변경 비교 화면용)
  approved_at               TEXT,
  annotations_json          TEXT,            -- readOnlyHint, destructiveHint 등 (표시용)
  enabled                   INTEGER NOT NULL DEFAULT 1,
  first_seen_at             TEXT NOT NULL,
  last_seen_at              TEXT NOT NULL,
  PRIMARY KEY (server_id, name)
);

CREATE TABLE mcp_bindings (
  server_id    TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  agent        TEXT NOT NULL,              -- claude | codex | gemini
  enabled      INTEGER NOT NULL DEFAULT 1,
  sync_status  TEXT,                       -- synced | pending | failed
  synced_at    TEXT,
  last_error   TEXT,
  PRIMARY KEY (server_id, agent)
);

CREATE TABLE oauth_states (
  state                TEXT PRIMARY KEY,   -- base64url 32바이트
  server_id            TEXT NOT NULL,
  code_verifier        TEXT NOT NULL,      -- 10분 수명, 사용 후 삭제
  issuer               TEXT NOT NULL,
  client_id            TEXT NOT NULL,
  scope                TEXT,
  omnicode_session_id  TEXT,               -- 감사용
  created_at           TEXT NOT NULL,
  expires_at           TEXT NOT NULL,
  used_at              TEXT
);

CREATE TABLE agent_tokens (
  agent          TEXT PRIMARY KEY,         -- claude | codex | gemini
  token_sha256   TEXT NOT NULL,
  prev_sha256    TEXT,                     -- 재발급 유예 중인 이전 토큰
  prev_valid_until TEXT,
  rotated_at     TEXT NOT NULL
);

CREATE TABLE mcp_events (                  -- 수명주기 이벤트 (G6의 "언제 무엇을 바꿨나")
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- server.created | probe | auth.started | auth.completed | auth.failed
                                           -- | tools.approved | tools.changed | binding.changed | sync.applied | sync.failed
                                           -- | server.disabled | server.enabled | server.deleted | token.rotated | health.error
  server_id     TEXT,
  agent         TEXT,
  actor         TEXT NOT NULL,             -- user | hub | agentd
  details_json  TEXT                       -- 마스킹 후 저장
);

CREATE TABLE mcp_audit_log (               -- 도구 호출 기록
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                TEXT NOT NULL,
  agent             TEXT NOT NULL,         -- 토큰에서 식별
  job_id            TEXT,                  -- X-OmniCode-Job
  server_id         TEXT NOT NULL,
  method            TEXT NOT NULL,         -- tools/call | resources/read | prompts/get
  tool              TEXT,                  -- 도구 이름 또는 리소스 URI
  outcome           TEXT NOT NULL,         -- ok | error | blocked
  error_code        INTEGER,               -- 11.9의 코드
  duration_ms       INTEGER,
  req_bytes         INTEGER,
  res_bytes         INTEGER,
  args_sha256       TEXT,                  -- 인자 원문은 저장하지 않는다
  protocol_version  TEXT,
  error             TEXT                   -- 마스킹 후 4 KiB까지
);

CREATE INDEX idx_audit_ts ON mcp_audit_log (ts);
CREATE INDEX idx_audit_server_ts ON mcp_audit_log (server_id, ts);
CREATE INDEX idx_audit_agent_ts ON mcp_audit_log (agent, ts);
CREATE INDEX idx_events_ts ON mcp_events (ts);
