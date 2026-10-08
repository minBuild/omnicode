import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMasker, type Agent, type AuditEntry, type BindingRecord, type ServerRecord, type ToolRecord } from '@omnicode/shared';
import { UpstreamError, type CallContext, type HubConfig, type Registry, type UpstreamConnector } from '../../src/contracts.js';
import { createDownstreamServer, type DownstreamServer } from '../../src/downstream/server.js';
import type { DownstreamDeps } from '../../src/downstream/deps.js';

const TOKENS: Record<Agent, string> = { claude: 'omh_claude_token_000000000000000000000000000', codex: 'omh_codex_token_0000000000000000000000000000', gemini: 'omh_gemini_token_000000000000000000000000000' };

function mkServer(status: ServerRecord['status']): ServerRecord {
  return {
    id: 'fish', display_name: 'Fish Audio', source: 'url', preset_id: null, transport: 'streamable_http', url: 'https://x/mcp', canonical_url: null,
    command: null, args_json: null, env_keys_json: null, auth_type: 'none', header_name: null, secret_ref: null, oauth_issuer: null, oauth_client_mode: null,
    oauth_prm_url: null, requested_scope: null, granted_scope: null, protocol_era: 'legacy', protocol_version: '2025-06-18', server_info_json: null,
    capabilities_json: null, call_timeout_ms: 5000, cli_auto_approve: 1, status, last_error: null, last_probe_at: null, tools_synced_at: null, created_at: 't', updated_at: 't',
  };
}
function mkTool(name: string, approved = true): ToolRecord {
  const def = { name, description: `${name} tool`, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };
  return { server_id: 'fish', name, title: null, description: def.description, definition_json: JSON.stringify(def), schema_hash: 'h1', approved_hash: approved ? 'h1' : null, approved_definition_json: null, approved_at: null, annotations_json: null, enabled: 1, first_seen_at: 't', last_seen_at: 't' };
}

function fakeConnector(): UpstreamConnector & { calls: Array<{ name: string; ctx: CallContext }>; listChanged: Array<(k: 'tools' | 'prompts' | 'resources') => void> } {
  const calls: Array<{ name: string; ctx: CallContext }> = [];
  const listChanged: Array<(k: 'tools' | 'prompts' | 'resources') => void> = [];
  return {
    serverId: 'fish', era: 'legacy', protocolVersion: '2025-06-18', transport: 'streamable_http', serverInfo: { name: 'fake', version: '1' }, capabilities: { tools: {}, prompts: {} },
    calls, listChanged,
    connect: async () => ({ era: 'legacy', protocolVersion: '2025-06-18', transport: 'streamable_http', serverInfo: null, capabilities: null }),
    listTools: async () => [],
    callTool: async (params, ctx) => {
      calls.push({ name: params.name, ctx });
      if (params.name === 'slow') {
        for (let i = 1; i <= 3; i++) {
          await new Promise((r) => setTimeout(r, 30));
          ctx.onProgress({ progressToken: 'x', progress: i, total: 3, message: `step ${i}` });
        }
      }
      if (params.name === 'boom') throw new UpstreamError('timeout', 'took too long');
      if (params.name === 'auth') throw new UpstreamError('unauthorized', 'nope');
      return { content: [{ type: 'text', text: `echo:${JSON.stringify(params.arguments ?? {})}:job=${ctx.jobId ?? '-'}:params=${JSON.stringify(ctx.mcpParamHeaders)}` }] };
    },
    forward: async (method) => (method === 'prompts/list' ? { prompts: [{ name: 'p1' }] } : {}),
    onListChanged: (cb) => { listChanged.push(cb); return () => undefined; },
    onClose: () => () => undefined,
    close: async () => undefined,
  };
}

interface World { srv: DownstreamServer; port: number; records: { server: ServerRecord; tools: ToolRecord[]; bindings: BindingRecord[] }; audit: Omit<AuditEntry, 'id'>[]; connector: ReturnType<typeof fakeConnector>; errors: UpstreamError[]; }

async function world(status: ServerRecord['status'] = 'active'): Promise<World> {
  const records = { server: mkServer(status), tools: [mkTool('echo'), mkTool('slow'), mkTool('boom'), mkTool('auth'), mkTool('pending', false)], bindings: [{ server_id: 'fish', agent: 'claude', enabled: 1, sync_status: null, synced_at: null, last_error: null } as BindingRecord] };
  const registry = {
    servers: { get: (id: string) => (id === 'fish' ? records.server : undefined) },
    tools: { listByServer: () => records.tools },
    bindings: { get: (_s: string, a: Agent) => records.bindings.find((b) => b.agent === a) },
  } as unknown as Registry;
  const audit: Omit<AuditEntry, 'id'>[] = [];
  const connector = fakeConnector();
  const errors: UpstreamError[] = [];
  const deps: DownstreamDeps = {
    config: { hubHost: '127.0.0.1', hubPort: 0, idleTimeoutMs: 1000, version: 'test' } as HubConfig,
    registry,
    tokens: { authenticate: (t: string) => (Object.entries(TOKENS).find(([, v]) => v === t)?.[0] as Agent | undefined) ?? null, rotate: async () => ({ rotatedAt: '', graceUntil: '' }) },
    connectors: { get: async () => connector, peek: () => connector },
    hooks: { onUpstreamError: async (_id, e) => void errors.push(e), onUpstreamOk: async () => undefined },
    audit: { record: (e) => void audit.push(e) },
    masker: createMasker(),
    logger: { info() {}, warn() {}, error: (...a: unknown[]) => { if (process.env.DEBUG_DOWNSTREAM) console.error(...a); }, debug() {} } as unknown as DownstreamDeps['logger'],
  };
  const srv = createDownstreamServer(deps, { port: 0 });
  const { port } = await srv.start();
  return { srv, port, records, audit, connector, errors };
}

