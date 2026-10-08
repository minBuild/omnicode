import { afterEach, describe, expect, it } from 'vitest';
import {
  LISTEN_SUBSCRIPTIONS,
  ModernConnector,
  decodeMcpName,
  encodeMcpName,
  isPlainHeaderValue,
  parseWwwAuthenticate,
} from '../../src/upstream/index.js';
import { startModernFixture, type ModernFixture } from '../fixtures/upstream-modern.js';
import { baseOpts, expectUpstreamError, makeCtx, waitFor } from './helpers.js';

type AnyParams = { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };

describe('ModernConnector (2026-07-28)', () => {
  let f: ModernFixture | undefined;
  let c: ModernConnector | undefined;
  afterEach(async () => {
    await c?.close();
    c = undefined;
    await f?.close();
    f = undefined;
  });

  it('sends the required headers, Mcp-Param-* and _meta on tools/call', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url, { headers: async () => ({ authorization: 'Bearer up' }) }));
    const ctx = makeCtx({ mcpParamHeaders: { 'Mcp-Param-Region': 'kr', 'mcp-param-tenant': 'acme' } });
    const result = await c.callTool({ name: 'echo', arguments: { text: 'hi' }, _meta: { progressToken: 'dl-1', custom: 1 } }, ctx);
    expect(result).toEqual({ resultType: 'complete', content: [{ type: 'text', text: 'echo:hi' }] });

    const req = f.requests.find((r) => r.rpcMethod === 'tools/call');
    expect(req?.headers).toMatchObject({
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'echo',
      'mcp-param-region': 'kr',
      'mcp-param-tenant': 'acme',
      authorization: 'Bearer up',
    });
    expect(req?.headers['user-agent']).toMatch(/^OmniCode-Hub\//);
    expect(req?.mcpParams).toEqual({ 'mcp-param-region': 'kr', 'mcp-param-tenant': 'acme' });
    const params = req?.body?.params as Record<string, unknown>;
    expect(params.name).toBe('echo');
    expect(params.arguments).toEqual({ text: 'hi' });
    expect(params._meta).toEqual({
      progressToken: 'dl-1',
      custom: 1,
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'omnicode-hub', version: '0.1.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    });
    expect(f.count('server/discover')).toBe(1);
  });

  it('sends empty clientCapabilities for a legacy downstream and the given ones for a modern downstream', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url));
    await c.callTool({ name: 'echo' }, makeCtx({ downstreamEra: 'legacy', clientCapabilities: { elicitation: {} } }));
    await c.callTool({ name: 'echo' }, makeCtx({ downstreamEra: 'modern', clientCapabilities: { elicitation: {} } }));
    const metas = f.requests
      .filter((r) => r.rpcMethod === 'tools/call')
      .map((r) => (r.body?.params as { _meta: Record<string, unknown> })._meta['io.modelcontextprotocol/clientCapabilities']);
    expect(metas).toEqual([{}, { elicitation: {} }]);
  });

  it('base64-encodes Mcp-Name when the name is not plain printable ASCII', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url));
    const result = await c.callTool({ name: '한글 도구' }, makeCtx());
    expect(result).toMatchObject({ resultType: 'complete' });
    const req = f.requests.find((r) => r.rpcMethod === 'tools/call');
    const header = req?.headers['mcp-name'] ?? '';
    expect(header).toMatch(/^=\?base64\?[A-Za-z0-9+/=]+\?=$/);
    expect(decodeMcpName(header)).toBe('한글 도구');
    expect(encodeMcpName('plain-tool_v2')).toBe('plain-tool_v2');
    expect(encodeMcpName('=?looks?=')).toMatch(/^=\?base64\?/);
    expect(isPlainHeaderValue(' leading')).toBe(false);
    expect(isPlainHeaderValue('')).toBe(false);
  });

  it('uses the uri for resources/read and the name for prompts/get (forward)', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url));
    const read = await c.forward('resources/read', { uri: 'file:///tmp/a.txt' }, makeCtx());
    expect(read).toMatchObject({ resultType: 'complete', contents: [{ uri: 'file:///tmp/a.txt' }] });
    const prompt = await c.forward('prompts/get', { name: 'greet' }, makeCtx());
    expect(prompt).toMatchObject({ resultType: 'complete' });
    const list = await c.forward('prompts/list', undefined, makeCtx());
    expect(list).toMatchObject({ resultType: 'complete', prompts: [] });
    const headers = f.requests.filter((r) => r.rpcMethod !== 'server/discover' && r.rpcMethod !== 'subscriptions/listen').map((r) => [r.headers['mcp-method'], r.headers['mcp-name']]);
    expect(headers).toEqual([
      ['resources/read', 'file:///tmp/a.txt'],
      ['prompts/get', 'greet'],
      ['prompts/list', undefined],
    ]);
  });

  it('records discover results and lists tools across pages', async () => {
    f = await startModernFixture({ pageSize: 3 });
    c = new ModernConnector(baseOpts(f.url));
    const probe = await c.connect();
    expect(probe).toMatchObject({ era: 'modern', protocolVersion: '2026-07-28', serverInfo: { name: 'modern-fixture' } });
    expect(c.supportedVersions).toEqual(['2026-07-28']);
    expect(c.capabilities).toMatchObject({ prompts: { listChanged: true } });
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo', 'slow', 'resume', 'ask', 'big', 'fail', '한글 도구']);
    expect(tools[0]).toEqual({ name: 'echo', description: 'echoes text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } });
    expect(f.count('tools/list')).toBe(3);
    expect(f.requests.filter((r) => r.rpcMethod === 'tools/list').map((r) => (r.body?.params as { cursor?: string }).cursor)).toEqual([undefined, '3', '6']);
  });

  it('forwards SSE progress with the downstream token and resets the idle timer', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url));
    const ctx = makeCtx({ idleTimeoutMs: 300 });
    const result = await c.callTool({ name: 'slow', arguments: { ms: 600, everyMs: 100 }, _meta: { progressToken: 'dl-1' } }, ctx);
    expect(result).toMatchObject({ resultType: 'complete', content: [{ type: 'text', text: 'done' }] });
    expect(ctx.progress.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ctx.progress.map((p) => p.progressToken))).toEqual(new Set(['dl-1']));
    expect(ctx.progress[0]).toMatchObject({ progress: 1, total: 6, message: 'tick 1' });
  });

  it('asks upstream for progress even without a downstream token, but does not forward it', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url));
    const ctx = makeCtx();
    await c.callTool({ name: 'slow', arguments: { ms: 300, everyMs: 100 } }, ctx);
    expect(ctx.progress).toEqual([]);
    const req = f.requests.find((r) => r.rpcMethod === 'tools/call');
    const meta = (req?.body?.params as { _meta: Record<string, unknown> })._meta;
    expect(String(meta.progressToken)).toMatch(/^omnicode-hub:/);
  });

  it('maps the idle timeout to UpstreamError(timeout) and aborts the request', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url));
    const ctx = makeCtx({ idleTimeoutMs: 300, timeoutMs: 5_000 });
    const started = Date.now();
    await expectUpstreamError(c.callTool({ name: 'slow', arguments: { ms: 3_000, progress: false }, _meta: { progressToken: 't' } }, ctx), 'timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
    await waitFor(() => (f as ModernFixture).cancelledCalls >= 1, 2_000, 'upstream saw the abort');
  });

  it('maps the total timeout to UpstreamError(timeout) even while progress keeps arriving', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url));
    const ctx = makeCtx({ idleTimeoutMs: 2_000, timeoutMs: 400 });
    const started = Date.now();
    await expectUpstreamError(c.callTool({ name: 'slow', arguments: { ms: 3_000, everyMs: 50 }, _meta: { progressToken: 't' } }, ctx), 'timeout');
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('input_required without inputRequests: retries with requestState (legacy downstream)', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url));
    const result = await c.callTool({ name: 'resume', arguments: { steps: 2 } }, makeCtx({ downstreamEra: 'legacy' }));
    expect(result).toMatchObject({ resultType: 'complete', content: [{ type: 'text', text: 'resumed after 2' }] });
    const states = f.requests.filter((r) => r.rpcMethod === 'tools/call').map((r) => (r.body?.params as { requestState?: string }).requestState);
    expect(states).toEqual([undefined, 'step-1', 'step-2']);
  });

  it('input_required without inputRequests: gives up after 3 automatic retries', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url));
    await expectUpstreamError(c.callTool({ name: 'resume', arguments: { steps: 10 } }, makeCtx({ downstreamEra: 'legacy' })), 'input_required');
    expect(f.count('tools/call')).toBe(4);
  });

  it('input_required with inputRequests: error for a legacy downstream', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url));
    await expectUpstreamError(c.callTool({ name: 'ask' }, makeCtx({ downstreamEra: 'legacy' })), 'input_required');
    expect(f.count('tools/call')).toBe(1);
  });

  it('input_required with inputRequests: pass-through for a modern downstream, inputResponses forwarded verbatim', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url));
    const ctx = makeCtx({ downstreamEra: 'modern', clientCapabilities: { elicitation: {} } });
    const first = await c.callTool({ name: 'ask' }, ctx);
    expect(first).toMatchObject({ resultType: 'input_required', requestState: 'ask-1' });
    expect(first.inputRequests).toHaveLength(1);
    const inputResponses = [{ id: 'q1', action: 'accept', content: { name: 'Min' } }];
    const retry = { name: 'ask', inputResponses, requestState: 'ask-1' } as unknown as AnyParams;
    const second = await c.callTool(retry, ctx);
    expect(second).toMatchObject({ resultType: 'complete' });
    expect(f.inputResponsesSeen).toEqual([{ inputResponses, requestState: 'ask-1' }]);
    expect(f.count('tools/call')).toBe(2);
  });

  it('enforces the result size limit (declared and streamed bodies)', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url), { limits: { callResultBytes: 2_048 } });
    await expectUpstreamError(c.callTool({ name: 'big', arguments: { bytes: 4_096 } }, makeCtx()), 'too_large');
    await expectUpstreamError(c.callTool({ name: 'big', arguments: { bytes: 4_096, stream: true } }, makeCtx()), 'too_large');
    const small = await c.callTool({ name: 'big', arguments: { bytes: 512 } }, makeCtx());
    expect(small).toMatchObject({ resultType: 'complete' });
  });

  it('401: calls onUnauthorized once and retries exactly once on "retry"', async () => {
    f = await startModernFixture();
    const fx = f;
    const seen: Array<string | undefined> = [];
    c = new ModernConnector(
      baseOpts(f.url, {
        onUnauthorized: async (www) => {
          seen.push(www);
          fx.setUnauthorized(null);
          return 'retry';
        },
      }),
    );
    await c.connect();
    await waitFor(() => (f as ModernFixture).listenerCount() >= 1, 3_000, 'listen stream');
    f.setUnauthorized('Bearer realm="up", error="invalid_token"');
    const result = await c.callTool({ name: 'echo', arguments: { text: 'x' } }, makeCtx());
    expect(result).toMatchObject({ resultType: 'complete' });
    expect(seen).toEqual(['Bearer realm="up", error="invalid_token"']);
    expect(f.count('tools/call')).toBe(2);
  });

  it('401: needs_auth → unauthorized; retry still 401 → unauthorized after one retry; no handler → immediate', async () => {
    f = await startModernFixture();
    let decision: 'retry' | 'needs_auth' = 'needs_auth';
    let calls = 0;
    c = new ModernConnector(baseOpts(f.url, { onUnauthorized: async () => (calls++, decision) }));
    await c.connect();
    await waitFor(() => (f as ModernFixture).listenerCount() >= 1, 3_000, 'listen stream');
    f.setUnauthorized('Bearer realm="up"');
    const err = await expectUpstreamError(c.callTool({ name: 'echo' }, makeCtx()), 'unauthorized');
    expect(err.info.wwwAuthenticate).toBe('Bearer realm="up"');
    expect(calls).toBe(1);
    const hitsBefore = f.unauthorizedHits;
    decision = 'retry';
    await expectUpstreamError(c.callTool({ name: 'echo' }, makeCtx()), 'unauthorized');
    expect(calls).toBe(2);
    expect(f.unauthorizedHits - hitsBefore).toBe(2);
    await c.close();

    c = new ModernConnector(baseOpts(f.url));
    const err2 = await expectUpstreamError(c.listTools(), 'unauthorized');
    expect(err2.info.status).toBe(401);
  });

  it('403 insufficient_scope → UpstreamError(insufficient_scope) with the scope', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url));
    await c.connect();
    await waitFor(() => (f as ModernFixture).listenerCount() >= 1, 3_000, 'listen stream');
    f.setUnauthorized('Bearer error="insufficient_scope", scope="tools:call"', 403);
    const err = await expectUpstreamError(c.callTool({ name: 'echo' }, makeCtx()), 'insufficient_scope');
    expect(err.info.scope).toBe('tools:call');
    expect(parseWwwAuthenticate('Bearer realm="x", error="insufficient_scope", scope="a b"')).toEqual({
      scheme: 'Bearer',
      params: { realm: 'x', error: 'insufficient_scope', scope: 'a b' },
    });
  });

  it('maps JSON-RPC errors to UpstreamError(protocol) and never retries tools/call', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url));
    await c.connect();
    await waitFor(() => (f as ModernFixture).listenerCount() >= 1, 3_000, 'listen stream');
    const unknown = await expectUpstreamError(c.callTool({ name: 'nope' }, makeCtx()), 'protocol');
    expect(unknown.info.rpc?.code).toBe(-32602);

    f.rejectNextWith({ status: 400, code: -32020, message: 'HeaderMismatch', data: { header: 'Mcp-Name' } });
    const mismatch = await expectUpstreamError(c.callTool({ name: 'echo' }, makeCtx()), 'protocol');
    expect(mismatch.info.status).toBe(400);
    expect(mismatch.info.rpc).toEqual({ code: -32020, message: 'HeaderMismatch', data: { header: 'Mcp-Name' } });

    f.rejectNextWith({ status: 503, code: 0, message: 'down', plain: true });
    const down = await expectUpstreamError(c.callTool({ name: 'echo' }, makeCtx()), 'unavailable');
    expect(down.info.status).toBe(503);
    expect(f.count('tools/call')).toBe(3);
  });

  it('retries idempotent forwards once on unavailable', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url));
    await c.connect();
    await waitFor(() => (f as ModernFixture).listenerCount() >= 1, 3_000, 'listen stream');
    f.rejectNextWith({ status: 503, code: 0, message: 'down', plain: true });
    const result = await c.forward('prompts/list', {}, makeCtx());
    expect(result).toMatchObject({ resultType: 'complete' });
    expect(f.count('prompts/list')).toBe(2);
  });

  it('delivers list_changed from subscriptions/listen, ignores keepalives and reconnects with backoff', async () => {
    f = await startModernFixture({ keepaliveMs: 20 });
    c = new ModernConnector(baseOpts(f.url), { listenBackoff: { initialMs: 50, maxMs: 200 } });
    const kinds: string[] = [];
    c.onListChanged((k) => kinds.push(k));
    await c.connect();
    await waitFor(() => (f as ModernFixture).listenerCount() >= 1, 3_000, 'listen stream');
    expect(f.listenRequests[0]).toMatchObject({ subscriptions: [...LISTEN_SUBSCRIPTIONS] });
    const listen = f.requests.find((r) => r.rpcMethod === 'subscriptions/listen');
    expect(listen?.headers['mcp-method']).toBe('subscriptions/listen');

    f.emitListChanged('tools');
    f.emitListChanged('prompts');
    f.emitListChanged('resources');
    await waitFor(() => kinds.length >= 3, 3_000, 'notifications');
    expect(kinds).toEqual(['tools', 'prompts', 'resources']);

    f.dropListeners();
    await waitFor(() => (f as ModernFixture).listenRequests.length >= 2 && (f as ModernFixture).listenerCount() >= 1, 3_000, 'reconnect');
    f.emitListChanged('tools');
    await waitFor(() => kinds.length >= 4, 3_000, 'notification after reconnect');
    expect(kinds).toEqual(['tools', 'prompts', 'resources', 'tools']);
  });

  it('cancels the request when ctx.signal aborts', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url));
    const ac = new AbortController();
    const ctx = makeCtx({ signal: ac.signal });
    const p = c.callTool({ name: 'slow', arguments: { ms: 3_000, everyMs: 100 }, _meta: { progressToken: 't' } }, ctx);
    setTimeout(() => ac.abort(), 200);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => (f as ModernFixture).cancelledCalls >= 1, 2_000, 'upstream saw the abort');
  });

  it('close() stops the listen stream, fires onClose and rejects further calls', async () => {
    f = await startModernFixture();
    c = new ModernConnector(baseOpts(f.url));
    const reasons: Array<string | undefined> = [];
    c.onClose((r) => reasons.push(r));
    await c.connect();
    await waitFor(() => (f as ModernFixture).listenerCount() >= 1, 3_000, 'listen stream');
    await c.close();
    expect(reasons).toEqual(['closed']);
    await waitFor(() => (f as ModernFixture).listenerCount() === 0, 3_000, 'listen stream closed');
    await expectUpstreamError(c.callTool({ name: 'echo' }, makeCtx()), 'unavailable');
    c = undefined;
  });
});
