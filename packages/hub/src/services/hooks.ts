/** 다운스트림 훅: 업스트림 오류/성공을 서버 상태 전이로 반영한다 (9.2 전이표). */
import { canTransition, type Logger, type OAuthManager, type Registry, type UpstreamError } from '../contracts.js';
import type { DownstreamHooks } from '../downstream/deps.js';
import type { UpstreamPool } from './upstreamPool.js';

export interface HooksDeps {
  registry: Registry;
  oauth: OAuthManager;
  pool: UpstreamPool;
  logger: Logger;
  /** 연속 실패 몇 번에 error 로 바꿀지 (기본 2) */
  failureThreshold?: number;
}

export function createDownstreamHooks(deps: HooksDeps): DownstreamHooks {
  const failures = new Map<string, number>();
  const threshold = deps.failureThreshold ?? 2;

  const setStatus = (serverId: string, to: 'needs_auth' | 'error' | 'active', lastError: string | null) => {
    const rec = deps.registry.servers.get(serverId);
    if (!rec || rec.status === to || !canTransition(rec.status, to)) return false;
    try {
      deps.registry.servers.setStatus(serverId, to, { lastError });
      return true;
    } catch (e) {
      deps.logger.warn({ serverId, to, err: String(e) }, 'status transition failed');
      return false;
    }
  };

  return {
    async onUpstreamError(serverId, err: UpstreamError) {
      switch (err.kind) {
        case 'unauthorized': {
          // OAuth 는 커넥터가 이미 oauth.onUnauthorized 를 거쳤다. 상태만 보정한다.
          if (setStatus(serverId, 'needs_auth', err.message)) {
            deps.registry.events.add({ kind: 'auth.failed', server_id: serverId, actor: 'hub', details: { reason: 'unauthorized' } });
          }
          return;
        }
        case 'insufficient_scope': {
          if (err.info.scope) await deps.oauth.onInsufficientScope(serverId, err.info.scope).catch((e) => deps.logger.warn({ serverId, err: String(e) }, 'step-up failed'));
          else setStatus(serverId, 'needs_auth', err.message);
          return;
        }
        case 'unavailable':
        case 'timeout': {
          const n = (failures.get(serverId) ?? 0) + 1;
          failures.set(serverId, n);
          if (err.kind === 'unavailable') await deps.pool.evict(serverId);
          if (n >= threshold && setStatus(serverId, 'error', err.message)) {
            deps.registry.events.add({ kind: 'health.error', server_id: serverId, actor: 'hub', details: { reason: err.kind, message: err.message } });
          }
          return;
        }
        default:
          return;
      }
    },
    async onUpstreamOk(serverId) {
      failures.delete(serverId);
      const rec = deps.registry.servers.get(serverId);
      if (rec?.status === 'error') {
        // 승인된 도구가 있으면 active, 없으면 pending_approval 이 맞지만 error 는 active 로만 돌아간다 (9.2)
        if (setStatus(serverId, 'active', null)) {
          deps.registry.events.add({ kind: 'server.updated', server_id: serverId, actor: 'hub', details: { recovered: true } });
        }
      }
    },
  };
}
