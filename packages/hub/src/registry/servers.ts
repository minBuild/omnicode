/** mcp_servers 저장소 + 9.2 상태 기계 강제. */
import type { ServerRecord, ServerStatus } from '@omnicode/shared';
import { canTransition, InvalidTransitionError, NotFoundError, type NewServer, type ServerRepo } from '../contracts.js';
import { nowIso, type Db } from './db.js';
import { SERVER_COLUMNS, toServerRecord } from './rows.js';

type ServerColumn = (typeof SERVER_COLUMNS)[number];
const UPDATABLE = new Set<ServerColumn>(SERVER_COLUMNS.filter((c) => c !== 'id' && c !== 'created_at'));

const INSERT_SQL = `INSERT INTO mcp_servers (${SERVER_COLUMNS.join(', ')}) VALUES (${SERVER_COLUMNS.map(() => '?').join(', ')})`;

export function createServerRepo(db: Db): ServerRepo {
  const get = (id: string): ServerRecord | undefined => {
    const row = db.stmt('SELECT * FROM mcp_servers WHERE id = ?').get(id);
    return row ? toServerRecord(row) : undefined;
  };
  const mustGet = (id: string): ServerRecord => {
    const rec = get(id);
    if (!rec) throw new NotFoundError(`server ${id}`);
    return rec;
  };

  return {
    get,
    list: () => db.stmt('SELECT * FROM mcp_servers ORDER BY id').all().map(toServerRecord),

    insert(rec) {
      const now = nowIso();
      const full: ServerRecord = { ...rec, created_at: rec.created_at ?? now, updated_at: rec.updated_at ?? rec.created_at ?? now };
      db.stmt(INSERT_SQL).run(...SERVER_COLUMNS.map((c) => full[c]));
      return mustGet(full.id);
    },

    update(id, patch) {
      const sets: string[] = [];
      const values: Array<string | number | null> = [];
      for (const [key, value] of Object.entries(patch)) {
        if (!UPDATABLE.has(key as ServerColumn)) throw new TypeError(`mcp_servers: cannot update column ${key}`);
        if (value === undefined) continue;
        sets.push(`${key} = ?`);
        values.push(value as string | number | null);
      }
      if (!('updated_at' in patch) || patch.updated_at === undefined) {
        sets.push('updated_at = ?');
        values.push(nowIso());
      }
      return db.transaction(() => {
        mustGet(id);
        if (sets.length) db.stmt(`UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
        return mustGet(id);
      });
    },

    setStatus(id, status: ServerStatus, opts = {}) {
      return db.transaction(() => {
        const current = mustGet(id);
        if (!canTransition(current.status, status)) throw new InvalidTransitionError(id, current.status, status);
        if (opts.lastError === undefined) {
          db.stmt('UPDATE mcp_servers SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
        } else {
          db.stmt('UPDATE mcp_servers SET status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(status, opts.lastError, nowIso(), id);
        }
        return mustGet(id);
      });
    },

    delete(id) {
      // 도구·바인딩은 ON DELETE CASCADE. 없는 id 는 조용히 성공 (DELETE 는 멱등, 9.4)
      db.stmt('DELETE FROM mcp_servers WHERE id = ?').run(id);
    },
  };
}
