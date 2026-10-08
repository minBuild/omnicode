/** mcp_events (수명주기 이벤트) 저장소. details 는 호출자가 마스킹한 뒤 넘긴다 (audit/ 의 EventWriter). */
import type { EventPage } from '@omnicode/shared';
import type { EventRepo } from '../contracts.js';
import { nowIso, type Db } from './db.js';
import { toEventRecord } from './rows.js';

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE;
  return Math.max(1, Math.min(MAX_PAGE, Math.floor(limit)));
}

function serializeDetails(details: unknown): string | null {
  if (details === undefined || details === null) return null;
  if (typeof details === 'string') return details; // 이미 마스킹·직렬화된 문자열
  try {
    return JSON.stringify(details) ?? null;
  } catch {
    return String(details);
  }
}

export function createEventRepo(db: Db): EventRepo {
  return {
    add(e) {
      db.stmt('INSERT INTO mcp_events (ts, kind, server_id, agent, actor, details_json) VALUES (?, ?, ?, ?, ?, ?)').run(
        e.ts ?? nowIso(),
        e.kind,
        e.server_id ?? null,
        e.agent ?? null,
        e.actor,
        serializeDetails(e.details),
      );
    },

    list(q): EventPage {
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
      if (q.since !== undefined) {
        where.push('ts >= ?');
        params.push(q.since);
      }
      if (q.cursor !== undefined) {
        where.push('id < ?');
        params.push(q.cursor);
      }
      const limit = clampLimit(q.limit);
      const sql = `SELECT * FROM mcp_events${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
      const rows = db.stmt(sql).all(...params, limit + 1);
      const items = rows.slice(0, limit).map(toEventRecord);
      const last = items[items.length - 1];
      return { items, nextCursor: rows.length > limit && last ? last.id : null };
    },

    purgeOlderThan(iso) {
      return Number(db.stmt('DELETE FROM mcp_events WHERE ts < ?').run(iso).changes);
    },
  };
}
