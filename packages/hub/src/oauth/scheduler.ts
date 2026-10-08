/**
 * 백그라운드 refresh 스케줄러 (설계 10.4: 만료 5분 전 refresh, 네트워크·5xx는 지수 백오프 최대 5분).
 * Hub 조합 코드가 start()/stop()을 부른다.
 */
import { DEFAULTS } from '@omnicode/shared';
import type { ServerStatus } from '@omnicode/shared';
import type { Logger, Registry } from '../contracts.js';
import type { HubOAuthManager } from './manager.js';

export interface RefreshSchedulerOptions {
  /** 만료까지 이 시간 안이면 refresh. 기본 DEFAULTS.refreshAheadMs (5분) */
  aheadMs?: number;
  /** 스캔 주기. 기본 60초 */
  intervalMs?: number;
  /** transient 실패 백오프 시작값. 기본 30초, 최대 5분 */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  logger?: Logger;
  now?: () => Date;
}

export interface RefreshSweepResult {
  scanned: number;
  refreshed: string[];
  failed: Array<{ serverId: string; kind: string; error: string }>;
  skipped: string[];
  purgedStates: number;
}

export interface RefreshScheduler {
  readonly running: boolean;
  start(): void;
  stop(): void;
  /** 한 번 스캔한다 (타이머와 겹치면 진행 중인 스캔을 돌려준다) */
  runOnce(): Promise<RefreshSweepResult>;
}

const REFRESHABLE: ReadonlySet<ServerStatus> = new Set<ServerStatus>(['active', 'changed', 'pending_approval', 'error']);

export function createRefreshScheduler(manager: HubOAuthManager, registry: Registry, opts: RefreshSchedulerOptions = {}): RefreshScheduler {
  const aheadMs = opts.aheadMs ?? DEFAULTS.refreshAheadMs;
  const intervalMs = opts.intervalMs ?? 60_000;
  const backoffBaseMs = opts.backoffBaseMs ?? 30_000;
  const backoffMaxMs = opts.backoffMaxMs ?? 300_000;
  const now = opts.now ?? (() => new Date());
  const logger = opts.logger;

  let timer: NodeJS.Timeout | null = null;
  let inflight: Promise<RefreshSweepResult> | null = null;
  const backoff = new Map<string, { failures: number; nextAttemptAt: number }>();

  async function sweep(): Promise<RefreshSweepResult> {
    const result: RefreshSweepResult = { scanned: 0, refreshed: [], failed: [], skipped: [], purgedStates: 0 };
    const t = now().getTime();
    try {
      result.purgedStates = registry.oauthStates.purgeExpired(new Date(t).toISOString());
    } catch (e) {
      logger?.warn({ err: e instanceof Error ? e.message : String(e) }, 'oauth scheduler: purgeExpired failed');
    }
    for (const server of registry.servers.list()) {
      if (server.auth_type !== 'oauth' || !REFRESHABLE.has(server.status)) continue;
      result.scanned++;
      const pending = backoff.get(server.id);
      if (pending && pending.nextAttemptAt > t) {
        result.skipped.push(server.id);
        continue;
      }
      try {
        const outcome = await manager.refresh(server.id, { aheadMs });
        if (outcome.status === 'refreshed') {
          backoff.delete(server.id);
          result.refreshed.push(server.id);
        } else if (outcome.status === 'failed') {
          result.failed.push({ serverId: server.id, kind: outcome.kind, error: outcome.error });
          if (outcome.kind === 'transient') {
            const failures = (pending?.failures ?? 0) + 1;
            const delay = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (failures - 1));
            backoff.set(server.id, { failures, nextAttemptAt: t + delay });
          } else {
            backoff.delete(server.id);
          }
        } else {
          result.skipped.push(server.id);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        result.failed.push({ serverId: server.id, kind: 'unexpected', error: message });
        logger?.warn({ serverId: server.id, err: message }, 'oauth scheduler: refresh threw');
      }
    }
    return result;
  }

  function runOnce(): Promise<RefreshSweepResult> {
    if (inflight) return inflight;
    inflight = sweep().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    get running() {
      return timer !== null;
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void runOnce().catch((e: unknown) => {
          logger?.warn({ err: e instanceof Error ? e.message : String(e) }, 'oauth scheduler: sweep failed');
        });
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    runOnce,
  };
}
