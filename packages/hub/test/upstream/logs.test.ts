/**
 * D1: 업스트림 notifications/message 를 요청 단위로 전달한다.
 * legacy 는 AsyncLocalStorage 로 요청 스트림과 호출을 묶고, modern 은 요청 _meta.logLevel 로 로그를 요청한다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LogMessageNotification, UpstreamConnector } from '../../src/contracts.js';
import { createUpstreamConnector } from '../../src/upstream/index.js';
import { startLegacyFixture, type LegacyFixture } from '../fixtures/upstream-legacy.js';
import { startModernFixture, type ModernFixture } from '../fixtures/upstream-modern.js';
import { baseOpts, delay, makeCtx } from './helpers.js';

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const x of open.splice(0).reverse()) await x.close().catch(() => undefined);
});

function collector() {
  const got: LogMessageNotification[] = [];
  return { got, onMessage: (n: LogMessageNotification) => void got.push(n) };
}

describe('legacy upstream log forwarding (D1)', () => {
  let fx: LegacyFixture;
  let c: UpstreamConnector;

  async function setup() {
    fx = await startLegacyFixture({ withLogTool: true });
    open.push(fx);
    c = createUpstreamConnector(baseOpts(fx.url, { era: 'legacy' }));
    open.push(c);
    await c.connect();
  }

  it('delivers each request-stream message only to the call that caused it, even when calls interleave', async () => {
    await setup();
    const a = collector();
    const b = collector();
    const call = (who: string, sink: ReturnType<typeof collector>) =>
      c.callTool(
        { name: 'log', arguments: { gapMs: 30, messages: [1, 2, 3].map((i) => ({ level: 'info', data: `${who}-${i}` })) } },
        makeCtx({ onMessage: sink.onMessage }),
      );
    const [ra, rb] = await Promise.all([call('a', a), call('b', b)]);
    expect(JSON.stringify(ra)).toContain('logged 3');
    expect(JSON.stringify(rb)).toContain('logged 3');
    expect(a.got.map((m) => m.data)).toEqual(['a-1', 'a-2', 'a-3']);
    expect(b.got.map((m) => m.data)).toEqual(['b-1', 'b-2', 'b-3']);
    expect(a.got[0]).toMatchObject({ level: 'info', logger: 'fixture' });
  });

  it('filters by the downstream level (default info) and ignores calls without a sink', async () => {
    await setup();
    const messages = [
      { level: 'debug', data: 'd' },
      { level: 'info', data: 'i' },
      { level: 'warning', data: 'w' },
      { level: 'error', data: 'e' },
    ];
    const byDefault = collector();
    await c.callTool({ name: 'log', arguments: { messages } }, makeCtx({ onMessage: byDefault.onMessage }));
    expect(byDefault.got.map((m) => m.data)).toEqual(['i', 'w', 'e']);
    const warnOnly = collector();
    await c.callTool({ name: 'log', arguments: { messages } }, makeCtx({ onMessage: warnOnly.onMessage, logLevel: 'warning' }));
    expect(warnOnly.got.map((m) => m.data)).toEqual(['w', 'e']);
    // 받을 곳이 없으면 그냥 버린다
    await expect(c.callTool({ name: 'log', arguments: { messages } }, makeCtx())).resolves.toBeDefined();
  });

  it('drops session-stream logs that belong to no request', async () => {
    await setup();
    const sink = collector();
    const pending = c.callTool({ name: 'slow', arguments: { ms: 300, everyMs: 50 } }, makeCtx({ onMessage: sink.onMessage }));
    await delay(100);
    await fx.emitSessionLog('error', 'unrelated');
    await pending;
    expect(sink.got).toEqual([]);
  });
});

describe('modern upstream log forwarding (D1)', () => {
  let fx: ModernFixture;
  let c: UpstreamConnector;

  async function setup() {
    fx = await startModernFixture();
    open.push(fx);
    c = createUpstreamConnector(baseOpts(fx.url, { era: 'modern' }));
    open.push(c);
    await c.connect();
  }

  it('asks for logs with _meta.logLevel only when the downstream wants them, and forwards them', async () => {
    await setup();
    const messages = [
      { level: 'debug', data: 'd' },
      { level: 'info', data: 'i' },
      { level: 'error', data: 'e' },
    ];
    const sink = collector();
    await c.callTool({ name: 'log', arguments: { messages } }, makeCtx({ onMessage: sink.onMessage }));
    expect(sink.got.map((m) => m.data)).toEqual(['i', 'e']);
    const errOnly = collector();
    await c.callTool({ name: 'log', arguments: { messages } }, makeCtx({ onMessage: errOnly.onMessage, logLevel: 'error' }));
    expect(errOnly.got.map((m) => m.data)).toEqual(['e']);
    await c.callTool({ name: 'log', arguments: { messages } }, makeCtx());
    expect(fx.logLevelsSeen).toEqual(['info', 'error', undefined]);
  });

  it('records the tools/list ttlMs for the health scheduler (D8)', async () => {
    await setup();
    expect(c.lastToolsTtlMs).toBeNull();
    await c.listTools();
    expect(c.lastToolsTtlMs).toBe(60_000);
  });
});
