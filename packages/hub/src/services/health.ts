/**
 * 상태 점검 스케줄러 (설계 17.3, handoff D8).
 * - active·changed 서버: healthIntervalMs 마다. modern 업스트림이 준 ttlMs 가 더 길면 그만큼 미룬다.
 * - error 서버(또는 점검이 실패한 서버): 1분부터 두 배씩, 최대 30분 간격으로 다시 본다. 성공하면 원래 간격.
 * 점검 자체(목록 재조회, 상태 전이)는 주입한 check 가 한다 — 여기서는 "언제"만 정한다.
 */
import type { ServerStatus } from '@omnicode/shared';
import type { Logger } from '../contracts.js';

export interface HealthCheckResult {
  ok: boolean;
  ttlMs: number | null;
}

export interface HealthSchedulerOptions {
  intervalMs: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** 기한을 확인하는 주기. 기본 min(60초, intervalMs) */
  tickMs?: number;
  now?: () => number;
  logger?: Logger;
}

export interface HealthScheduler {
  start(): void;
  stop(): void;
  /** 한 번 돈다: 기한이 된 서버만 점검하고 점검한 ID 를 돌려준다 */
  tick(): Promise<string[]>;
  /** 테스트·화면용: 다음 점검 예정 시각 (epoch ms) */
  nextCheckAt(serverId: string): number | undefined;
}

const WATCHED: ReadonlySet<ServerStatus> = new Set(['active', 'changed', 'error']);

export function createHealthScheduler(
  list: () => Array<{ id: string; status: ServerStatus }>,
  check: (serverId: string) => Promise<HealthCheckResult>,
  opts: HealthSchedulerOptions,
): HealthScheduler {
  const now = opts.now ?? Date.now;
  const minBackoff = opts.minBackoffMs ?? 60_000;
  const maxBackoff = opts.maxBackoffMs ?? 30 * 60_000;
  const tickMs = opts.tickMs ?? Math.min(60_000, opts.intervalMs);
  const due = new Map<string, number>();
  const backoff = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<string[]> | undefined;

  async function runTick(): Promise<string[]> {
    const t = now();
    const servers = list().filter((s) => WATCHED.has(s.status));
    const ids = new Set(servers.map((s) => s.id));
    for (const id of [...due.keys()]) {
      if (!ids.has(id)) {
        due.delete(id);
        backoff.delete(id);
      }
    }
    const checked: string[] = [];
    for (const s of servers) {
      const at = due.get(s.id);
      if (at === undefined) {
        // 처음 보는 서버: 방금 탐지됐을 것이므로 바로 보지 않는다. error 는 짧게
        due.set(s.id, t + (s.status === 'error' ? minBackoff : opts.intervalMs));
        continue;
      }
      if (at > t) continue;
      checked.push(s.id);
      let result: HealthCheckResult;
      try {
        result = await check(s.id);
      } catch (e) {
        opts.logger?.warn({ serverId: s.id, err: e instanceof Error ? e.message : String(e) }, 'health check threw');
        result = { ok: false, ttlMs: null };
      }
      const after = now();
      if (result.ok) {
        backoff.delete(s.id);
        due.set(s.id, after + Math.max(opts.intervalMs, result.ttlMs ?? 0));
      } else {
        const prev = backoff.get(s.id);
        const next = prev === undefined ? minBackoff : Math.min(maxBackoff, prev * 2);
        backoff.set(s.id, next);
        due.set(s.id, after + next);
      }
    }
    return checked;
  }

  const scheduler: HealthScheduler = {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (!running) void scheduler.tick();
      }, tickMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick() {
      if (running) return running;
      running = runTick().finally(() => {
        running = undefined;
      });
      return running;
    },
    nextCheckAt: (id) => due.get(id),
  };
  return scheduler;
}
