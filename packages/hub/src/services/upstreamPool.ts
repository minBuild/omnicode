/**
 * 업스트림 커넥터 풀 (11.2: 서버당 커넥터 1개, 모든 다운스트림이 공유).
 * 연결 결과(세대·버전·serverInfo·capabilities)를 레지스트리에 기록하고, 목록 변경 알림을 조립 계층에 넘긴다.
 */
import { nowIso, type ServerRecord } from '@omnicode/shared';
import { UpstreamError, type CreateUpstreamConnector, type FetchLike, type Logger, type ProbeResult, type Registry, type UpstreamConnector } from '../contracts.js';
import type { ConnectorPool } from '../downstream/deps.js';
import type { CredentialProvider } from './credentials.js';

export interface UpstreamPoolDeps {
  registry: Registry;
  fetch: FetchLike;
  createConnector: CreateUpstreamConnector;
  credentials: CredentialProvider;
  onListChanged: (serverId: string, kind: 'tools' | 'prompts' | 'resources') => void;
  /** 구독한 리소스가 바뀌었을 때 (C3) */
  onResourceUpdated?: (serverId: string, uri: string) => void;
  logger: Logger;
}

export interface UpstreamPool extends ConnectorPool {
  /** 기존 연결을 닫고 새로 연결한다. 결과를 레지스트리에 기록한다 */
  probe(serverId: string): Promise<ProbeResult>;
  evict(serverId: string): Promise<void>;
  closeAll(): Promise<void>;
  size(): number;
}

interface Entry {
  connector: UpstreamConnector;
  unsubscribe: Array<() => void>;
}

export function createUpstreamPool(deps: UpstreamPoolDeps): UpstreamPool {
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<UpstreamConnector>>();
  /** serverId → uri → 구독한 다운스트림 세션 수 (C3) */
  const subscriptions = new Map<string, Map<string, number>>();

  function persistProbe(serverId: string, r: ProbeResult) {
    try {
      deps.registry.servers.update(serverId, {
        protocol_era: r.era,
        protocol_version: r.protocolVersion,
        transport: r.transport,
        server_info_json: r.serverInfo ? JSON.stringify(r.serverInfo) : null,
        capabilities_json: r.capabilities ? JSON.stringify(r.capabilities) : null,
        last_probe_at: nowIso(),
      });
    } catch (e) {
      deps.logger.warn({ serverId, err: String(e) }, 'probe result not persisted');
    }
  }

  async function connect(rec: ServerRecord, fresh: boolean): Promise<UpstreamConnector> {
    if (!rec.url || rec.transport === 'stdio') throw new UpstreamError('unavailable', 'stdio 서버는 아직 지원하지 않습니다 (Phase 2)');
    const connector = deps.createConnector({
      serverId: rec.id,
      url: rec.url,
      fetch: deps.fetch,
      headers: () => {
        const current = deps.registry.servers.get(rec.id) ?? rec;
        return deps.credentials.headersFor(current);
      },
      onUnauthorized: (www) => deps.credentials.onUnauthorized(rec.id, www),
      logger: deps.logger,
      ...(!fresh && rec.protocol_era ? { era: rec.protocol_era } : {}),
    });
    const result = await connector.connect();
    persistProbe(rec.id, result);
    const unsubscribe = [
      connector.onListChanged((kind) => deps.onListChanged(rec.id, kind)),
      connector.onResourceUpdated((uri) => deps.onResourceUpdated?.(rec.id, uri)),
      connector.onClose((reason) => {
        deps.logger.info({ serverId: rec.id, reason }, 'upstream closed');
        const e = entries.get(rec.id);
        if (e && e.connector === connector) entries.delete(rec.id);
      }),
    ];
    entries.set(rec.id, { connector, unsubscribe });
    // 새 커넥터(재탐지·재연결)에는 구독이 없다. 살아 있는 구독을 다시 건다
    for (const [uri, n] of subscriptions.get(rec.id) ?? []) {
      if (n > 0) connector.subscribeResource(uri).catch((e: unknown) => deps.logger.warn({ serverId: rec.id, uri, err: String(e) }, 'resource re-subscribe failed'));
    }
    return connector;
  }

  async function evict(serverId: string) {
    const e = entries.get(serverId);
    entries.delete(serverId);
    if (!e) return;
    for (const u of e.unsubscribe) u();
    await e.connector.close().catch(() => undefined);
  }

  const pool: UpstreamPool = {
    peek: (serverId) => entries.get(serverId)?.connector,
    async get(serverId) {
      const existing = entries.get(serverId);
      if (existing) return existing.connector;
      const pending = inflight.get(serverId);
      if (pending) return pending;
      const rec = deps.registry.servers.get(serverId);
      if (!rec) throw new UpstreamError('unavailable', `unknown server ${serverId}`);
      const p = connect(rec, false).finally(() => inflight.delete(serverId));
      inflight.set(serverId, p);
      return p;
    },
    async probe(serverId) {
      await evict(serverId);
      const rec = deps.registry.servers.get(serverId);
      if (!rec) throw new UpstreamError('unavailable', `unknown server ${serverId}`);
      const p = connect(rec, true).finally(() => inflight.delete(serverId));
      inflight.set(serverId, p);
      const c = await p;
      return { era: c.era, protocolVersion: c.protocolVersion, transport: c.transport, serverInfo: c.serverInfo, capabilities: c.capabilities };
    },
    evict,
    async subscribe(serverId, uri) {
      // 연결을 먼저 얻는다. 새로 연결되면 connect() 가 기존 구독을 다시 거는데, 이 URI 를 아직 세지 않았으므로 두 번 걸지 않는다
      const c = await pool.get(serverId);
      let m = subscriptions.get(serverId);
      if (!m) {
        m = new Map();
        subscriptions.set(serverId, m);
      }
      const n = (m.get(uri) ?? 0) + 1;
      m.set(uri, n);
      if (n > 1) return;
      try {
        await c.subscribeResource(uri);
      } catch (e) {
        const left = (m.get(uri) ?? 1) - 1;
        if (left > 0) m.set(uri, left);
        else m.delete(uri);
        throw e;
      }
    },
    async unsubscribe(serverId, uri) {
      const m = subscriptions.get(serverId);
      const n = m?.get(uri);
      if (!m || n === undefined) return;
      if (n > 1) {
        m.set(uri, n - 1);
        return;
      }
      m.delete(uri);
      if (m.size === 0) subscriptions.delete(serverId);
      await entries.get(serverId)?.connector.unsubscribeResource(uri).catch(() => undefined);
    },
    async closeAll() {
      for (const id of [...entries.keys()]) await evict(id);
    },
    size: () => entries.size,
  };
  return pool;
}
