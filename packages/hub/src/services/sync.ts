/** 12.2 동기화 서비스: 플래너 → agentd → 바인딩 sync_status 반영. */
import { AGENTS, nowIso, type Agent, type SyncOutcome } from '@omnicode/shared';
import { AgentdUnavailableError, type AgentdClient, type HubConfig, type HubSync, type Logger, type Registry } from '../contracts.js';
import { desiredForAll } from '../sync/planner.js';

export interface SyncService extends HubSync {
  lastSync(): Record<Agent, SyncOutcome | null>;
}

export function createSyncService(deps: { registry: Registry; agentd: AgentdClient; config: HubConfig; logger: Logger }): SyncService {
  const last: Record<Agent, SyncOutcome | null> = { claude: null, codex: null, gemini: null };

  async function run(mode: 'plan' | 'apply', onlyServer?: string): Promise<Record<Agent, SyncOutcome>> {
    const servers = deps.registry.servers.list();
    const bindings = AGENTS.flatMap((a) => deps.registry.bindings.listByAgent(a));
    const desired = desiredForAll(servers, bindings, deps.config.hubPort);
    const out = {} as Record<Agent, SyncOutcome>;
    for (const agent of AGENTS) {
      const at = nowIso();
      const targets = bindings.filter((b) => b.agent === agent && b.enabled === 1 && (!onlyServer || b.server_id === onlyServer));
      try {
        const result = mode === 'apply' ? await deps.agentd.syncApply(agent, desired[agent]) : await deps.agentd.syncPlan(agent, desired[agent]);
        out[agent] = { status: 'synced', at, result };
        if (mode === 'apply') {
          for (const b of targets) deps.registry.bindings.setSync(b.server_id, agent, 'synced', null, at);
          deps.registry.events.add({ kind: 'sync.applied', agent, server_id: onlyServer ?? null, actor: 'hub', details: result });
          last[agent] = out[agent];
        }
      } catch (e) {
        const error = e instanceof AgentdUnavailableError ? `agentd_unavailable: ${e.message}` : e instanceof Error ? e.message : String(e);
        out[agent] = { status: 'failed', at, error };
        if (mode === 'apply') {
          for (const b of targets) deps.registry.bindings.setSync(b.server_id, agent, 'failed', error, at);
          deps.registry.events.add({ kind: 'sync.failed', agent, server_id: onlyServer ?? null, actor: 'hub', details: { error } });
          last[agent] = out[agent];
        }
        deps.logger.warn({ agent, mode, err: error }, 'sync failed');
      }
    }
    return out;
  }

  return {
    all: () => run('apply'),
    plan: () => run('plan'),
    server: (id) => run('apply', id),
    lastSync: () => ({ ...last }),
  };
}
