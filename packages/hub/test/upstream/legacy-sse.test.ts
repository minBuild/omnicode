/**
 * legacy 커넥터의 HTTP+SSE(2024-11-05) 경로 — 설계 11.1 (3), 11.2, 11.7, 10.4.
 * 요청은 POST /messages?sessionId=… (202)로 가고, 응답·progress·알림은 모두 GET /sse 스트림 하나로 온다.
 * legacy.test.ts 의 Streamable HTTP 시나리오를 같은 도구(echo/slow/fail)로 SSE 경로에서 다시 확인한다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { UpstreamConnector } from '../../src/contracts.js';
import { LegacyConnector, createUpstreamConnector } from '../../src/upstream/index.js';
import { startLegacySseFixture, type LegacySseFixture } from '../fixtures/upstream-legacy-sse.js';
import { baseOpts, expectUpstreamError, makeCtx, waitFor } from './helpers.js';

const WWW = 'Bearer realm="up", error="invalid_token", resource_metadata="https://up.example/.well-known/oauth-protected-resource"';

/** SSE 세션을 실제로 연 initialize 수 (감지 중 Streamable HTTP 시도가 POST /sse 로 보낸 initialize 는 뺀다) */
const sessionInits = (fx: LegacySseFixture): number =>
  fx.requests.filter((r) => r.rpcMethod === 'initialize' && r.url.startsWith('/messages')).length;

