/**
 * OAuth 테스트용 인메모리 가짜 (Registry · SecretStore · 시계).
 * 실제 registry/secrets 구현은 병렬로 작성 중이므로 계약 인터페이스만 만족시킨다.
 * 쓰지 않는 메서드는 최소 동작만 한다.
 */
import pino from 'pino';
import { DEFAULTS } from '@omnicode/shared';
import type { Agent, AuditEntry, AuditPage, AuditQuery, BindingRecord, EventPage, EventRecord, ServerRecord, ServerStatus, ToolDefinition, ToolRecord } from '@omnicode/shared';
import {
  canTransition,
  InvalidTransitionError,
  NotFoundError,
  type AgentTokenRecord,
  type AgentTokenRepo,
  type AuditRepo,
  type BindingRepo,
  type EventRepo,
  type FetchLike,
  type HubConfig,
  type Logger,
  type NewServer,
  type OAuthSecret,
  type OAuthStateRecord,
  type OAuthStateRepo,
  type Registry,
  type SecretStore,
  type SecretValue,
  type ServerRepo,
  type ToolRepo,
  type ToolUpsertDiff,
} from '../../src/contracts.js';
import { createOAuthManager, type HubOAuthManager } from '../../src/oauth/index.js';
import type { FakeAs } from '../fixtures/fake-as.js';

export const PUBLIC_URL = 'https://omni.example';
export const CIMD_CLIENT_ID = `${PUBLIC_URL}/.well-known/omnicode/client.json`;
export const REDIRECT_URI = `${PUBLIC_URL}/oauth/callback`;

// ---------------------------------------------------------------- 시계

export interface FakeClock {
  now(): Date;
  iso(): string;
  /** now + ms 의 ISO */
  plus(ms: number): string;
  set(d: Date | string): void;
  advance(ms: number): void;
}

export function createClock(start = '2026-10-07T00:00:00.000Z'): FakeClock {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    iso: () => current.toISOString(),
    plus: (ms) => new Date(current.getTime() + ms).toISOString(),
    set(d) {
      current = new Date(d);
    },
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
  };
}

// ---------------------------------------------------------------- registry

