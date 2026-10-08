/**
 * mcp_tools 저장소. 16.5 rug-pull 방어의 핵심:
 * - upsertFromUpstream 은 현재 정의·해시만 갱신하고 승인 해시는 절대 건드리지 않는다.
 * - approve 는 화면이 본 해시와 현재 해시가 같을 때만 승인한다 (StaleToolHashError).
 */
import { canonicalize, normalizeToolDefinition, toolDefinitionHash, type ToolDefinition, type ToolRecord } from '@omnicode/shared';
import { NotFoundError, StaleToolHashError, type ToolRepo, type ToolUpsertDiff } from '../contracts.js';
import { nowIso, type Db } from './db.js';
import { toToolRecord } from './rows.js';

export function createToolRepo(db: Db): ToolRepo {
  const listByServer = (serverId: string): ToolRecord[] =>
    db.stmt('SELECT * FROM mcp_tools WHERE server_id = ? ORDER BY name').all(serverId).map(toToolRecord);
  const get = (serverId: string, name: string): ToolRecord | undefined => {
    const row = db.stmt('SELECT * FROM mcp_tools WHERE server_id = ? AND name = ?').get(serverId, name);
    return row ? toToolRecord(row) : undefined;
  };
  const serverExists = (serverId: string): boolean => !!db.stmt('SELECT 1 FROM mcp_servers WHERE id = ?').get(serverId);

  return {
    listByServer,
    get,

    upsertFromUpstream(serverId, defs: ToolDefinition[], now = nowIso()): ToolUpsertDiff {
      return db.transaction(() => {
        if (!serverExists(serverId)) throw new NotFoundError(`server ${serverId}`);
        const existing = new Map(listByServer(serverId).map((t) => [t.name, t]));
        const diff: ToolUpsertDiff = { added: [], changed: [], removed: [], unchanged: [] };
        const seen = new Set<string>();

        for (const raw of defs) {
          const def = normalizeToolDefinition({ ...raw });
          if (seen.has(def.name)) continue; // 업스트림이 같은 이름을 두 번 주면 첫 것만
          seen.add(def.name);
          const hash = toolDefinitionHash(def);
          const definitionJson = canonicalize(def);
          const title = def.title ?? null;
          const description = def.description ?? null;
          const annotationsJson = def.annotations ? canonicalize(def.annotations) : null;
          const prev = existing.get(def.name);
          if (!prev) {
            db.stmt(
              `INSERT INTO mcp_tools (server_id, name, title, description, definition_json, schema_hash, approved_hash, approved_definition_json, approved_at, annotations_json, enabled, first_seen_at, last_seen_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 1, ?, ?)`,
            ).run(serverId, def.name, title, description, definitionJson, hash, annotationsJson, now, now);
            diff.added.push(def.name);
          } else if (prev.schema_hash === hash) {
            db.stmt('UPDATE mcp_tools SET last_seen_at = ? WHERE server_id = ? AND name = ?').run(now, serverId, def.name);
            diff.unchanged.push(def.name);
          } else {
            db.stmt(
              'UPDATE mcp_tools SET title = ?, description = ?, definition_json = ?, schema_hash = ?, annotations_json = ?, last_seen_at = ? WHERE server_id = ? AND name = ?',
            ).run(title, description, definitionJson, hash, annotationsJson, now, serverId, def.name);
            diff.changed.push(def.name);
          }
        }

        for (const name of existing.keys()) {
          if (seen.has(name)) continue;
          db.stmt('DELETE FROM mcp_tools WHERE server_id = ? AND name = ?').run(serverId, name);
          diff.removed.push(name);
        }
        for (const k of ['added', 'changed', 'removed', 'unchanged'] as const) diff[k].sort();
        return diff;
      });
    },

    approve(serverId, approvals, now = nowIso()) {
      db.transaction(() => {
        const stale: ToolRecord[] = [];
        const targets: Array<{ rec: ToolRecord; enabled: number }> = [];
        for (const a of approvals) {
          const rec = get(serverId, a.name);
          if (!rec) throw new NotFoundError(`tool ${serverId}/${a.name}`);
          if (rec.schema_hash !== a.schemaHash) {
            stale.push(rec);
            continue;
          }
          targets.push({ rec, enabled: a.enabled === undefined ? rec.enabled : a.enabled ? 1 : 0 });
        }
        if (stale.length) throw new StaleToolHashError(serverId, stale);
        for (const { rec, enabled } of targets) {
          db.stmt(
            'UPDATE mcp_tools SET approved_hash = schema_hash, approved_definition_json = definition_json, approved_at = ?, enabled = ? WHERE server_id = ? AND name = ?',
          ).run(now, enabled, serverId, rec.name);
        }
      });
    },

    setEnabled(serverId, name, enabled) {
      const r = db.stmt('UPDATE mcp_tools SET enabled = ? WHERE server_id = ? AND name = ?').run(enabled ? 1 : 0, serverId, name);
      if (Number(r.changes) === 0) throw new NotFoundError(`tool ${serverId}/${name}`);
    },
  };
}