describe('legacy connector over HTTP+SSE', () => {
  let f: LegacySseFixture | undefined;
  let c: UpstreamConnector | undefined;
  afterEach(async () => {
    await c?.close();
    c = undefined;
    await f?.close();
    f = undefined;
  });

  /** 감지 없이 SSE 전송을 강제한 커넥터 (probe가 SSE 세션을 넘긴 뒤 재연결할 때와 같은 경로) */
  const forcedSse = (url: string, extra: Parameters<typeof baseOpts>[1] = {}): LegacyConnector =>
    new LegacyConnector(baseOpts(url, extra), { transport: 'sse' });

  it('detects HTTP+SSE through createUpstreamConnector and lists tools across pages', async () => {
    f = await startLegacySseFixture({ pageSize: 2 });
    c = createUpstreamConnector(baseOpts(f.url));
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo', 'slow', 'fail']);
    expect(tools[0]).toEqual({
      name: 'echo',
      description: 'echoes text',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    });
    expect(c.era).toBe('legacy');
    expect(c.transport).toBe('sse');
    expect(c.protocolVersion).toBe('2025-11-25');
    expect(c.serverInfo).toMatchObject({ name: 'legacy-sse-fixture' });
    // 11.1 순서: (1) server/discover → (2) Streamable HTTP initialize (둘 다 POST /sse → 405) → (3) GET /sse + POST /messages
    const trail = f.requests.slice(0, 4).map((r) => `${r.method} ${r.url.split('?')[0]}${r.rpcMethod ? ` ${r.rpcMethod}` : ''}`);
    expect(trail).toEqual(['POST /sse server/discover', 'POST /sse initialize', 'GET /sse', 'POST /messages initialize']);
    expect(sessionInits(f)).toBe(1);
    expect(f.count('tools/list')).toBe(2);
    expect(f.streamCount()).toBe(1);
    // JSON-RPC 요청은 전부 endpoint 이벤트가 알려 준 /messages 로 갔다
    const rpc = f.requests.filter((r) => r.rpcMethod !== undefined && r.rpcMethod !== 'server/discover' && r.rpcMethod !== 'initialize');
    expect(rpc.length).toBeGreaterThan(0);
    expect(rpc.every((r) => r.method === 'POST' && r.url.startsWith('/messages?sessionId='))).toBe(true);
  });

  it('calls tools with a forced legacy era (streamable HTTP 405 → SSE) and returns raw results', async () => {
    f = await startLegacySseFixture();
    c = createUpstreamConnector({ ...baseOpts(f.url), era: 'legacy' });
    expect(c).toBeInstanceOf(LegacyConnector);
    const ok = await c.callTool({ name: 'echo', arguments: { text: 'hi' } }, makeCtx());
    expect(ok.content).toEqual([{ type: 'text', text: 'echo:hi' }]);
    expect(c.transport).toBe('sse');
    // isError 결과는 던지지 않는다
    const failed = await c.callTool({ name: 'fail' }, makeCtx());
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([{ type: 'text', text: 'boom' }]);
    expect(f.count('tools/call')).toBe(2);
    expect(f.count('server/discover')).toBe(0);
  });

  it('maps an upstream JSON-RPC error that arrives on the stream to UpstreamError(protocol)', async () => {
    f = await startLegacySseFixture();
    c = forcedSse(f.url);
    const err = await expectUpstreamError(c.forward('prompts/list', {}, makeCtx()), 'protocol');
    expect(err.info.rpc?.code).toBe(-32601);
    expect(f.count('prompts/list')).toBe(1);
  });

  it('sends headers() on the SSE stream and on every POST, with the Hub User-Agent', async () => {
    f = await startLegacySseFixture();
    let n = 0;
    c = forcedSse(f.url, { headers: async () => ({ authorization: `Bearer t${++n}` }) });
    await c.connect();
    await c.listTools();
    const stream = f.requests.find((r) => r.method === 'GET');
    const list = f.requests.find((r) => r.rpcMethod === 'tools/list');
    expect(stream?.headers.authorization).toBe('Bearer t1');
    expect(stream?.headers.accept).toContain('text/event-stream');
    expect(list?.headers.authorization).toMatch(/^Bearer t\d+$/);
    expect(list?.headers.authorization).not.toBe('Bearer t1');
    expect(list?.headers['mcp-protocol-version']).toBe('2025-11-25');
    expect(f.requests.every((r) => r.headers['user-agent']?.startsWith('OmniCode-Hub/'))).toBe(true);
  });

  it('forwards progress from the stream with the downstream token', async () => {
    f = await startLegacySseFixture();
    c = createUpstreamConnector(baseOpts(f.url));
    const ctx = makeCtx({ idleTimeoutMs: 300 });
    const result = await c.callTool({ name: 'slow', arguments: { ms: 600, everyMs: 100 }, _meta: { progressToken: 'dl-1' } }, ctx);
    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
    expect(ctx.progress.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ctx.progress.map((p) => p.progressToken))).toEqual(new Set(['dl-1']));
    expect(ctx.progress[0]).toMatchObject({ progress: 1, total: 6, message: 'tick 1' });
    // 업스트림에는 다운스트림 토큰이 아니라 커넥터(SDK)의 토큰이 갔다
    const call = f.requests.find((r) => r.rpcMethod === 'tools/call');
    const sentToken = (call?.body as { params?: { _meta?: { progressToken?: unknown } } } | undefined)?.params?._meta?.progressToken;
    expect(sentToken).toBeDefined();
    expect(sentToken).not.toBe('dl-1');
  });

  it('does not forward progress when the downstream sent no token', async () => {
    f = await startLegacySseFixture();
    c = forcedSse(f.url);
    const ctx = makeCtx();
    const result = await c.callTool({ name: 'slow', arguments: { ms: 300, everyMs: 100 } }, ctx);
    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
    expect(ctx.progress).toEqual([]);
  });

  it('maps the idle timeout to UpstreamError(timeout) and cancels upstream', async () => {
    f = await startLegacySseFixture();
    c = forcedSse(f.url);
    const ctx = makeCtx({ idleTimeoutMs: 300, timeoutMs: 5_000 });
    const started = Date.now();
    await expectUpstreamError(c.callTool({ name: 'slow', arguments: { ms: 3_000, progress: false }, _meta: { progressToken: 't' } }, ctx), 'timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
    await waitFor(() => (f as LegacySseFixture).count('notifications/cancelled') >= 1, 2_000, 'notifications/cancelled');
    await waitFor(() => (f as LegacySseFixture).cancelledCalls >= 1, 2_000, 'upstream tool saw the cancellation');
  });

  it('maps the total timeout to UpstreamError(timeout) even while progress keeps arriving', async () => {
    f = await startLegacySseFixture();
    c = forcedSse(f.url);
    const ctx = makeCtx({ idleTimeoutMs: 2_000, timeoutMs: 400 });
    const started = Date.now();
    await expectUpstreamError(c.callTool({ name: 'slow', arguments: { ms: 3_000, everyMs: 50 }, _meta: { progressToken: 't' } }, ctx), 'timeout');
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(ctx.progress.length).toBeGreaterThan(0);
    await waitFor(() => (f as LegacySseFixture).count('notifications/cancelled') >= 1, 2_000, 'notifications/cancelled');
  });

  it('cancels the upstream call when ctx.signal aborts and keeps the session usable', async () => {
    f = await startLegacySseFixture();
    c = createUpstreamConnector(baseOpts(f.url));
    const ac = new AbortController();
    const ctx = makeCtx({ signal: ac.signal });
    const p = c.callTool({ name: 'slow', arguments: { ms: 3_000, everyMs: 100 }, _meta: { progressToken: 't' } }, ctx);
    setTimeout(() => ac.abort(), 200);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => (f as LegacySseFixture).cancelledCalls >= 1, 2_000, 'upstream cancellation');
    expect(f.count('notifications/cancelled')).toBe(1);
    const again = await c.callTool({ name: 'echo', arguments: { text: 'after' } }, makeCtx());
    expect(again.content).toEqual([{ type: 'text', text: 'echo:after' }]);
    expect(sessionInits(f)).toBe(1);
  });

  it('401 on POST /messages: calls onUnauthorized once and retries exactly once on "retry"', async () => {
    f = await startLegacySseFixture();
    const fx = f;
    const seen: Array<string | undefined> = [];
    c = createUpstreamConnector(
      baseOpts(f.url, {
        onUnauthorized: async (www) => {
          seen.push(www);
          fx.setUnauthorized(null);
          return 'retry';
        },
      }),
    );
    await c.connect();
    f.setUnauthorized(WWW);
    const result = await c.callTool({ name: 'echo', arguments: { text: 'x' } }, makeCtx());
    expect(result.content).toEqual([{ type: 'text', text: 'echo:x' }]);
    expect(seen).toEqual([WWW]);
    expect(f.unauthorizedHits).toBe(1);
    expect(f.count('tools/call')).toBe(2);
    // 같은 SSE 세션에서 재시도했다
    expect(sessionInits(f)).toBe(1);
    expect(f.streamCount()).toBe(1);
  });

  it('401 on POST /messages: throws unauthorized when onUnauthorized answers needs_auth', async () => {
    f = await startLegacySseFixture();
    let calls = 0;
    c = forcedSse(f.url, { onUnauthorized: async () => (calls++, 'needs_auth') });
    await c.connect();
    f.setUnauthorized('Bearer realm="up"');
    const err = await expectUpstreamError(c.callTool({ name: 'echo', arguments: { text: 'x' } }, makeCtx()), 'unauthorized');
    expect(err.info.wwwAuthenticate).toBe('Bearer realm="up"');
    expect(calls).toBe(1);
    expect(f.unauthorizedHits).toBe(1);
  });

  it('401 on POST /messages: retries only once even if the retry is 401 again', async () => {
    f = await startLegacySseFixture();
    let calls = 0;
    c = forcedSse(f.url, { onUnauthorized: async () => (calls++, 'retry') });
    await c.connect();
    f.setUnauthorized('Bearer realm="up"');
    await expectUpstreamError(c.callTool({ name: 'echo', arguments: { text: 'x' } }, makeCtx()), 'unauthorized');
    expect(calls).toBe(1);
    expect(f.unauthorizedHits).toBe(2);
  });

  it('403 insufficient_scope on POST /messages carries the scope', async () => {
    f = await startLegacySseFixture();
    c = forcedSse(f.url);
    await c.connect();
    f.setUnauthorized('Bearer error="insufficient_scope", scope="read write"', 403);
    const err = await expectUpstreamError(c.callTool({ name: 'echo', arguments: { text: 'x' } }, makeCtx()), 'insufficient_scope');
    expect(err.info.scope).toBe('read write');
  });

  it('401 on GET /sse when opening the stream: passes WWW-Authenticate to onUnauthorized and retries once', async () => {
    f = await startLegacySseFixture();
    const fx = f;
    fx.setUnauthorized(WWW);
    const seen: Array<string | undefined> = [];
    c = forcedSse(f.url, {
      onUnauthorized: async (www) => {
        seen.push(www);
        fx.setUnauthorized(null);
        return 'retry';
      },
    });
    const probe = await c.connect();
    expect(probe.transport).toBe('sse');
    expect(seen).toEqual([WWW]);
    expect(f.unauthorizedHits).toBe(1);
    expect(f.streamCount()).toBe(2);
    const ok = await c.callTool({ name: 'echo', arguments: { text: 'y' } }, makeCtx());
    expect(ok.content).toEqual([{ type: 'text', text: 'echo:y' }]);
  });

  it('401 only on the SSE stream during detection (POST /sse is 405): onUnauthorized still gets WWW-Authenticate', async () => {
    f = await startLegacySseFixture();
    const fx = f;
    fx.setUnauthorized(WWW, 401, 'stream');
    const seen: Array<string | undefined> = [];
    c = createUpstreamConnector(
      baseOpts(f.url, {
        onUnauthorized: async (www) => {
          seen.push(www);
          fx.setUnauthorized(null);
          return 'retry';
        },
      }),
    );
    const probe = await c.connect();
    expect(probe).toMatchObject({ era: 'legacy', transport: 'sse' });
    expect(seen).toEqual([WWW]);
    expect(f.unauthorizedHits).toBe(1);
  });

  it('401 on GET /sse without onUnauthorized, and 403 insufficient_scope on GET /sse, are classified with their headers', async () => {
    f = await startLegacySseFixture();
    f.setUnauthorized('Bearer realm="sse"');
    c = forcedSse(f.url);
    const unauthorized = await expectUpstreamError(c.connect(), 'unauthorized');
    expect(unauthorized.info).toMatchObject({ status: 401, wwwAuthenticate: 'Bearer realm="sse"' });

    f.setUnauthorized('Bearer error="insufficient_scope", scope="mcp:tools"', 403);
    const scoped = await expectUpstreamError(c.connect(), 'insufficient_scope');
    expect(scoped.info.scope).toBe('mcp:tools');
    expect(f.count('initialize')).toBe(0);
  });

  it('bounds the SSE session open by initializeMs when the endpoint event never arrives, and releases the stream', async () => {
    f = await startLegacySseFixture();
    f.setStallStreams(true);
    c = forcedSse(f.url, { timeouts: { initializeMs: 300 } });
    const started = Date.now();
    const err = await expectUpstreamError(c.callTool({ name: 'echo', arguments: { text: 'x' } }, makeCtx({ timeoutMs: 10_000 })), 'timeout');
    expect(err.message).toContain('300ms');
    expect(Date.now() - started).toBeLessThan(2_000);
    // 실패한 세션의 스트림을 붙잡고 있지 않다 (EventSource 를 닫았다)
    await waitFor(() => (f as LegacySseFixture).stalledStreams() === 0, 2_000, 'stalled stream released');
    // 업스트림이 돌아오면 다음 호출이 새 세션을 연다
    f.setStallStreams(false);
    const ok = await c.callTool({ name: 'echo', arguments: { text: 'back' } }, makeCtx());
    expect(ok.content).toEqual([{ type: 'text', text: 'echo:back' }]);
    expect(f.streamCount()).toBe(2);
  });

  it('delivers list_changed notifications from the SSE stream (subscribed before detection)', async () => {
    f = await startLegacySseFixture();
    c = createUpstreamConnector(baseOpts(f.url));
    const kinds: string[] = [];
    c.onListChanged((k) => kinds.push(k));
    await c.connect();
    await f.emitListChanged('tools');
    await f.emitListChanged('prompts');
    await f.emitListChanged('resources');
    await waitFor(() => kinds.length >= 3, 3_000, 'list_changed notifications');
    expect(kinds).toEqual(['tools', 'prompts', 'resources']);
  });

  it('re-initializes a new SSE session on 404 and retries listTools, but never retries callTool', async () => {
    f = await startLegacySseFixture();
    c = forcedSse(f.url);
    await c.connect();
    expect(sessionInits(f)).toBe(1);

    await f.dropSessions();
    const tools = await c.listTools();
    expect(tools).toHaveLength(3);
    expect(sessionInits(f)).toBe(2);
    expect(f.count('tools/list')).toBe(2); // 404 + 재시도
    expect(f.streamCount()).toBe(2);

    await f.dropSessions();
    const err = await expectUpstreamError(c.callTool({ name: 'echo', arguments: { text: 'x' } }, makeCtx()), 'unavailable');
    expect(err.info.status).toBe(404);
    expect(sessionInits(f)).toBe(3);
    expect(f.count('tools/call')).toBe(1); // 재시도하지 않는다

    const again = await c.callTool({ name: 'echo', arguments: { text: 'y' } }, makeCtx());
    expect(again.content).toEqual([{ type: 'text', text: 'echo:y' }]);
    expect(sessionInits(f)).toBe(3);
  });

  it('closes the SSE stream on close(), fires onClose and rejects afterwards', async () => {
    f = await startLegacySseFixture();
    c = forcedSse(f.url);
    const reasons: Array<string | undefined> = [];
    c.onClose((r) => reasons.push(r));
    await c.connect();
    expect(f.sessionIds()).toHaveLength(1);
    await c.close();
    expect(reasons).toEqual(['closed']);
    await waitFor(() => (f as LegacySseFixture).sessionIds().length === 0, 2_000, 'server-side SSE stream close');
    await expectUpstreamError(c.listTools(), 'unavailable');
    c = undefined;
  });
});
