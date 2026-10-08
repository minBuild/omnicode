import { afterEach, describe, expect, it } from 'vitest';
import { LegacyConnector } from '../../src/upstream/index.js';
import { startLegacyFixture, type LegacyFixture } from '../fixtures/upstream-legacy.js';
import { baseOpts, delay, expectUpstreamError, makeCtx, waitFor } from './helpers.js';

describe('LegacyConnector', () => {
  let f: LegacyFixture | undefined;
  let c: LegacyConnector | undefined;
  afterEach(async () => {
    await c?.close();
    c = undefined;
    await f?.close();
    f = undefined;
  });

  it('lists tools across pages and normalizes definitions', async () => {
    f = await startLegacyFixture({ pageSize: 2 });
    c = new LegacyConnector(baseOpts(f.url));
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo', 'slow', 'fail']);
    expect(f.count('tools/list')).toBe(2);
    expect(tools[0]).toEqual({
      name: 'echo',
      description: 'echoes text',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    });
    expect(c.protocolVersion).toBe('2025-11-25');
    expect(c.serverInfo).toMatchObject({ name: 'legacy-fixture' });
  });

  it('calls a tool and returns the raw result (isError results are not thrown)', async () => {
    f = await startLegacyFixture();
    c = new LegacyConnector(baseOpts(f.url));
    const ok = await c.callTool({ name: 'echo', arguments: { text: 'hi' } }, makeCtx());
    expect(ok.content).toEqual([{ type: 'text', text: 'echo:hi' }]);
    const failed = await c.callTool({ name: 'fail' }, makeCtx());
    expect(failed.isError).toBe(true);
  });

  it('maps upstream JSON-RPC errors to UpstreamError(protocol) with the rpc preserved', async () => {
    f = await startLegacyFixture();
    c = new LegacyConnector(baseOpts(f.url));
    const err = await expectUpstreamError(c.forward('prompts/list', {}, makeCtx()), 'protocol');
    expect(err.info.rpc?.code).toBe(-32601);
    // forward is idempotent but protocol errors are not retried
    expect(f.count('prompts/list')).toBe(1);
  });

  it('forwards progress with the downstream token', async () => {
    f = await startLegacyFixture();
    c = new LegacyConnector(baseOpts(f.url));
    const ctx = makeCtx({ idleTimeoutMs: 300 });
    const result = await c.callTool({ name: 'slow', arguments: { ms: 600, everyMs: 100 }, _meta: { progressToken: 'dl-1' } }, ctx);
    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
    expect(ctx.progress.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ctx.progress.map((p) => p.progressToken))).toEqual(new Set(['dl-1']));
    expect(ctx.progress[0]).toMatchObject({ progress: 1, total: 6, message: 'tick 1' });
  });

  it('does not forward progress when the downstream sent no token', async () => {
    f = await startLegacyFixture();
    c = new LegacyConnector(baseOpts(f.url));
    const ctx = makeCtx();
    await c.callTool({ name: 'slow', arguments: { ms: 300, everyMs: 100 } }, ctx);
    expect(ctx.progress).toEqual([]);
  });

  it('maps the idle timeout to UpstreamError(timeout) and cancels upstream', async () => {
    f = await startLegacyFixture();
    c = new LegacyConnector(baseOpts(f.url));
    const ctx = makeCtx({ idleTimeoutMs: 300, timeoutMs: 5_000 });
    const started = Date.now();
    await expectUpstreamError(c.callTool({ name: 'slow', arguments: { ms: 3_000, progress: false }, _meta: { progressToken: 't' } }, ctx), 'timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
    await waitFor(() => (f as LegacyFixture).count('notifications/cancelled') >= 1, 2_000, 'notifications/cancelled');
  });

  it('maps the total timeout to UpstreamError(timeout) even while progress keeps arriving', async () => {
    f = await startLegacyFixture();
    c = new LegacyConnector(baseOpts(f.url));
    const ctx = makeCtx({ idleTimeoutMs: 2_000, timeoutMs: 400 });
    const started = Date.now();
    await expectUpstreamError(c.callTool({ name: 'slow', arguments: { ms: 3_000, everyMs: 50 }, _meta: { progressToken: 't' } }, ctx), 'timeout');
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('401: calls onUnauthorized once and retries exactly once on "retry"', async () => {
    f = await startLegacyFixture();
    const fx = f;
    const seen: Array<string | undefined> = [];
    c = new LegacyConnector(
      baseOpts(f.url, {
        onUnauthorized: async (www) => {
          seen.push(www);
          fx.setUnauthorized(null);
          return 'retry';
        },
      }),
    );
    await c.connect();
    await waitFor(() => (f as LegacyFixture).streamCount() >= 1, 3_000, 'GET stream');
    f.setUnauthorized('Bearer realm="up", error="invalid_token"');
    const result = await c.callTool({ name: 'echo', arguments: { text: 'x' } }, makeCtx());
    expect(result.content).toEqual([{ type: 'text', text: 'echo:x' }]);
    expect(seen).toEqual(['Bearer realm="up", error="invalid_token"']);
    expect(f.unauthorizedHits).toBe(1);
    expect(f.count('tools/call')).toBe(2);
  });

  it('401: throws unauthorized when onUnauthorized answers needs_auth', async () => {
    f = await startLegacyFixture();
    let calls = 0;
    c = new LegacyConnector(baseOpts(f.url, { onUnauthorized: async () => (calls++, 'needs_auth') }));
    await c.connect();
    await waitFor(() => (f as LegacyFixture).streamCount() >= 1, 3_000, 'GET stream');
    f.setUnauthorized('Bearer realm="up"');
    const err = await expectUpstreamError(c.callTool({ name: 'echo', arguments: { text: 'x' } }, makeCtx()), 'unauthorized');
    expect(err.info.wwwAuthenticate).toBe('Bearer realm="up"');
    expect(calls).toBe(1);
    expect(f.unauthorizedHits).toBe(1);
  });

  it('401: retries only once even if the retry is 401 again', async () => {
    f = await startLegacyFixture();
    let calls = 0;
    c = new LegacyConnector(baseOpts(f.url, { onUnauthorized: async () => (calls++, 'retry') }));
    await c.connect();
    await waitFor(() => (f as LegacyFixture).streamCount() >= 1, 3_000, 'GET stream');
    f.setUnauthorized('Bearer realm="up"');
    await expectUpstreamError(c.callTool({ name: 'echo', arguments: { text: 'x' } }, makeCtx()), 'unauthorized');
    expect(calls).toBe(1);
    expect(f.unauthorizedHits).toBe(2);
  });

  it('401 without onUnauthorized throws immediately; 403 insufficient_scope carries the scope', async () => {
    f = await startLegacyFixture();
    c = new LegacyConnector(baseOpts(f.url));
    await c.connect();
    await waitFor(() => (f as LegacyFixture).streamCount() >= 1, 3_000, 'GET stream');
    f.setUnauthorized('Bearer realm="up"');
    await expectUpstreamError(c.listTools(), 'unauthorized');
    expect(f.unauthorizedHits).toBe(1);
    f.setUnauthorized('Bearer error="insufficient_scope", scope="read write"', 403);
    const err = await expectUpstreamError(c.callTool({ name: 'echo', arguments: { text: 'x' } }, makeCtx()), 'insufficient_scope');
    expect(err.info.scope).toBe('read write');
  });

  it('re-initializes on 404 and retries listTools, but never retries callTool', async () => {
    f = await startLegacyFixture();
    c = new LegacyConnector(baseOpts(f.url));
    await c.connect();
    expect(f.count('initialize')).toBe(1);

    await f.dropSessions();
    const tools = await c.listTools();
    expect(tools).toHaveLength(3);
    expect(f.count('initialize')).toBe(2);
    expect(f.count('tools/list')).toBe(2); // 404 + retry

    await f.dropSessions();
    const err = await expectUpstreamError(c.callTool({ name: 'echo', arguments: { text: 'x' } }, makeCtx()), 'unavailable');
    expect(err.info.status).toBe(404);
    expect(f.count('initialize')).toBe(3);
    expect(f.count('tools/call')).toBe(1); // not retried

    const again = await c.callTool({ name: 'echo', arguments: { text: 'y' } }, makeCtx());
    expect(again.content).toEqual([{ type: 'text', text: 'echo:y' }]);
    expect(f.count('tools/call')).toBe(2);
    expect(f.count('initialize')).toBe(3);
  });

  it('delivers list_changed notifications from the GET stream', async () => {
    f = await startLegacyFixture();
    c = new LegacyConnector(baseOpts(f.url));
    const kinds: string[] = [];
    c.onListChanged((k) => kinds.push(k));
    await c.connect();
    await waitFor(() => (f as LegacyFixture).streamCount() >= 1, 3_000, 'GET stream');
    await delay(50);
    await f.emitListChanged('tools');
    await f.emitListChanged('prompts');
    await f.emitListChanged('resources');
    await waitFor(() => kinds.length >= 3, 3_000, 'list_changed notifications');
    expect(kinds).toEqual(['tools', 'prompts', 'resources']);
  });

  it('answers server-initiated requests with -32601', async () => {
    f = await startLegacyFixture();
    c = new LegacyConnector(baseOpts(f.url));
    await c.connect();
    await waitFor(() => (f as LegacyFixture).streamCount() >= 1, 3_000, 'GET stream');
    await delay(50);
    await expect(f.requestRoots()).rejects.toMatchObject({ code: -32601 });
  });

  it('cancels the upstream call when ctx.signal aborts', async () => {
    f = await startLegacyFixture();
    c = new LegacyConnector(baseOpts(f.url));
    const ac = new AbortController();
    const ctx = makeCtx({ signal: ac.signal });
    const p = c.callTool({ name: 'slow', arguments: { ms: 3_000, everyMs: 100 }, _meta: { progressToken: 't' } }, ctx);
    setTimeout(() => ac.abort(), 200);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => (f as LegacyFixture).cancelledCalls >= 1, 2_000, 'upstream cancellation');
  });

  it('re-evaluates headers() on every request and sends the Hub User-Agent', async () => {
    f = await startLegacyFixture();
    let n = 0;
    c = new LegacyConnector(baseOpts(f.url, { headers: async () => ({ authorization: `Bearer t${++n}` }) }));
    await c.connect();
    await c.listTools();
    const init = f.requests.find((r) => r.rpcMethod === 'initialize');
    const list = f.requests.find((r) => r.rpcMethod === 'tools/list');
    expect(init?.headers.authorization).toBe('Bearer t1');
    expect(list?.headers.authorization).toMatch(/^Bearer t\d+$/);
    expect(list?.headers.authorization).not.toBe('Bearer t1');
    expect(f.requests.every((r) => r.headers['user-agent']?.startsWith('OmniCode-Hub/'))).toBe(true);
    expect(list?.headers['mcp-protocol-version']).toBe('2025-11-25');
  });

  it('terminates the session on close(), fires onClose and rejects afterwards', async () => {
    f = await startLegacyFixture();
    c = new LegacyConnector(baseOpts(f.url));
    const reasons: Array<string | undefined> = [];
    c.onClose((r) => reasons.push(r));
    await c.connect();
    expect(f.sessionIds()).toHaveLength(1);
    await c.close();
    expect(reasons).toEqual(['closed']);
    expect(f.requests.some((r) => r.method === 'DELETE')).toBe(true);
    await expectUpstreamError(c.listTools(), 'unavailable');
    c = undefined;
  });
});