export class FakeServerRepo implements ServerRepo {
  readonly rows = new Map<string, ServerRecord>();
  constructor(private readonly now: () => string) {}
  get(id: string): ServerRecord | undefined {
    const r = this.rows.get(id);
    return r ? { ...r } : undefined;
  }
  list(): ServerRecord[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  insert(rec: NewServer): ServerRecord {
    const ts = this.now();
    const row: ServerRecord = { ...rec, created_at: rec.created_at ?? ts, updated_at: rec.updated_at ?? ts };
    this.rows.set(row.id, row);
    return { ...row };
  }
  update(id: string, patch: Partial<Omit<ServerRecord, 'id' | 'created_at'>>): ServerRecord {
    const row = this.rows.get(id);
    if (!row) throw new NotFoundError(`server ${id}`);
    const next: ServerRecord = { ...row, ...patch, updated_at: this.now() };
    this.rows.set(id, next);
    return { ...next };
  }
  setStatus(id: string, status: ServerStatus, opts?: { lastError?: string | null }): ServerRecord {
    const row = this.rows.get(id);
    if (!row) throw new NotFoundError(`server ${id}`);
    if (!canTransition(row.status, status)) throw new InvalidTransitionError(id, row.status, status);
    const next: ServerRecord = {
      ...row,
      status,
      updated_at: this.now(),
      ...(opts && 'lastError' in opts ? { last_error: opts.lastError ?? null } : {}),
    };
    this.rows.set(id, next);
    return { ...next };
  }
  delete(id: string): void {
    this.rows.delete(id);
  }
}

export class FakeToolRepo implements ToolRepo {
  readonly rows = new Map<string, ToolRecord>();
  constructor(private readonly now: () => string) {}
  seed(serverId: string, name: string, opts: { approvedHash?: string | null } = {}): ToolRecord {
    const ts = this.now();
    const row: ToolRecord = {
      server_id: serverId,
      name,
      title: null,
      description: null,
      definition_json: JSON.stringify({ name, inputSchema: { type: 'object' } }),
      schema_hash: 'a'.repeat(64),
      approved_hash: opts.approvedHash ?? null,
      approved_definition_json: null,
      approved_at: opts.approvedHash ? ts : null,
      annotations_json: null,
      enabled: 1,
      first_seen_at: ts,
      last_seen_at: ts,
    };
    this.rows.set(`${serverId}/${name}`, row);
    return row;
  }
  listByServer(serverId: string): ToolRecord[] {
    return [...this.rows.values()].filter((t) => t.server_id === serverId);
  }
  get(serverId: string, name: string): ToolRecord | undefined {
    return this.rows.get(`${serverId}/${name}`);
  }
  upsertFromUpstream(_serverId: string, _defs: ToolDefinition[]): ToolUpsertDiff {
    return { added: [], changed: [], removed: [], unchanged: [] };
  }
  approve(): void {}
  setEnabled(): void {}
}

export class FakeBindingRepo implements BindingRepo {
  readonly rows = new Map<string, BindingRecord>();
  get(serverId: string, agent: Agent): BindingRecord | undefined {
    return this.rows.get(`${serverId}/${agent}`);
  }
  listByServer(serverId: string): BindingRecord[] {
    return [...this.rows.values()].filter((b) => b.server_id === serverId);
  }
  listByAgent(agent: Agent): BindingRecord[] {
    return [...this.rows.values()].filter((b) => b.agent === agent);
  }
  upsert(serverId: string, agent: Agent, enabled: boolean): void {
    this.rows.set(`${serverId}/${agent}`, { server_id: serverId, agent, enabled: enabled ? 1 : 0, sync_status: null, synced_at: null, last_error: null });
  }
  setSync(): void {}
}

export class FakeOAuthStateRepo implements OAuthStateRepo {
  readonly rows = new Map<string, OAuthStateRecord>();
  create(rec: OAuthStateRecord): void {
    this.rows.set(rec.state, { ...rec });
  }
  consume(state: string, now = new Date().toISOString()): OAuthStateRecord | undefined {
    const rec = this.rows.get(state);
    if (!rec || rec.used_at || rec.expires_at <= now) return undefined;
    rec.used_at = now;
    return { ...rec };
  }
  purgeExpired(now = new Date().toISOString()): number {
    let n = 0;
    for (const [k, r] of this.rows) {
      if (r.expires_at <= now) {
        this.rows.delete(k);
        n += 1;
      }
    }
    return n;
  }
}

export class FakeAgentTokenRepo implements AgentTokenRepo {
  readonly rows = new Map<Agent, AgentTokenRecord>();
  get(agent: Agent): AgentTokenRecord | undefined {
    return this.rows.get(agent);
  }
  all(): AgentTokenRecord[] {
    return [...this.rows.values()];
  }
  set(agent: Agent, tokenSha256: string, prev?: { sha256: string; validUntil: string } | null, rotatedAt = new Date().toISOString()): void {
    this.rows.set(agent, { agent, token_sha256: tokenSha256, prev_sha256: prev?.sha256 ?? null, prev_valid_until: prev?.validUntil ?? null, rotated_at: rotatedAt });
  }
}

export class FakeEventRepo implements EventRepo {
  readonly items: EventRecord[] = [];
  private seq = 0;
  constructor(private readonly now: () => string) {}
  add(e: { kind: EventRecord['kind']; server_id?: string | null; agent?: Agent | null; actor: EventRecord['actor']; details?: unknown; ts?: string }): void {
    this.seq += 1;
    this.items.push({
      id: this.seq,
      ts: e.ts ?? this.now(),
      kind: e.kind,
      server_id: e.server_id ?? null,
      agent: e.agent ?? null,
      actor: e.actor,
      details_json: e.details === undefined ? null : JSON.stringify(e.details),
    });
  }
  list(q: { serverId?: string; agent?: Agent; since?: string; cursor?: number; limit?: number }): EventPage {
    const items = this.items.filter((i) => (!q.serverId || i.server_id === q.serverId) && (!q.agent || i.agent === q.agent));
    return { items, nextCursor: null };
  }
  purgeOlderThan(iso: string): number {
    const before = this.items.length;
    const keep = this.items.filter((i) => i.ts >= iso);
    this.items.length = 0;
    this.items.push(...keep);
    return before - keep.length;
  }
  ofKind(kind: EventRecord['kind'], serverId?: string): EventRecord[] {
    return this.items.filter((i) => i.kind === kind && (!serverId || i.server_id === serverId));
  }
  details(e: EventRecord): Record<string, unknown> {
    return e.details_json ? (JSON.parse(e.details_json) as Record<string, unknown>) : {};
  }
}

export class FakeAuditRepo implements AuditRepo {
  readonly items: AuditEntry[] = [];
  add(e: Omit<AuditEntry, 'id'>): void {
    this.items.push({ id: this.items.length + 1, ...e });
  }
  list(_q: AuditQuery): AuditPage {
    return { items: this.items, nextCursor: null };
  }
  purgeOlderThan(): number {
    return 0;
  }
}

export interface FakeRegistry extends Registry {
  servers: FakeServerRepo;
  tools: FakeToolRepo;
  oauthStates: FakeOAuthStateRepo;
  events: FakeEventRepo;
}

export function createFakeRegistry(now: () => Date): FakeRegistry {
  const iso = (): string => now().toISOString();
  return {
    servers: new FakeServerRepo(iso),
    tools: new FakeToolRepo(iso),
    bindings: new FakeBindingRepo(),
    oauthStates: new FakeOAuthStateRepo(),
    agentTokens: new FakeAgentTokenRepo(),
    events: new FakeEventRepo(iso),
    audit: new FakeAuditRepo(),
    transaction<T>(fn: () => T): T {
      return fn();
    },
    close(): void {},
  };
}

// ---------------------------------------------------------------- secrets

export class FakeSecretStore implements SecretStore {
  readonly values = new Map<string, SecretValue>();
  puts = 0;
  async get<T extends SecretValue = SecretValue>(ref: string): Promise<T | undefined> {
    const v = this.values.get(ref);
    return v ? (structuredClone(v) as T) : undefined;
  }
  async put(ref: string, value: SecretValue): Promise<void> {
    this.puts += 1;
    this.values.set(ref, structuredClone(value));
  }
  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }
  /** 저장된 OAuth 시크릿 (없거나 다른 종류면 throw) */
  oauth(ref: string): OAuthSecret {
    const v = this.values.get(ref);
    if (!v || !('type' in v) || v.type !== 'oauth') throw new Error(`no oauth secret at ${ref}`);
    return structuredClone(v);
  }
}

