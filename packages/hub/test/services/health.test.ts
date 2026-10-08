import { describe, expect, it } from 'vitest';
import type { ServerStatus } from '@omnicode/shared';
import { createHealthScheduler, type HealthCheckResult } from '../../src/services/health.js';

const MIN = 60_000;

function setup(initial: Array<{ id: string; status: ServerStatus }>) {
  const clock = { t: 0 };
  const servers = initial.map((s) => ({ ...s }));
  const results = new Map<string, HealthCheckResult>();
  const calls: Array<{ id: string; at: number }> = [];
  const sched = createHealthScheduler(
    () => servers,
    async (id) => {
      calls.push({ id, at: clock.t });
      return results.get(id) ?? { ok: true, ttlMs: null };
    },
    { intervalMs: 10 * MIN, now: () => clock.t },
  );
  return { clock, servers, results, calls, sched };
}

describe('health scheduler (17.3, D8)', () => {
  it('does not check a server right after it appears, then every interval', async () => {
    const h = setup([{ id: 'a', status: 'active' }]);
    expect(await h.sched.tick()).toEqual([]);
    h.clock.t = 9 * MIN;
    expect(await h.sched.tick()).toEqual([]);
    h.clock.t = 10 * MIN;
    expect(await h.sched.tick()).toEqual(['a']);
    expect(h.sched.nextCheckAt('a')).toBe(20 * MIN);
  });

  it('waits longer when the upstream says its tool list stays fresh (ttlMs)', async () => {
    const h = setup([{ id: 'a', status: 'active' }]);
    await h.sched.tick();
    h.results.set('a', { ok: true, ttlMs: 45 * MIN });
    h.clock.t = 10 * MIN;
    await h.sched.tick();
    expect(h.sched.nextCheckAt('a')).toBe(55 * MIN);
    // ttl 이 간격보다 짧으면 간격을 따른다
    h.results.set('a', { ok: true, ttlMs: MIN });
    h.clock.t = 55 * MIN;
    await h.sched.tick();
    expect(h.sched.nextCheckAt('a')).toBe(65 * MIN);
  });

  it('backs off 1 → 2 → 4 … → 30 minutes on failure and resets on success', async () => {
    const h = setup([{ id: 'a', status: 'active' }]);
    await h.sched.tick();
    h.results.set('a', { ok: false, ttlMs: null });
    h.clock.t = 10 * MIN;
    const gaps: number[] = [];
    for (let i = 0; i < 7; i++) {
      await h.sched.tick();
      const next = h.sched.nextCheckAt('a') as number;
      gaps.push((next - h.clock.t) / MIN);
      h.clock.t = next;
    }
    expect(gaps).toEqual([1, 2, 4, 8, 16, 30, 30]);
    h.results.set('a', { ok: true, ttlMs: null });
    await h.sched.tick();
    expect((h.sched.nextCheckAt('a') as number) - h.clock.t).toBe(10 * MIN);
  });

  it('checks error servers after a minute, ignores other statuses, and forgets removed servers', async () => {
    const h = setup([
      { id: 'e', status: 'error' },
      { id: 'p', status: 'pending_approval' },
      { id: 'd', status: 'disabled' },
      { id: 'n', status: 'needs_auth' },
    ]);
    await h.sched.tick();
    expect(h.sched.nextCheckAt('e')).toBe(MIN);
    for (const id of ['p', 'd', 'n']) expect(h.sched.nextCheckAt(id)).toBeUndefined();
    h.clock.t = MIN;
    expect(await h.sched.tick()).toEqual(['e']);
    h.servers.splice(0, 1);
    await h.sched.tick();
    expect(h.sched.nextCheckAt('e')).toBeUndefined();
  });

  it('treats a throwing check as a failure and never overlaps ticks', async () => {
    const clock = { t: 0 };
    let release: () => void = () => undefined;
    let inFlight = 0;
    let maxInFlight = 0;
    const sched = createHealthScheduler(
      () => [{ id: 'a', status: 'active' }],
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((r) => (release = r));
        inFlight--;
        throw new Error('boom');
      },
      { intervalMs: 10 * MIN, now: () => clock.t },
    );
    await sched.tick();
    clock.t = 10 * MIN;
    const first = sched.tick();
    const second = sched.tick();
    expect(second).toBe(first);
    release();
    await first;
    expect(maxInFlight).toBe(1);
    expect(sched.nextCheckAt('a')).toBe(11 * MIN);
  });
});
