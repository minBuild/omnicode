/**
 * 조립 통합 테스트: createHub ↔ 가짜 legacy 업스트림 ↔ SDK 클라이언트(에이전트 역할).
 * 흐름: 추가 → pending_approval → 승인 → 동기화 → 에이전트 호출 → 감사 로그 → 끄기 → 삭제.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMasker, type Agent, type AgentdStatus, type DesiredAgentConfig, type SyncResult } from '@omnicode/shared';
import { createHub } from '../src/hub.js';
import type { AgentdClient, Hub, HubConfig, HubTokensSecret } from '../src/contracts.js';
import { openRegistry } from '../src/registry/index.js';
import { createMemorySecretStore } from '../src/secrets/index.js';
import { createLogger } from '../src/logger.js';
import { startLegacyFixture, type LegacyFixture } from './fixtures/upstream-legacy.js';

function fakeAgentd(): AgentdClient & { applied: Array<[Agent, DesiredAgentConfig]>; tokens: Partial<Record<Agent, string>> } {
  const applied: Array<[Agent, DesiredAgentConfig]> = [];
  const tokens: Partial<Record<Agent, string>> = {};
  const ok = (d: DesiredAgentConfig): SyncResult => ({ added: d.entries.map((e) => e.name), updated: [], removed: [], unchanged: [] });
  return {
    applied,
    tokens,
    syncPlan: async (_a, d) => ok(d),
    syncApply: async (a, d) => {
      applied.push([a, d]);
      return ok(d);
    },
    writeToken: async (a, t) => void (tokens[a] = t),
    status: async (): Promise<AgentdStatus> => ({ version: 'fake', home: '/tmp', cli: { claude: '2.1', codex: null, gemini: null }, lastSync: { claude: null, codex: null, gemini: null } }),
  };
}

describe('hub integration (legacy upstream)', () => {
  let fixture: LegacyFixture;
  let hub: Hub;
  let agentd: ReturnType<typeof fakeAgentd>;
  let port: number;
  let tokens: HubTokensSecret;
  const secrets = createMemorySecretStore();
  const masker = createMasker();

  beforeAll(async () => {
    fixture = await startLegacyFixture();
    agentd = fakeAgentd();
    const config: HubConfig = {
      publicUrl: 'https://omni.example',
      hubHost: '127.0.0.1',
      hubPort: 0,
      dataDir: '/tmp/unused',
      agentdSocket: '/tmp/unused.sock',
      secretsPrefix: 'omnicode',
      secretsBackend: 'memory',
      callTimeoutMs: 10_000,
      idleTimeoutMs: 5_000,
      allowPrivateHosts: [],
      allowHttpLoopback: true,
      auditRetentionDays: 30,
      eventRetentionDays: 180,
      agentTokenGraceMs: 60_000,
      healthIntervalMs: 600_000,
      forwardLogMessages: true,
      cimdEnabled: true,
      registryUrl: null,
      presetsDir: new URL('../../../presets', import.meta.url).pathname,
      version: 'test',
    };
    hub = await createHub({
      config,
      deps: { registry: openRegistry(':memory:'), secrets, masker, agentd, port: 0, logger: createLogger(masker, { level: 'silent' }) },
    });
    await hub.start();
    port = (await hub.status()).hub.port;
    tokens = (await secrets.get<HubTokensSecret>('omnicode/hub-tokens'))!;
  });

  afterAll(async () => {
    await hub.stop();
    await fixture.close();
  });

  const agentClient = async (id: string, agent: Agent) => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${id}`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens[agent]}`, 'X-OmniCode-Job': 'job-1' } },
    });
    const client = new Client({ name: 'claude-code-test', version: '0' });
    await client.connect(transport);
    return { client, transport };
  };

  it('adds a server, approves its tools, syncs agents, and serves calls through the hub', async () => {
    const created = await hub.servers.create({ source: 'url', url: fixture.url, id: 'fake-legacy', displayName: 'Fake' });
    expect(created.status).toBe('pending_approval');
    expect(created.protocol.era).toBe('legacy');
    expect(created.tools.map((t) => t.name).sort()).toEqual(['echo', 'fail', 'slow']);
    expect(created.tools.every((t) => t.pendingApproval)).toBe(true);
    expect(hub.presets().some((p) => p.id === 'fish-audio')).toBe(true);

    // 승인 전에는 에이전트에게 아무것도 보이지 않고 호출은 -32011
    const early = await agentClient('fake-legacy', 'claude');
    expect((await early.client.listTools()).tools).toEqual([]);
    await expect(early.client.callTool({ name: 'echo', arguments: { text: 'x' } })).rejects.toMatchObject({ code: -32011 });
    await early.transport.terminateSession();

    const approved = await hub.servers.approve('fake-legacy', {
      tools: created.tools.map((t) => ({ name: t.name, schemaHash: t.schemaHash, enabled: t.name !== 'fail' })),
      bindings: { claude: true, codex: true, gemini: false },
    });
    expect(approved.status).toBe('active');
    expect(approved.sync.claude.status).toBe('synced');
    const claudeDesired = agentd.applied.filter(([a]) => a === 'claude').at(-1)![1];
    expect(claudeDesired.entries.map((e) => e.name)).toEqual(['omni-fake-legacy']);
    expect(claudeDesired.entries[0]!.url).toBe(`http://127.0.0.1:0/mcp/fake-legacy`.replace(':0', `:${hub.config.hubPort}`));
    expect(agentd.applied.filter(([a]) => a === 'gemini').at(-1)![1].entries).toEqual([]);

    const { client, transport } = await agentClient('fake-legacy', 'claude');
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['echo', 'slow']);
    const res = await client.callTool({ name: 'echo', arguments: { text: 'hello' } });
    expect(JSON.stringify(res)).toContain('hello');
    await expect(client.callTool({ name: 'fail' })).rejects.toMatchObject({ code: -32011 });

    const audit = hub.audit({ limit: 10 });
    const ok = audit.items.find((a) => a.outcome === 'ok');
    expect(ok).toMatchObject({ agent: 'claude', server_id: 'fake-legacy', tool: 'echo', job_id: 'job-1', method: 'tools/call' });
    expect(audit.items.find((a) => a.outcome === 'blocked')?.error_code).toBe(-32011);

    // gemini 는 바인딩이 꺼져 있다
    const gem = await agentClient('fake-legacy', 'gemini');
    expect((await gem.client.listTools()).tools).toEqual([]);
    await expect(gem.client.callTool({ name: 'echo' })).rejects.toMatchObject({ code: -32018 });
    await gem.transport.terminateSession();

    // 끄기 → 라이브 세션은 빈 목록 + server_disabled
    const disabled = await hub.servers.patch('fake-legacy', { enabled: false });
    expect(disabled.status).toBe('disabled');
    expect((await client.listTools()).tools).toEqual([]);
    await expect(client.callTool({ name: 'echo' })).rejects.toMatchObject({ code: -32010 });
    const enabled = await hub.servers.patch('fake-legacy', { enabled: true });
    expect(enabled.status).toBe('active');
    expect((await client.listTools()).tools.length).toBe(2);
    await transport.terminateSession();

    const test = await hub.servers.test('fake-legacy');
    expect(test.ok).toBe(true);

    const del = await hub.servers.delete('fake-legacy');
    expect(del.status).toBe('deleted');
    expect(del.steps.every((s) => s.ok)).toBe(true);
    expect(await hub.servers.get('fake-legacy')).toBeUndefined();
    expect(hub.events({ limit: 50 }).items.some((e) => e.kind === 'server.deleted')).toBe(true);
  });

  it('marks a 401 upstream as needs_auth without crashing', async () => {
    fixture.setUnauthorized('Bearer resource_metadata="http://127.0.0.1:1/.well-known/oauth-protected-resource"');
    try {
      const d = await hub.servers.create({ source: 'url', url: fixture.url, id: 'needs-login' });
      expect(d.status).toBe('needs_auth');
      expect(d.authType).toBe('oauth');
      expect(d.lastError).not.toBeNull();
    } finally {
      fixture.setUnauthorized(null);
    }
  });

  it('rejects private and non-https urls at creation', async () => {
    await expect(hub.servers.create({ source: 'url', url: 'https://10.0.0.5/mcp' })).rejects.toMatchObject({ name: 'SsrfBlockedError' });
    await expect(hub.servers.create({ source: 'url', url: 'ftp://x.example/mcp' })).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('reports status and rotates tokens', async () => {
    const st = await hub.status();
    expect(st.agentd.ok).toBe(true);
    expect(st.downstreamSessions.legacy).toBe(0);
    const old = tokens.codex;
    const r = await hub.tokens.rotate(['codex']);
    expect(r.graceUntil > r.rotatedAt).toBe(true);
    expect(hub.tokens.authenticate(old)).toBe('codex');
    expect(agentd.tokens.codex).not.toBe(old);
    expect(hub.tokens.authenticate(agentd.tokens.codex!)).toBe('codex');
  });

  it('keeps in-flight calls alive when the upstream tool list changes (D8: refresh does not re-probe)', async () => {
    const created = await hub.servers.create({ source: 'url', url: fixture.url, id: 'keep-alive' });
    await hub.servers.approve('keep-alive', { tools: created.tools.map((t) => ({ name: t.name, schemaHash: t.schemaHash })), bindings: { claude: true } });
    const { client, transport } = await agentClient('keep-alive', 'claude');
    const before = fixture.count('initialize');
    const slow = client.callTool({ name: 'slow', arguments: { ms: 600, everyMs: 50 } });
    await new Promise((r) => setTimeout(r, 150));
    await fixture.emitListChanged('tools');
    const res = await slow;
    expect(JSON.stringify(res)).toContain('done');
    // 목록 갱신이 업스트림 세션을 새로 열지 않았다
    await new Promise((r) => setTimeout(r, 100));
    expect(fixture.count('initialize')).toBe(before);
    await transport.terminateSession();
    await hub.servers.delete('keep-alive');
  });

  it('adds a server from pasted JSON: picks an entry, stores the header only as a secret, refuses stdio (C2)', async () => {
    const json = JSON.stringify({
      mcpServers: {
        'My Remote': { type: 'http', url: fixture.url, headers: { 'X-Api-Key': 'pasted-key-0123456789' } },
        local: { command: 'npx', args: ['-y', 'some-server'] },
      },
    });
    await expect(hub.servers.create({ source: 'json', json })).rejects.toMatchObject({ code: 'validation_error', details: { entries: [{ name: 'My Remote' }, { name: 'local' }] } });
    await expect(hub.servers.create({ source: 'json', json, entry: 'local' })).rejects.toMatchObject({ code: 'unsupported_transport' });

    const before = fixture.requests.length;
    const created = await hub.servers.create({ source: 'json', json, entry: 'My Remote' });
    expect(created).toMatchObject({ id: 'my-remote', displayName: 'My Remote', status: 'pending_approval', authType: 'header' });
    expect(created.auth.headerName).toBe('X-Api-Key');
    const secret = await secrets.get<{ type: string; value: string }>('omnicode/mcp/my-remote');
    expect(secret).toMatchObject({ type: 'header', value: 'pasted-key-0123456789' });
    // 업스트림 요청에 실렸고, 이벤트·상세 응답에는 없다
    expect(fixture.requests.slice(before).some((r) => r.headers['x-api-key'] === 'pasted-key-0123456789')).toBe(true);
    expect(JSON.stringify(hub.events({ limit: 50 }))).not.toContain('pasted-key-0123456789');
    expect(JSON.stringify(created)).not.toContain('pasted-key-0123456789');
    expect(masker.mask('x pasted-key-0123456789 y')).toBe('x *** y');
    await hub.servers.delete('my-remote');
  });

  it('pasted JSON with a ${VAR} placeholder waits for the key instead of probing (C2)', async () => {
    const json = JSON.stringify({ mcpServers: { needkey: { url: fixture.url, headers: { Authorization: 'Bearer ${MY_TOKEN}' } } } });
    const created = await hub.servers.create({ source: 'json', json });
    expect(created).toMatchObject({ id: 'needkey', status: 'needs_auth', authType: 'header' });
    expect(created.auth.headerName).toBe('Authorization');
    expect(await secrets.get('omnicode/mcp/needkey')).toBeUndefined();
    await hub.servers.delete('needkey');
  });
});
