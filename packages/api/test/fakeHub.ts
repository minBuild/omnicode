/**
 * 메모리 가짜 Hub — API 라우트 테스트용. 실제 Hub(packages/hub)는 병렬로 만들어지고 있다.
 * `calls`로 호출을 검증하고, `failWith(method, err)`로 다음 호출을 지정한 오류로 실패시킨다.
 */
import { pino } from 'pino';
import {
  AGENTS,
  ApiError,
  createMasker,
  type Agent,
  type AuditEntry,
  type AuditPage,
  type AuditQuery,
  type BindingsView,
  type DeleteResult,
  type EventPage,
  type EventRecord,
  type HubStatus,
  type Masker,
  type Preset,
  type ServerDetail,
  type ServerSummary,
  type SyncOutcome,
  type SyncResult,
  type SyncStatus,
  type ToolRecord,
  type ToolView,
} from '@omnicode/shared';
import {
  NotFoundError,
  type Hub,
  type HubConfig,
  type HubServers,
  type HubSync,
  type HubTokens,
  type OAuthCallbackResult,
  type OAuthManager,
  type Registry,
} from '@omnicode/hub';

export const NOW = '2026-10-07T08:10:00.000Z';
export const GRACE_UNTIL = '2026-10-07T08:25:00.000Z';
export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);

export const PRESET: Preset = {
  id: 'fish-audio',
  displayName: 'Fish Audio',
  description: '음성 합성',
  transport: 'streamable_http',
  url: 'https://api.fish.audio/mcp',
  auth: { type: 'oauth', scopes: ['tts', 'voices'] },
  docs: 'https://docs.fish.audio/mcp',
};

export function makeBindings(enabled = true): BindingsView {
  const one = () => ({ enabled, syncStatus: null, syncedAt: null, lastError: null });
  return { claude: one(), codex: one(), gemini: one() };
}

export function makeTool(over: Partial<ToolView> = {}): ToolView {
  return {
    name: 'text_to_speech',
    title: null,
    description: '텍스트를 음성으로 바꾼다',
    annotations: null,
    enabled: true,
    schemaHash: HASH_A,
    approvedHash: null,
    changed: false,
    pendingApproval: true,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    outputSchema: null,
    approvedDefinition: null,
    ...over,
  };
}

export function makeToolRecord(over: Partial<ToolRecord> = {}): ToolRecord {
  return {
    server_id: 'fish-audio',
    name: 'text_to_speech',
    title: null,
    description: '설명이 바뀜',
    definition_json: '{}',
    schema_hash: HASH_B,
    approved_hash: HASH_A,
    approved_definition_json: null,
    approved_at: NOW,
    annotations_json: null,
    enabled: 1,
    first_seen_at: NOW,
    last_seen_at: NOW,
    ...over,
  };
}

export function makeDetail(over: Partial<ServerDetail> & { id: string }): ServerDetail {
  return {
    displayName: over.id,
    status: 'pending_approval',
    transport: 'streamable_http',
    authType: 'none',
    toolCount: 1,
    approvedToolCount: 0,
    changedToolCount: 0,
    bindings: makeBindings(),
    lastError: null,
    updatedAt: NOW,
    badges: [],
    source: 'url',
    presetId: null,
    url: `https://${over.id}.example/mcp`,
    canonicalUrl: `https://${over.id}.example/mcp`,
    protocol: { era: 'modern', version: '2026-07-28' },
    serverInfo: null,
    capabilities: null,
    auth: {
      type: 'none',
      headerName: null,
      issuer: null,
      clientMode: null,
      requestedScope: null,
      grantedScope: null,
      expiresAt: null,
      needsClientInput: false,
    },
    callTimeoutMs: 600_000,
    cliAutoApprove: false,
    tools: [makeTool()],
    lastProbeAt: NOW,
    toolsSyncedAt: NOW,
    createdAt: NOW,
    recentEvents: [],
    warnings: [],
    ...over,
  };
}

export function toSummary(d: ServerDetail): ServerSummary {
  return {
    id: d.id,
    displayName: d.displayName,
    status: d.status,
    transport: d.transport,
    authType: d.authType,
    toolCount: d.toolCount,
    approvedToolCount: d.approvedToolCount,
    changedToolCount: d.changedToolCount,
    bindings: d.bindings,
    lastError: d.lastError,
    updatedAt: d.updatedAt,
    badges: d.badges,
  };
}

