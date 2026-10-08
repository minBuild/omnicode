/** 11.7 동시성·속도 제한. 서버당 동시 호출 N개 + 대기열, (에이전트, 서버)당 분당 M회. */
import { DEFAULTS, HubError } from '@omnicode/shared';

export interface LimiterOptions {
  maxConcurrentPerServer?: number;
  queueWaitMs?: number;
  ratePerMinute?: number;
  now?: () => number;
}

interface Slot {
  active: number;
  waiters: Array<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
}

export interface Limiter {
  /** 슬롯을 얻는다. 반환된 함수로 반납한다. 실패 시 HubError(rate_limited) */
  acquire(serverId: string, agent: string, signal?: AbortSignal): Promise<() => void>;
  stats(serverId: string): { active: number; queued: number };
}

export function createLimiter(opts: LimiterOptions = {}): Limiter {
  const maxConcurrent = opts.maxConcurrentPerServer ?? DEFAULTS.maxConcurrentCallsPerServer;
  const queueWaitMs = opts.queueWaitMs ?? DEFAULTS.queueWaitMs;
  const ratePerMinute = opts.ratePerMinute ?? DEFAULTS.rateLimitPerMinute;
  const now = opts.now ?? Date.now;
  const slots = new Map<string, Slot>();
  const windows = new Map<string, number[]>(); // key → timestamps (ms) within the last minute

  function slot(serverId: string): Slot {
    let s = slots.get(serverId);
    if (!s) {
      s = { active: 0, waiters: [] };
      slots.set(serverId, s);
    }
    return s;
  }

  function checkRate(serverId: string, agent: string) {
    const key = `${agent}:${serverId}`;
    const t = now();
    const w = (windows.get(key) ?? []).filter((x) => t - x < 60_000);
    if (w.length >= ratePerMinute) {
      const retryIn = Math.ceil((60_000 - (t - (w[0] ?? t))) / 1000);
      windows.set(key, w);
      throw new HubError('rate_limited', { seconds: Math.max(1, retryIn) });
    }
    w.push(t);
    windows.set(key, w);
  }

  function release(s: Slot) {
    s.active = Math.max(0, s.active - 1);
    const next = s.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      s.active += 1;
      next.resolve();
    }
  }

  return {
    async acquire(serverId, agent, signal) {
      checkRate(serverId, agent);
      const s = slot(serverId);
      if (s.active < maxConcurrent) {
        s.active += 1;
      } else {
        await new Promise<void>((resolve, reject) => {
          const entry = {
            resolve,
            reject,
            timer: setTimeout(() => {
              s.waiters.splice(s.waiters.indexOf(entry), 1);
              reject(new HubError('rate_limited', { seconds: Math.ceil(queueWaitMs / 1000) }));
            }, queueWaitMs),
          };
          s.waiters.push(entry);
          signal?.addEventListener(
            'abort',
            () => {
              const i = s.waiters.indexOf(entry);
              if (i >= 0) {
                s.waiters.splice(i, 1);
                clearTimeout(entry.timer);
                reject(new Error('aborted while queued'));
              }
            },
            { once: true },
          );
        });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release(s);
      };
    },
    stats(serverId) {
      const s = slots.get(serverId);
      return { active: s?.active ?? 0, queued: s?.waiters.length ?? 0 };
    },
  };
}
