/**
 * C3: 리소스 구독. legacy 는 resources/subscribe (+ 세션 재초기화 뒤 재구독),
 * modern 은 resourceSubscriptions 필터를 담은 별도 subscriptions/listen 스트림 (스펙 2026-07-28 subscriptions 패턴).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { UpstreamConnector } from '../../src/contracts.js';
import { createUpstreamConnector } from '../../src/upstream/index.js';
import { startLegacyFixture, type LegacyFixture } from '../fixtures/upstream-legacy.js';
import { startModernFixture, type ModernFixture } from '../fixtures/upstream-modern.js';
import { baseOpts, delay, makeCtx, waitFor } from './helpers.js';

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const x of open.splice(0).reverse()) await x.close().catch(() => undefined);
});

describe('legacy resource subscriptions (C3)', () => {
  it('subscribes, receives updates only for subscribed URIs, unsubscribes, and re-subscribes after a session re-init', async () => {
    const fx: LegacyFixture = await startLegacyFixture({ withSubscriptions: true });
    open.push(fx);
    const c: UpstreamConnector = createUpstreamConnector(baseOpts(fx.url, { era: 'legacy' }));
    open.push(c);
    const updates: string[] = [];
    c.onResourceUpdated((uri) => updates.push(uri));
    const probe = await c.connect();
    expect((probe.capabilities as { resources?: { subscribe?: boolean } }).resources?.subscribe).toBe(true);

    await c.subscribeResource('file:///config.json');
    expect(fx.subscriptions()).toEqual([['file:///config.json']]);
    await fx.emitResourceUpdated('file:///config.json');
    await fx.emitResourceUpdated('file:///other.json');
    await waitFor(() => updates.length >= 1, 3_000, 'resources/updated');
    await delay(100);
    expect(updates).toEqual(['file:///config.json']);

    // 업스트림이 세션을 버리면 다음 요청에서 재초기화되고, 기억한 구독을 다시 건다
    await fx.dropSessions();
    await c.listTools();
    await waitFor(() => fx.subscribeCalls >= 2, 3_000, 're-subscribe');
    expect(fx.subscriptions()).toEqual([['file:///config.json']]);

    await c.unsubscribeResource('file:///config.json');
    expect(fx.subscriptions()).toEqual([[]]);
    await fx.emitResourceUpdated('file:///config.json');
    await delay(100);
    expect(updates).toEqual(['file:///config.json']);
  });
});

describe('modern resource subscriptions (C3)', () => {
  it('opens a listen stream with resourceSubscriptions and reopens it when the URI set changes', async () => {
    const fx: ModernFixture = await startModernFixture({ keepaliveMs: 20 });
    open.push(fx);
    const c: UpstreamConnector = createUpstreamConnector(baseOpts(fx.url, { era: 'modern' }));
    open.push(c);
    const updates: string[] = [];
    c.onResourceUpdated((uri) => updates.push(uri));
    await c.connect();

    await c.subscribeResource('file:///a');
    await waitFor(() => fx.resourceListenerUris().some((u) => u.includes('file:///a')), 3_000, 'resource listen');
    await c.subscribeResource('file:///b');
    await waitFor(() => fx.resourceListenerUris().some((u) => u.length === 2), 3_000, 'reopened with both');
    // 이전 스트림은 닫혔다: 리소스 스트림은 하나뿐
    await waitFor(() => fx.resourceListenerUris().length === 1, 3_000, 'old stream closed');
    expect(fx.resourceListenerUris()[0]?.sort()).toEqual(['file:///a', 'file:///b']);

    fx.emitResourceUpdated('file:///b');
    await waitFor(() => updates.length >= 1, 3_000, 'update');
    expect(updates).toEqual(['file:///b']);

    await c.unsubscribeResource('file:///a');
    await c.unsubscribeResource('file:///b');
    await waitFor(() => fx.resourceListenerUris().length === 0, 3_000, 'resource stream closed');
    // 목록 변경 스트림은 그대로 산다
    expect(fx.listenerCount()).toBeGreaterThanOrEqual(1);
    await expect(c.callTool({ name: 'echo', arguments: { text: 'still' } }, makeCtx())).resolves.toBeDefined();
  });
});
