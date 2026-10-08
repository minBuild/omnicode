import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS, createMasker } from '@omnicode/shared';
import { createAuditWriter, createEventWriter, createRetentionPurger, truncateBytes } from '../../src/audit/index.js';
import { openRegistry } from '../../src/registry/index.js';

const SECRET = 'sk-live-super-secret-key-0001';
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup() {
  const registry = openRegistry(':memory:');
  cleanups.push(() => registry.close());
  const masker = createMasker([SECRET]);
  return { registry, masker };
}

describe('truncateBytes', () => {
  it('cuts on UTF-8 byte budget without splitting characters', () => {
    expect(truncateBytes('abc', 10)).toBe('abc');
    const out = truncateBytes('가'.repeat(100), 20); // 3바이트 문자
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('�');
  });
});

describe('AuditWriter', () => {
  it('masks and truncates error, fills ts, stores no argument bodies', () => {
    const { registry, masker } = setup();
    const w = createAuditWriter(registry, masker);
    const longTail = 'x'.repeat(10_000);
    w.record({
      agent: 'claude',
      job_id: 'job-1',
      server_id: 'fish',
      method: 'tools/call',
      tool: 'tts',
      outcome: 'error',
      error_code: -32013,
      duration_ms: 12,
      req_bytes: 10,
      res_bytes: 0,
      args_sha256: 'ab'.repeat(32),
      protocol_version: '2025-03-26',
      error: `upstream said: key=${SECRET} Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 ${longTail}`,
    });
    const [row] = registry.audit.list({ limit: 10 }).items;
    expect(row).toBeDefined();
    expect(row?.error).not.toContain(SECRET);
    expect(row?.error).toContain('key=***');
    expect(row?.error).toContain('Bearer ***');
    expect(Buffer.byteLength(row?.error ?? '', 'utf8')).toBeLessThanOrEqual(LIMITS.auditErrorBytes);
    expect(row?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row).toMatchObject({ agent: 'claude', job_id: 'job-1', server_id: 'fish', tool: 'tts', outcome: 'error', error_code: -32013 });

    w.record({ ts: '2026-10-07T00:00:00.000Z', agent: 'codex', job_id: null, server_id: 'fish', method: 'tools/call', tool: null, outcome: 'ok', error_code: null, duration_ms: null, req_bytes: null, res_bytes: null, args_sha256: null, protocol_version: null, error: null });
    const ok = registry.audit.list({ limit: 10, outcome: 'ok' }).items[0];
    expect(ok).toMatchObject({ ts: '2026-10-07T00:00:00.000Z', error: null, job_id: null });
  });
});

describe('EventWriter', () => {
  it('masks details via maskJson and stores null when absent', () => {
    const { registry, masker } = setup();
    const w = createEventWriter(registry, masker);
    w.emit('auth.completed', { serverId: 'fish', actor: 'user', details: { token: SECRET, access_token: 'abc', scope: 'tts', nested: { v: `Bearer ${'t'.repeat(20)}` } } });
    w.emit('server.created', { serverId: 'fish', actor: 'user' });
    w.emit('token.rotated', { agent: 'claude', actor: 'hub', details: { agents: ['claude'] }, ts: '2026-10-07T00:00:00.000Z' });
    const items = registry.events.list({}).items;
    expect(items.map((e) => e.kind)).toEqual(['token.rotated', 'server.created', 'auth.completed']);
    const auth = items[2];
    expect(auth?.details_json).not.toContain(SECRET);
    expect(auth?.details_json).toContain('"token":"***"');
    expect(auth?.details_json).toContain('"access_token":"***"');
    expect(auth?.details_json).toContain('"scope":"tts"');
    expect(auth?.details_json).toContain('Bearer ***');
    expect(items[1]?.details_json).toBeNull();
    expect(items[0]).toMatchObject({ agent: 'claude', actor: 'hub', ts: '2026-10-07T00:00:00.000Z', details_json: '{"agents":["claude"]}' });
  });
});

describe('RetentionPurger (17.4)', () => {
  it('removes audit/events past retention and stale oauth states', () => {
    const { registry, masker } = setup();
    const audit = createAuditWriter(registry, masker);
    const events = createEventWriter(registry, masker);
    const base = { agent: 'claude' as const, job_id: null, server_id: 'fish', method: 'tools/call', tool: null, outcome: 'ok' as const, error_code: null, duration_ms: null, req_bytes: null, res_bytes: null, args_sha256: null, protocol_version: null, error: null };
    audit.record({ ...base, ts: '2026-08-01T00:00:00.000Z' });
    audit.record({ ...base, ts: '2026-10-06T00:00:00.000Z' });
    events.emit('probe', { actor: 'hub', ts: '2026-03-01T00:00:00.000Z' });
    events.emit('probe', { actor: 'hub', ts: '2026-10-06T00:00:00.000Z' });
    registry.oauthStates.create({ state: 's', server_id: 'fish', code_verifier: 'v', issuer: 'i', client_id: 'c', scope: null, omnicode_session_id: null, created_at: '2026-10-06T00:00:00.000Z', expires_at: '2026-10-06T00:10:00.000Z', used_at: null });
    const purger = createRetentionPurger(registry, { auditRetentionDays: 30, eventRetentionDays: 180 });
    expect(purger.purge(new Date('2026-10-07T00:00:00.000Z'))).toEqual({ audit: 1, events: 1, oauthStates: 1 });
    expect(registry.audit.list({ limit: 10 }).items).toHaveLength(1);
    expect(registry.events.list({}).items).toHaveLength(1);
  });
});
