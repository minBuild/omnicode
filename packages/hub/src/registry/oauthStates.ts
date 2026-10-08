/** oauth_states 저장소. state 는 1회용이며 만료를 지키고, 만료 1시간 뒤 정리한다 (17.4). */
import { type OAuthStateRecord, type OAuthStateRepo } from '../contracts.js';
import { nowIso, type Db } from './db.js';
import { toOAuthStateRecord } from './rows.js';

const PURGE_GRACE_MS = 60 * 60 * 1000;

export function createOAuthStateRepo(db: Db): OAuthStateRepo {
  return {
    create(rec: OAuthStateRecord) {
      db.stmt(
        `INSERT INTO oauth_states (state, server_id, code_verifier, issuer, client_id, scope, omnicode_session_id, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(rec.state, rec.server_id, rec.code_verifier, rec.issuer, rec.client_id, rec.scope, rec.omnicode_session_id, rec.created_at, rec.expires_at, rec.used_at);
    },

    consume(state, now = nowIso()) {
      return db.transaction(() => {
        // 단일 UPDATE 로 "미사용 + 미만료" 조건을 원자적으로 소진한다
        const r = db.stmt('UPDATE oauth_states SET used_at = ? WHERE state = ? AND used_at IS NULL AND expires_at > ?').run(now, state, now);
        if (Number(r.changes) !== 1) return undefined;
        const row = db.stmt('SELECT * FROM oauth_states WHERE state = ?').get(state);
        return row ? toOAuthStateRecord(row) : undefined;
      });
    },

    purgeExpired(now = nowIso()) {
      const cutoff = new Date(Date.parse(now) - PURGE_GRACE_MS).toISOString();
      const r = db.stmt('DELETE FROM oauth_states WHERE expires_at <= ?').run(cutoff);
      return Number(r.changes);
    },
  };
}
