/** mcp_bindings 저장소 (서버 × 에이전트 노출 여부 + 동기화 상태). */
import type { Agent, BindingRecord } from '@omnicode/shared';
import { NotFoundError, type BindingRepo } from '../contracts.js';
import { nowIso, type Db } from './db.js';
import { toBindingRecord } from './rows.js';

export function createBindingRepo(db: Db): BindingRepo {
  return {
    get(serverId, agent) {
      const row = db.stmt('SELECT * FROM mcp_bindings WHERE server_id = ? AND agent = ?').get(serverId, agent);
      return row ? toBindingRecord(row) : undefined;
    },
    listByServer: (serverId) => db.stmt('SELECT * FROM mcp_bindings WHERE server_id = ? ORDER BY agent').all(serverId).map(toBindingRecord),
    listByAgent: (agent: Agent) => db.stmt('SELECT * FROM mcp_bindings WHERE agent = ? ORDER BY server_id').all(agent).map(toBindingRecord),

    upsert(serverId, agent, enabled) {
      db.stmt(
        `INSERT INTO mcp_bindings (server_id, agent, enabled, sync_status, synced_at, last_error) VALUES (?, ?, ?, 'pending', NULL, NULL)
         ON CONFLICT (server_id, agent) DO UPDATE SET enabled = excluded.enabled`,
      ).run(serverId, agent, enabled ? 1 : 0);
    },

    setSync(serverId, agent, status, error = null, at) {
      const syncedAt = at ?? (status === 'synced' ? nowIso() : null);
      const r =
        syncedAt === null
          ? db.stmt('UPDATE mcp_bindings SET sync_status = ?, last_error = ? WHERE server_id = ? AND agent = ?').run(status, error, serverId, agent)
          : db.stmt('UPDATE mcp_bindings SET sync_status = ?, last_error = ?, synced_at = ? WHERE server_id = ? AND agent = ?').run(status, error, syncedAt, serverId, agent);
      if (Number(r.changes) === 0) throw new NotFoundError(`binding ${serverId}/${agent}`);
    },
  };
}

export type { BindingRecord };