export function makeAuditEntry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 1,
    ts: NOW,
    agent: 'claude',
    job_id: 'job-1',
    server_id: 'fish-audio',
    method: 'tools/call',
    tool: 'text_to_speech',
    outcome: 'ok',
    error_code: null,
    duration_ms: 1200,
    req_bytes: 120,
    res_bytes: 2048,
    args_sha256: null,
    protocol_version: '2026-07-28',
    error: null,
    ...over,
  };
}

export function makeEvent(over: Partial<EventRecord> = {}): EventRecord {
  return { id: 1, ts: NOW, kind: 'server.created', server_id: 'fish-audio', agent: null, actor: 'user', details_json: null, ...over };
}

export function syncOutcomes(status: SyncStatus, result?: SyncResult): Record<Agent, SyncOutcome> {
  const one = (): SyncOutcome => ({ status, at: NOW, ...(result ? { result } : {}) });
  return { claude: one(), codex: one(), gemini: one() };
}

export const FAKE_HUB_CONFIG: HubConfig = {
  publicUrl: 'https://omni.example',
  hubHost: '127.0.0.1',
  hubPort: 7410,
  dataDir: '/tmp/omnicode-api-test',
  agentdSocket: '/tmp/omnicode-api-test/agentd.sock',
  secretsPrefix: 'omnicode',
  secretsBackend: 'memory',
  callTimeoutMs: 600_000,
  idleTimeoutMs: 300_000,
  allowPrivateHosts: [],
  allowHttpLoopback: false,
  auditRetentionDays: 30,
  eventRetentionDays: 180,
  agentTokenGraceMs: 900_000,
  healthIntervalMs: 600_000,
  forwardLogMessages: true,
  cimdEnabled: true,
  presetsDir: '/tmp/omnicode-api-test/presets',
  version: '0.1.0-test',
};

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export class FakeHub implements Hub {
  readonly config: HubConfig = { ...FAKE_HUB_CONFIG };
  /** API는 registry를 직접 쓰지 않는다 */
  readonly registry = {} as Registry;
  readonly masker: Masker = createMasker();
  readonly logger = pino({ level: 'silent' });
  readonly calls: RecordedCall[] = [];
  readonly store = new Map<string, ServerDetail>();
  /** DELETE 결과 (9.4: 진행 중이면 deleting, 끝났으면 deleted) */
  deleteStatus: DeleteResult['status'] = 'deleting';
  callbackResult: OAuthCallbackResult = { ok: true, serverId: 'fish-audio' };
  started = 0;
  stopped = 0;
  private readonly failures = new Map<string, Error>();
  private seq = 0;

  seed(detail: ServerDetail): ServerDetail {
    this.store.set(detail.id, detail);
    return detail;
  }

  /** 다음 `method` 호출을 `err`로 실패시킨다 (한 번만) */
  failWith(method: string, err: Error): void {
    this.failures.set(method, err);
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  private hit(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const err = this.failures.get(method);
    if (err) {
      this.failures.delete(method);
      throw err;
    }
  }

  private must(id: string): ServerDetail {
    const d = this.store.get(id);
    if (!d) throw new NotFoundError(`server ${id}`);
    return d;
  }

  readonly servers: HubServers = {
    list: () => {
      this.hit('servers.list');
      return [...this.store.values()].map(toSummary);
    },
    get: async (id) => {
      this.hit('servers.get', id);
      return this.store.get(id);
    },
    create: async (input) => {
      this.hit('servers.create', input);
      const id = input.id ?? `srv-${++this.seq}`;
      if (this.store.has(id)) throw new ApiError('conflict', `이미 있는 id입니다: ${id}`, { id });
      return this.seed(
        makeDetail({
          id,
          displayName: input.displayName ?? id,
          source: input.source,
          presetId: input.presetId ?? null,
          url: input.url ?? null,
        }),
      );
    },
    patch: async (id, patch) => {
      this.hit('servers.patch', id, patch);
      const d = this.must(id);
      const bindings: BindingsView = { ...d.bindings };
      for (const agent of AGENTS) {
        const enabled = patch.bindings?.[agent];
        if (enabled !== undefined) bindings[agent] = { ...bindings[agent], enabled };
      }
      return this.seed({
        ...d,
        displayName: patch.displayName ?? d.displayName,
        status: patch.enabled === undefined ? d.status : patch.enabled ? 'active' : 'disabled',
        callTimeoutMs: patch.callTimeoutMs ?? d.callTimeoutMs,
        cliAutoApprove: patch.cliAutoApprove ?? d.cliAutoApprove,
        bindings,
      });
    },
    approve: async (id, body) => {
      this.hit('servers.approve', id, body);
      const d = this.must(id);
      this.seed({ ...d, status: 'active', approvedToolCount: body.tools.length });
      return { status: 'active', approved: body.tools.map((t) => t.name), sync: syncOutcomes('synced') };
    },
    probe: async (id) => {
      this.hit('servers.probe', id);
      return this.seed({ ...this.must(id), lastProbeAt: NOW });
    },
    test: async (id) => {
      this.hit('servers.test', id);
      const d = this.must(id);
      return { ok: true, latencyMs: 12, error: null, protocol: d.protocol };
    },
    delete: async (id, opts) => {
      this.hit('servers.delete', id, opts);
      this.must(id);
      const done = this.deleteStatus === 'deleted';
      if (done) this.store.delete(id);
      return {
        status: this.deleteStatus,
        steps: [
          { step: 'block', ok: true },
          done ? { step: 'sync', ok: true } : { step: 'sync', ok: false, error: 'agentd: codex sync failed' },
        ],
      };
    },
    setCredentials: async (id, headerName, value) => {
      this.hit('servers.setCredentials', id, headerName, value);
      const d = this.must(id);
      this.masker.add(value);
      this.seed({ ...d, authType: 'header', auth: { ...d.auth, type: 'header', headerName } });
    },
  };

  readonly oauth: OAuthManager = {
    prepare: async (serverId) => {
      this.hit('oauth.prepare', serverId);
      this.must(serverId);
      return { issuer: 'https://auth.example', clientMode: 'cimd', scope: null, needsClientInput: false };
    },
    start: async (serverId, opts) => {
      this.hit('oauth.start', serverId, opts);
      this.must(serverId);
      return { authorizationUrl: 'https://auth.example/authorize?client_id=x&state=abc', expiresAt: '2026-10-07T08:20:00.000Z' };
    },
    handleCallback: async (params) => {
      this.hit('oauth.handleCallback', params);
      return this.callbackResult;
    },
    setPreregisteredClient: async (serverId, clientId, clientSecret) => {
      this.hit('oauth.setPreregisteredClient', serverId, clientId, clientSecret);
      const d = this.must(serverId);
      if (clientSecret) this.masker.add(clientSecret);
      this.seed({ ...d, auth: { ...d.auth, clientMode: 'preregistered', needsClientInput: false } });
    },
    headersFor: async () => ({}),
    onUnauthorized: async () => 'needs_auth',
    onInsufficientScope: async () => {},
    revoke: async () => {},
    expiresAt: async () => null,
  };

  readonly sync: HubSync = {
    all: async () => {
      this.hit('sync.all');
      return syncOutcomes('synced');
    },
    plan: async () => {
      this.hit('sync.plan');
      return syncOutcomes('pending', { added: ['omni-fish-audio'], updated: [], removed: [], unchanged: [] });
    },
    server: async (id) => {
      this.hit('sync.server', id);
      this.must(id);
      return syncOutcomes('synced');
    },
  };

  readonly tokens: HubTokens = {
    rotate: async (agents) => {
      this.hit('tokens.rotate', agents);
      return { rotatedAt: NOW, graceUntil: GRACE_UNTIL };
    },
    authenticate: () => null,
  };

  audit(q: AuditQuery): AuditPage {
    this.hit('audit', q);
    return { items: [makeAuditEntry()], nextCursor: null };
  }

  events(q: { serverId?: string; agent?: Agent; since?: string; cursor?: number; limit?: number }): EventPage {
    this.hit('events', q);
    return { items: [makeEvent()], nextCursor: null };
  }

  presets(): Preset[] {
    this.hit('presets');
    return [PRESET];
  }

  async status(): Promise<HubStatus> {
    this.hit('status');
    return {
      version: this.config.version,
      uptimeSec: 42,
      hub: { host: '127.0.0.1', port: 7410 },
      downstreamSessions: { legacy: 1, modern: 2 },
      agentd: { ok: true, version: '0.1.0', cli: { claude: '2.0.0', codex: null, gemini: '0.9.0' } },
      lastSync: { claude: null, codex: null, gemini: null },
      allowPrivateHosts: [],
      allowHttpLoopback: false,
      tokens: {
        claude: { rotatedAt: null, graceUntil: null },
        codex: { rotatedAt: null, graceUntil: null },
        gemini: { rotatedAt: null, graceUntil: null },
      },
    };
  }

  async start(): Promise<void> {
    this.started++;
  }

  async stop(): Promise<void> {
    this.stopped++;
  }
}