async function connect(port: number, token: string, extraHeaders: Record<string, string> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/fish`), { requestInit: { headers: { Authorization: `Bearer ${token}`, ...extraHeaders } } });
  const client = new Client({ name: 'test-agent', version: '0' });
  await client.connect(transport);
  return { client, transport };
}

describe('downstream server', () => {
  let w: World;
  beforeEach(async () => { w = await world(); });
  afterEach(async () => { await w.srv.stop(); });

  it('rejects missing/invalid tokens, bad origin and modern protocol versions', async () => {
    const base = `http://127.0.0.1:${w.port}/mcp/fish`;
    const noTok = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(noTok.status).toBe(401);
    expect(noTok.headers.get('www-authenticate')).toContain('omnicode-hub');
    const badOrigin = await fetch(base, { method: 'POST', headers: { authorization: `Bearer ${TOKENS.claude}`, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(badOrigin.status).toBe(403);
    const modern = await fetch(base, { method: 'POST', headers: { authorization: `Bearer ${TOKENS.claude}`, 'mcp-protocol-version': '2026-07-28', 'content-type': 'application/json' }, body: '{}' });
    expect(modern.status).toBe(400);
    const body = (await modern.json()) as { error: { code: number; data: { supported: string[] } } };
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toContain('2025-11-25');
    const unknown = await fetch(`http://127.0.0.1:${w.port}/mcp/nope`, { method: 'POST', headers: { authorization: `Bearer ${TOKENS.claude}` }, body: '{}' });
    expect(unknown.status).toBe(404);
    const health = await fetch(`http://127.0.0.1:${w.port}/healthz`);
    expect((await health.json()).ok).toBe(true);
  });

  it('serves approved tools to a bound agent and forwards calls with job id and Mcp-Param headers', async () => {
    const { client, transport } = await connect(w.port, TOKENS.claude, { 'X-OmniCode-Job': 'job-42', 'Mcp-Param-Region': 'us-west1' });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['auth', 'boom', 'echo', 'slow']);
    const res = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('echo:{"text":"hi"}');
    expect(text).toContain('job=job-42');
    expect(text).toContain('mcp-param-region');
    expect(w.audit.at(-1)).toMatchObject({ agent: 'claude', server_id: 'fish', tool: 'echo', outcome: 'ok', job_id: 'job-42', method: 'tools/call' });
    expect(w.audit.at(-1)?.args_sha256).toMatch(/^[0-9a-f]{64}$/);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(['p1']);
    await transport.terminateSession();
    expect(w.srv.sessionCounts().legacy).toBe(0);
  });

  it('blocks unbound agents, unapproved tools, and maps upstream errors to 11.9 codes', async () => {
    const codex = await connect(w.port, TOKENS.codex);
    expect((await codex.client.listTools()).tools).toEqual([]);
    await expect(codex.client.callTool({ name: 'echo' })).rejects.toMatchObject({ code: -32018 });
    const claude = await connect(w.port, TOKENS.claude);
    await expect(claude.client.callTool({ name: 'pending' })).rejects.toMatchObject({ code: -32011 });
    await expect(claude.client.callTool({ name: 'boom' })).rejects.toMatchObject({ code: -32014 });
    await expect(claude.client.callTool({ name: 'auth' })).rejects.toMatchObject({ code: -32012 });
    expect(w.errors.map((e) => e.kind)).toEqual(['timeout', 'unauthorized']);
    expect(w.audit.filter((a) => a.outcome === 'blocked').length).toBe(2);
    expect(w.audit.filter((a) => a.outcome === 'error').length).toBe(2);
  });

  it('exposes nothing for a disabled server and returns server_disabled on call', async () => {
    w.records.server = mkServer('disabled');
    const { client } = await connect(w.port, TOKENS.claude);
    expect((await client.listTools()).tools).toEqual([]);
    await expect(client.callTool({ name: 'echo' })).rejects.toMatchObject({ code: -32010 });
  });

  it('forwards upstream progress to the downstream progress callback', async () => {
    const { client } = await connect(w.port, TOKENS.claude);
    const seen: number[] = [];
    await client.callTool({ name: 'slow' }, undefined, { onprogress: (p) => void seen.push(p.progress) });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('fans out tools/list_changed only to bound sessions', async () => {
    const claude = await connect(w.port, TOKENS.claude);
    const codex = await connect(w.port, TOKENS.codex);
    let claudeNotified = 0;
    let codexNotified = 0;
    claude.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void claudeNotified++);
    codex.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void codexNotified++);
    await new Promise((r) => setTimeout(r, 100)); // GET 스트림이 열릴 시간
    await w.srv.notifyListChanged('fish', 'tools');
    await new Promise((r) => setTimeout(r, 150));
    expect(claudeNotified).toBe(1);
    expect(codexNotified).toBe(0);
  });

  it('rejects a session id from another agent or server', async () => {
    const claude = await connect(w.port, TOKENS.claude);
    const sid = claude.transport.sessionId!;
    const r = await fetch(`http://127.0.0.1:${w.port}/mcp/fish`, { method: 'POST', headers: { authorization: `Bearer ${TOKENS.codex}`, 'mcp-session-id': sid, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(r.status).toBe(404);
  });
});
