/** agent_tokens 저장소 — 토큰 해시만 저장한다 (원문은 Secrets Manager). */
import type { Agent } from '@omnicode/shared';
import type { AgentTokenRepo } from '../contracts.js';
import { nowIso, type Db } from './db.js';
import { toAgentTokenRecord } from './rows.js';

export function createAgentTokenRepo(db: Db): AgentTokenRepo {
  return {
    get(agent: Agent) {
      const row = db.stmt('SELECT * FROM agent_tokens WHERE agent = ?').get(agent);
      return row ? toAgentTokenRecord(row) : undefined;
    },
    all: () => db.stmt('SELECT * FROM agent_tokens ORDER BY agent').all().map(toAgentTokenRecord),
    set(agent, tokenSha256, prev = null, rotatedAt = nowIso()) {
      db.stmt(
        `INSERT INTO agent_tokens (agent, token_sha256, prev_sha256, prev_valid_until, rotated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (agent) DO UPDATE SET token_sha256 = excluded.token_sha256, prev_sha256 = excluded.prev_sha256,
           prev_valid_until = excluded.prev_valid_until, rotated_at = excluded.rotated_at`,
      ).run(agent, tokenSha256, prev?.sha256 ?? null, prev?.validUntil ?? null, rotatedAt);
    },
  };
}