// ---------------------------------------------------------------- 조립

export function makeConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    publicUrl: PUBLIC_URL,
    hubHost: '127.0.0.1',
    hubPort: DEFAULTS.hubPort,
    dataDir: '/tmp/omnicode-test',
    agentdSocket: '/tmp/omnicode-test/agentd.sock',
    secretsPrefix: DEFAULTS.secretsPrefix,
    secretsBackend: 'memory',
    callTimeoutMs: DEFAULTS.callTimeoutMs,
    idleTimeoutMs: DEFAULTS.idleTimeoutMs,
    allowPrivateHosts: [],
    allowHttpLoopback: true,
    auditRetentionDays: DEFAULTS.auditRetentionDays,
    eventRetentionDays: DEFAULTS.eventRetentionDays,
    agentTokenGraceMs: DEFAULTS.agentTokenGraceMs,
    healthIntervalMs: DEFAULTS.healthIntervalMs,
    forwardLogMessages: true,
    cimdEnabled: true,
    registryUrl: null,
    presetsDir: '/tmp/omnicode-test/presets',
    version: '0.1.0-test',
    ...overrides,
  };
}

export function makeServer(id: string, url: string | null, overrides: Partial<ServerRecord> = {}): NewServer {
  return {
    id,
    display_name: id,
    source: 'url',
    preset_id: null,
    transport: 'streamable_http',
    url,
    canonical_url: null,
    command: null,
    args_json: null,
    env_keys_json: null,
    auth_type: 'none',
    header_name: null,
    secret_ref: null,
    oauth_issuer: null,
    oauth_client_mode: null,
    oauth_prm_url: null,
    requested_scope: null,
    granted_scope: null,
    protocol_era: null,
    protocol_version: null,
    server_info_json: null,
    capabilities_json: null,
    call_timeout_ms: DEFAULTS.callTimeoutMs,
    cli_auto_approve: 1,
    status: 'draft',
    last_error: null,
    last_probe_at: null,
    tools_synced_at: null,
    ...overrides,
  };
}

export interface TestEnv {
  registry: FakeRegistry;
  secrets: FakeSecretStore;
  clock: FakeClock;
  config: HubConfig;
  logger: Logger;
  manager: HubOAuthManager;
  /** 관리자에 주입한 fetch (guardedFetch 자리) */
  fetch: FetchLike;
  /** 주입된 fetch가 처리한 요청 URL (모든 outbound HTTP가 주입 fetch를 통과하는지 확인용). 가상 호스트는 바꾸기 전 URL */
  fetchCalls: string[];
}

/**
 * 가상 오리진 → 실제 주소. 예: { 'https://legacy.example': fakeAs.url }.
 * 가짜 서버는 http 루프백에서 돌지만, 인가 URL은 https여야 하므로(10.3) 기본 엔드포인트를 https 오리진으로 시험할 때 쓴다.
 */
export type VirtualHosts = Record<string, string>;

export function routeHost(url: string | URL, hosts: VirtualHosts): string {
  const u = new URL(String(url));
  const target = hosts[u.origin];
  return target ? `${new URL(target).origin}${u.pathname}${u.search}` : u.href;
}

export function createEnv(opts: { config?: Partial<HubConfig>; clock?: FakeClock; hosts?: VirtualHosts } = {}): TestEnv {
  const clock = opts.clock ?? createClock();
  const registry = createFakeRegistry(() => clock.now());
  const secrets = new FakeSecretStore();
  const config = makeConfig(opts.config);
  const logger = pino({ level: 'silent' });
  const fetchCalls: string[] = [];
  const hosts = opts.hosts ?? {};
  const guarded: FetchLike = (url, init) => {
    fetchCalls.push(String(url));
    return fetch(routeHost(url, hosts), init);
  };
  const manager = createOAuthManager({ config, registry, secrets, fetch: guarded, logger, now: () => clock.now() });
  return { registry, secrets, clock, config, logger, manager, fetch: guarded, fetchCalls };
}

