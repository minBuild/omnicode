/**
 * 10.5 에이전트 토큰 관리자.
 * 원본: Secrets Manager `<prefix>/hub-tokens`. 해시: registry.agentTokens. 사본: agentd 가 에이전트 홈에 쓴다.
 */
import { timingSafeEqual } from 'node:crypto';
import { AGENTS, generateAgentToken, sha256Hex, type Agent, type Masker } from '@omnicode/shared';
import {
  hubTokensRef,
  type AgentdClient,
  type HubConfig,
  type HubTokens,
  type HubTokensSecret,
  type Logger,
  type Registry,
  type SecretStore,
} from '../contracts.js';

export interface TokenManagerDeps {
  config: HubConfig;
  registry: Registry;
  secrets: SecretStore;
  agentd: AgentdClient;
  masker: Masker;
  logger: Logger;
  now?: () => Date;
}

interface Cached {
  hash: string;
  prevHash: string | null;
  prevUntil: number | null; // epoch ms
  rotatedAt: string | null;
}

export interface TokenManager extends HubTokens {
  /** 시크릿을 읽고(없으면 생성) 해시 캐시를 채운다. agentd 에 사본 쓰기는 best effort */
  init(): Promise<void>;
  /** agentd 가 내려가 있어 쓰지 못한 사본을 다시 쓴다 */
  ensureFiles(): Promise<boolean>;
  rotatedAt(agent: Agent): string | null;
  graceUntil(agent: Agent): string | null;
}

export function createTokenManager(deps: TokenManagerDeps): TokenManager {
  const now = deps.now ?? (() => new Date());
  const ref = hubTokensRef(deps.config.secretsPrefix);
  const cache = new Map<Agent, Cached>();
  let pendingFiles = new Set<Agent>();

  function remember(agent: Agent, token: string, prev: { hash: string; until: string } | null, rotatedAt: string | null) {
    deps.masker.add(token);
    cache.set(agent, {
      hash: sha256Hex(token),
      prevHash: prev?.hash ?? null,
      prevUntil: prev ? Date.parse(prev.until) : null,
      rotatedAt,
    });
  }

  async function writeFile(agent: Agent, token: string): Promise<boolean> {
    try {
      await deps.agentd.writeToken(agent, token);
      pendingFiles.delete(agent);
      return true;
    } catch (e) {
      pendingFiles.add(agent);
      deps.logger.warn({ agent, err: String(e) }, 'agentd token write deferred');
      return false;
    }
  }

  async function loadOrCreate(): Promise<HubTokensSecret> {
    const existing = await deps.secrets.get<HubTokensSecret>(ref);
    if (existing && AGENTS.every((a) => typeof existing[a] === 'string' && existing[a].length > 0)) return existing;
    const created: HubTokensSecret = {
      claude: generateAgentToken(),
      codex: generateAgentToken(),
      gemini: generateAgentToken(),
      rotated_at: {},
    };
    const ts = now().toISOString();
    for (const a of AGENTS) created.rotated_at[a] = ts;
    await deps.secrets.put(ref, created);
    deps.registry.events.add({ kind: 'token.rotated', actor: 'hub', details: { agents: AGENTS, reason: 'initial' } });
    return created;
  }

  const manager: TokenManager = {
    async init() {
      const secret = await loadOrCreate();
      for (const agent of AGENTS) {
        const row = deps.registry.agentTokens.get(agent);
        const hash = sha256Hex(secret[agent]);
        const rotatedAt = secret.rotated_at[agent] ?? row?.rotated_at ?? null;
        if (!row || row.token_sha256 !== hash) {
          deps.registry.agentTokens.set(agent, hash, null, rotatedAt ?? now().toISOString());
          pendingFiles.add(agent);
        }
        const prev = row && row.token_sha256 === hash && row.prev_sha256 && row.prev_valid_until ? { hash: row.prev_sha256, until: row.prev_valid_until } : null;
        remember(agent, secret[agent], prev, rotatedAt);
      }
      // 시작 시 사본을 항상 한 번 쓴다 (agentd 가 재설치됐을 수도 있다)
      for (const agent of AGENTS) await writeFile(agent, secret[agent]);
    },

    async ensureFiles() {
      if (pendingFiles.size === 0) return true;
      const secret = await deps.secrets.get<HubTokensSecret>(ref);
      if (!secret) return false;
      let ok = true;
      for (const agent of [...pendingFiles]) ok = (await writeFile(agent, secret[agent])) && ok;
      return ok;
    },

    authenticate(token: string): Agent | null {
      if (typeof token !== 'string' || token.length < 20) return null;
      const h = Buffer.from(sha256Hex(token), 'hex');
      const t = now().getTime();
      for (const [agent, c] of cache) {
        if (timingSafeEqual(h, Buffer.from(c.hash, 'hex'))) return agent;
        if (c.prevHash && c.prevUntil !== null && c.prevUntil > t && timingSafeEqual(h, Buffer.from(c.prevHash, 'hex'))) return agent;
      }
      return null;
    },

    async rotate(agents: Agent[]) {
      const secret = (await deps.secrets.get<HubTokensSecret>(ref)) ?? (await loadOrCreate());
      const ts = now();
      const rotatedAt = ts.toISOString();
      const graceUntil = new Date(ts.getTime() + deps.config.agentTokenGraceMs).toISOString();
      const next: HubTokensSecret = { ...secret, rotated_at: { ...secret.rotated_at } };
      for (const agent of agents) {
        next[agent] = generateAgentToken();
        next.rotated_at[agent] = rotatedAt;
      }
      await deps.secrets.put(ref, next);
      for (const agent of agents) {
        const prevHash = cache.get(agent)?.hash ?? sha256Hex(secret[agent]);
        deps.registry.agentTokens.set(agent, sha256Hex(next[agent]), { sha256: prevHash, validUntil: graceUntil }, rotatedAt);
        remember(agent, next[agent], { hash: prevHash, until: graceUntil }, rotatedAt);
        await writeFile(agent, next[agent]);
      }
      deps.registry.events.add({ kind: 'token.rotated', actor: 'user', details: { agents, graceUntil } });
      return { rotatedAt, graceUntil };
    },

    rotatedAt: (agent) => cache.get(agent)?.rotatedAt ?? null,
    graceUntil: (agent) => {
      const c = cache.get(agent);
      return c?.prevUntil && c.prevUntil > now().getTime() ? new Date(c.prevUntil).toISOString() : null;
    },
  };
  return manager;
}
