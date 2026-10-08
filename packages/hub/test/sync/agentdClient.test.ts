import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentdUnavailableError } from '../../src/contracts.js';
import { AgentdRequestError, createAgentdClient } from '../../src/sync/agentdClient.js';

function fakeAgentd(handler: (req: Record<string, unknown>) => unknown | Promise<unknown>): { path: string; server: Server } {
  const dir = mkdtempSync(join(tmpdir(), 'omni-'));
  const path = join(dir, 'a.sock');
  const server = createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', async (c: string) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      buf = buf.slice(nl + 1);
      const out = await handler(req);
      if (out !== undefined) sock.write(JSON.stringify(out) + '\n');
    });
  });
  server.listen(path);
  return { path, server };
}

describe('agentd client', () => {
  let srv: Server | undefined;
  afterEach(() => srv?.close());

  it('round-trips a sync.apply and status', async () => {
    const f = fakeAgentd((req) =>
      req.op === 'status'
        ? { id: req.id, ok: true, result: { version: '0.1.0', home: '/h', cli: { claude: null, codex: null, gemini: null }, lastSync: {} } }
        : { id: req.id, ok: true, result: { added: ['omni-a'], updated: [], removed: [], unchanged: [] } },
    );
    srv = f.server;
    const c = createAgentdClient(f.path, { timeoutMs: 2000 });
    expect((await c.syncApply('claude', { entries: [] })).added).toEqual(['omni-a']);
    expect((await c.status()).version).toBe('0.1.0');
  });

  it('maps ok:false to AgentdRequestError and missing socket to AgentdUnavailableError', async () => {
    const f = fakeAgentd((req) => ({ id: req.id, ok: false, error: { code: 'adapter_error', message: 'boom' } }));
    srv = f.server;
    const c = createAgentdClient(f.path, { timeoutMs: 2000 });
    await expect(c.syncPlan('codex', { entries: [] })).rejects.toBeInstanceOf(AgentdRequestError);
    const missing = createAgentdClient(join(tmpdir(), 'nope', 'x.sock'), { timeoutMs: 2000 });
    await expect(missing.status()).rejects.toBeInstanceOf(AgentdUnavailableError);
  });

  it('times out when agentd never answers', async () => {
    const f = fakeAgentd(() => undefined);
    srv = f.server;
    const c = createAgentdClient(f.path, { timeoutMs: 200 });
    await expect(c.status()).rejects.toBeInstanceOf(AgentdUnavailableError);
  });
});