/** Hub 재시작 흉내: 같은 registry·secrets·fetch로 관리자를 새로 만든다 (AS 메타데이터 메모리 캐시가 빈다) */
export function restartManager(env: TestEnv): HubOAuthManager {
  env.manager = createOAuthManager({
    config: env.config,
    registry: env.registry,
    secrets: env.secrets,
    fetch: env.fetch,
    logger: env.logger,
    now: () => env.clock.now(),
  });
  return env.manager;
}

/** 사용자 브라우저 흉내: 인가 URL을 열고(가상 호스트는 hosts로 연결) 302 Location의 code·state·iss를 돌려준다 */
export async function followAuthorization(
  authorizationUrl: string,
  hosts: VirtualHosts = {},
): Promise<{ code: string; state: string; iss: string | null; location: URL }> {
  const res = await fetch(routeHost(authorizationUrl, hosts), { redirect: 'manual' });
  const location = res.headers.get('location');
  if (res.status !== 302 || !location) throw new Error(`authorize did not redirect: HTTP ${res.status} ${await res.text()}`);
  const back = new URL(location);
  return { code: back.searchParams.get('code') ?? '', state: back.searchParams.get('state') ?? '', iss: back.searchParams.get('iss'), location: back };
}

export function addServer(env: TestEnv, as: FakeAs, overrides: Partial<ServerRecord> = {}): ServerRecord {
  const id = overrides.id ?? 'fish';
  return env.registry.servers.insert(makeServer(id, as.mcpUrl, overrides));
}

export function secretRefOf(serverId: string): string {
  return `${DEFAULTS.secretsPrefix}/mcp/${serverId}`;
}

/**
 * 로그인이 끝난 상태를 직접 만든다 (CIMD client, 토큰 있음, 기본 status active).
 * refresh token은 가짜 AS에도 심어 refresh가 성공하게 한다 (registerRefreshToken=false면 심지 않는다).
 */
export function seedOAuthSecret(
  env: TestEnv,
  serverId: string,
  as: FakeAs,
  secretOverrides: Partial<OAuthSecret> = {},
  opts: { status?: ServerStatus; registerRefreshToken?: boolean } = {},
): OAuthSecret {
  const ref = secretRefOf(serverId);
  const secret: OAuthSecret = {
    type: 'oauth',
    issuer: as.issuer,
    client_mode: 'cimd',
    client_id: CIMD_CLIENT_ID,
    client_secret: null,
    token_endpoint_auth_method: 'none',
    registration_access_token: null,
    registration_client_uri: null,
    resource: as.mcpUrl,
    access_token: 'at-seed-000001',
    refresh_token: 'rt-seed-000001',
    expires_at: env.clock.plus(3_600_000),
    scope: 'tts',
    obtained_at: env.clock.iso(),
    ...secretOverrides,
  };
  env.secrets.values.set(ref, structuredClone(secret));
  const row = env.registry.servers.rows.get(serverId);
  if (!row) throw new Error(`seedOAuthSecret: server ${serverId} not inserted`);
  env.registry.servers.rows.set(serverId, {
    ...row,
    auth_type: 'oauth',
    secret_ref: ref,
    oauth_issuer: secret.issuer,
    oauth_client_mode: secret.client_mode,
    canonical_url: as.mcpUrl,
    requested_scope: row.requested_scope ?? secret.scope,
    granted_scope: secret.scope,
    status: opts.status ?? 'active',
  });
  if (secret.refresh_token && opts.registerRefreshToken !== false) {
    as.seedRefreshToken(secret.refresh_token, { clientId: secret.client_id, resource: secret.resource, scope: secret.scope });
  }
  return secret;
}

/** prepare → start → (사용자 동의) → callback 전체 흐름. 성공을 단언한다. */
export async function login(env: TestEnv, as: FakeAs, serverId: string, opts: { sessionId?: string; iss?: string | false } = {}): Promise<OAuthSecret> {
  await env.manager.prepare(serverId);
  const { authorizationUrl } = await env.manager.start(serverId, { sessionId: opts.sessionId ?? null });
  const { code, state } = as.issueCode(authorizationUrl);
  const params: { code: string; state: string; iss?: string } = { code, state: state ?? '' };
  if (opts.iss !== false) params.iss = opts.iss ?? as.issuer;
  const result = await env.manager.handleCallback(params);
  if (!result.ok) throw new Error(`login failed: ${result.error}`);
  return env.secrets.oauth(secretRefOf(serverId));
}
