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
      connector.onClose((reason) => {
        deps.logger.info({ serverId: rec.id, reason }, 'upstream closed');
        const e = entries.get(rec.id);
        if (e && e.connector === connector) entries.delete(rec.id);
      }),
    ];
    entries.set(rec.id, { connector, unsubscribe });
    return connector;
  }

  async function evict(serverId: string) {
    const e = entries.get(serverId);
    entries.delete(serverId);
    if (!e) return;
    for (const u of e.unsubscribe) u();
    await e.connector.close().catch(() => undefined);
  }

  return {
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
    async closeAll() {
      for (const id of [...entries.keys()]) await evict(id);
    },
    size: () => entries.size,
  };
}
