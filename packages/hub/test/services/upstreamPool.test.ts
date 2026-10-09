import { describe, expect, it } from 'vitest';
import type { ServerRecord } from '@omnicode/shared';
import type { CreateUpstreamConnector, Registry, UpstreamConnector } from '../../src/contracts.js';
import { createUpstreamPool } from '../../src/services/upstreamPool.js';

function harness() {
  const log: string[] = [];
  let n = 0;
  const updatedCbs: Array<(uri: string) => void> = [];
  const createConnector: CreateUpstreamConnector = () => {
    const id = ++n;
    const c = {
      serverId: 's', era: 'legacy', protocolVersion: 'v', transport: 'streamable_http', serverInfo: null, capabilities: { resources: { subscribe: true } }, lastToolsTtlMs: null,
      connect: async () => ({ era: 'legacy', protocolVersion: 'v', transport: 'streamable_http', serverInfo: null, capabilities: null }),
      listTools: async () => [],
      callTool: async () => ({}),
      forward: async () => ({}),
      onListChanged: () => () => undefined,
      onClose: () => () => undefined,
      subscribeResource: async (uri: string) => void log.push(`c${id}+${uri}`),
      unsubscribeResource: async (uri: string) => void log.push(`c${id}-${uri}`),
      onResourceUpdated: (cb: (uri: string) => void) => {
        updatedCbs.push(cb);
        return () => undefined;
      },
      close: async () => void log.push(`c${id} closed`),
    };
    return c as unknown as UpstreamConnector;
  };
  const rec = { id: 's', url: 'https://s.example/mcp', transport: 'streamable_http', status: 'active', protocol_era: 'legacy' } as ServerRecord;
  const registry = { servers: { get: () => rec, update: () => rec } } as unknown as Registry;
  const updates: string[] = [];
  const pool = createUpstreamPool({
    registry,
    fetch: globalThis.fetch,
    createConnector,
    credentials: { headersFor: async () => ({}), onUnauthorized: async () => 'needs_auth' as const },
    onListChanged: () => undefined,
    onResourceUpdated: (id, uri) => void updates.push(`${id}:${uri}`),
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
  });
  return { pool, log, updates, updatedCbs };
}

describe('upstream pool resource subscriptions (C3)', () => {
  it('reference-counts subscriptions per URI and re-subscribes on a new connector', async () => {
    const h = harness();
    await h.pool.subscribe('s', 'file:///a');
    await h.pool.subscribe('s', 'file:///a');
    expect(h.log).toEqual(['c1+file:///a']);
    await h.pool.unsubscribe('s', 'file:///a');
    expect(h.log).toEqual(['c1+file:///a']);

    // 재탐지로 커넥터가 바뀌면 살아 있는 구독을 새 커넥터에 다시 건다
    await h.pool.probe('s');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.log).toEqual(['c1+file:///a', 'c1 closed', 'c2+file:///a']);

    await h.pool.unsubscribe('s', 'file:///a');
    expect(h.log.at(-1)).toBe('c2-file:///a');
    await h.pool.unsubscribe('s', 'file:///a');
    expect(h.log.filter((l) => l.includes('-'))).toHaveLength(1);
  });

  it('rolls the count back when the upstream refuses the subscription, and relays updates', async () => {
    const h = harness();
    const c = await h.pool.get('s');
    (c as { subscribeResource: (u: string) => Promise<void> }).subscribeResource = async () => {
      throw new Error('nope');
    };
    await expect(h.pool.subscribe('s', 'file:///x')).rejects.toThrow('nope');
    (c as { subscribeResource: (u: string) => Promise<void> }).subscribeResource = async () => undefined;
    await h.pool.subscribe('s', 'file:///x');
    h.updatedCbs.at(-1)?.('file:///x');
    expect(h.updates).toEqual(['s:file:///x']);
  });
});
