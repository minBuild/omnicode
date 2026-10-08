/** mcp_audit_log (도구 호출 기록) 저장소. 인자 원문·결과 본문은 절대 저장하지 않는다 (해시·크기만). */
import type { AuditPage } from '@omnicode/shared';
import type { AuditRepo } from '../contracts.js';
import type { Db } from './db.js';
import { clampLimit } from './events.js';
import { toAuditEntry } from './rows.js';

export function createAuditRepo(db: Db): AuditRepo {
  return {
    add(e) {
      db.stmt(
        `INSERT INTO mcp_audit_log (ts, agent, job_id, server_id, method, tool, outcome, error_code, duration_ms, req_bytes, res_bytes, args_sha256, protocol_version, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(e.ts, e.agent, e.job_id, e.server_id, e.method, e.tool, e.outcome, e.error_code, e.duration_ms, e.req_bytes, e.res_bytes, e.args_sha256, e.protocol_version, e.error);
    },

    list(q): AuditPage {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (q.serverId !== undefined) {
        where.push('server_id = ?');
        params.push(q.serverId);
      }
      if (q.agent !== undefined) {
        where.push('agent = ?');
        params.push(q.agent);
      }
      if (q.outcome !== undefined) {
        where.push('outcome = ?');
        params.push(q.outcome);
      }
      if (q.since !== undefined) {
        where.push('ts >= ?');
        params.push(q.since);
      }
      if (q.cursor !== undefined) {
        where.push('id < ?');
        params.push(q.cursor);
      }
      const limit = clampLimit(q.limit);
      const sql = `SELECT * FROM mcp_audit_log${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
      const rows = db.stmt(sql).all(...params, limit + 1);
      const items = rows.slice(0, limit).map(toAuditEntry);
      const last = items[items.length - 1];
      return { items, nextCursor: rows.length > limit && last ? last.id : null };
    },

    purgeOlderThan(iso) {
      return Number(db.stmt('DELETE FROM mcp_audit_log WHERE ts < ?').run(iso).changes);
    },
  };
}
