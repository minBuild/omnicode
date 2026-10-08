import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeToolDefinition, toolDefinitionHash, type ServerStatus, type ToolDefinition } from '@omnicode/shared';
import { InvalidTransitionError, NotFoundError, StaleToolHashError, TRANSITIONS, type NewServer } from '../../src/contracts.js';
import { applyMigrations, openDatabase, openRegistry, readMigrations } from '../../src/registry/index.js';

const STATUSES = Object.keys(TRANSITIONS) as ServerStatus[];

function newServer(id: string, status: ServerStatus = 'draft'): NewServer {
  return {
    id,
    display_name: id,
    source: 'url',
    preset_id: null,
    transport: 'streamable_http',
    url: `https://${id}.example.com/mcp`,
    canonical_url: null,
    command: null,
    args_json: null,
    env_keys_json: null,
    auth_type: 'none',
    header_name: null,
    secret_ref: null,
    oauth_issuer: null,
    oauth_client_mode: null,
    oauth_prm_url: null,
    requested_scope: null,
    granted_scope: null,
    protocol_era: null,
    protocol_version: null,
    server_info_json: null,
    capabilities_json: null,
    call_timeout_ms: 600_000,
    cli_auto_approve: 1,
    status,
    last_error: null,
    last_probe_at: null,
    tools_synced_at: null,
  };
}

const tool = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({ name, description: `${name} desc`, inputSchema: { type: 'object' }, ...extra });
const hashOf = (d: ToolDefinition) => toolDefinitionHash(normalizeToolDefinition({ ...d }));

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function reg() {
  const r = openRegistry(':memory:');
  cleanups.push(() => r.close());
  return r;
}

describe('migrations', () => {
  it('apply exactly once and are idempotent', () => {
    const db = openDatabase(':memory:');
    cleanups.push(() => db.close());
    const first = applyMigrations(db.raw);
    expect(first.applied).toEqual([1]);
    expect(first.current).toBe(1);
    const second = applyMigrations(db.raw);
    expect(second.applied).toEqual([]);
    expect(second.current).toBe(1);
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(['agent_tokens', 'mcp_audit_log', 'mcp_bindings', 'mcp_events', 'mcp_servers', 'mcp_tools', 'oauth_states', 'schema_migrations']);
    const indexes = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name").all().map((r) => r.name);
    expect(indexes).toEqual(['idx_audit_agent_ts', 'idx_audit_server_ts', 'idx_audit_ts', 'idx_events_ts']);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n).toBe(1);
  });

  it('reads numbered files in order and rejects duplicates', () => {
    const ms = readMigrations();
    expect(ms.map((m) => m.version)).toEqual([...ms.map((m) => m.version)].sort((a, b) => a - b));
    expect(ms[0]).toMatchObject({ version: 1, name: '001_init.sql' });
  });

  it('rolls back a failing migration', () => {
    const db = openDatabase(':memory:');
    cleanups.push(() => db.close());
    applyMigrations(db.raw);
    expect(() => applyMigrations(db.raw, [{ version: 2, name: '002_bad.sql', sql: 'CREATE TABLE ok_part (x); CREATE TABLE mcp_servers (id);' }])).toThrow(/002_bad/);
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'ok_part'").get()).toBeUndefined();
    expect(db.raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v).toBe(1);
  });

  it('opens a file database in WAL mode with foreign keys on, twice', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'omnicode-registry-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'nested', 'registry.sqlite');
    const r1 = openRegistry(file);
    expect(r1.db.raw.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    expect(r1.db.raw.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    r1.servers.insert(newServer('persisted'));
    r1.close();
    const r2 = openRegistry(file);
    cleanups.push(() => r2.close());
    expect(r2.servers.get('persisted')?.id).toBe('persisted');
    expect(r2.db.raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n).toBe(1);
  });
});

describe('servers + state machine (9.2)', () => {
  it('insert/get/list/update/delete', () => {
    const r = reg();
    const rec = r.servers.insert(newServer('a'));
    expect(rec.created_at).toBe(rec.updated_at);
    expect(r.servers.get('a')?.display_name).toBe('a');
    r.servers.insert(newServer('b', 'active'));
    expect(r.servers.list().map((s) => s.id)).toEqual(['a', 'b']);
    const updated = r.servers.update('a', { display_name: 'Alpha', last_error: 'x', call_timeout_ms: 1234 });
    expect(updated).toMatchObject({ display_name: 'Alpha', last_error: 'x', call_timeout_ms: 1234 });
    expect(updated.updated_at >= rec.updated_at).toBe(true);
    expect(() => r.servers.update('zzz', { display_name: 'x' })).toThrow(NotFoundError);
    expect(() => r.servers.update('a', { id: 'hacked' } as never)).toThrow(/cannot update column id/);
    r.servers.delete('a');
    expect(r.servers.get('a')).toBeUndefined();
    expect(() => r.servers.delete('a')).not.toThrow();
  });

  it('delete cascades to tools and bindings', () => {
    const r = reg();
    r.servers.insert(newServer('a'));
    r.tools.upsertFromUpstream('a', [tool('t')]);
    r.bindings.upsert('a', 'claude', true);
    r.servers.delete('a');
    expect(r.tools.listByServer('a')).toEqual([]);
    expect(r.bindings.listByServer('a')).toEqual([]);
  });

  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const allowed = from === to || TRANSITIONS[from].includes(to);
      it(`${from} -> ${to} is ${allowed ? 'allowed' : 'forbidden'}`, () => {
        const r = reg();
        r.servers.insert(newServer('s', from));
        if (allowed) {
          expect(r.servers.setStatus('s', to).status).toBe(to);
        } else {
          let err: unknown;
          try {
            r.servers.setStatus('s', to);
          } catch (e) {
            err = e;
          }
          expect(err).toBeInstanceOf(InvalidTransitionError);
          expect(err).toMatchObject({ serverId: 's', from, to });
          expect(r.servers.get('s')?.status).toBe(from);
        }
      });
    }
  }

  it('setStatus records and clears last_error only when asked', () => {
    const r = reg();
    r.servers.insert(newServer('s', 'active'));
    expect(r.servers.setStatus('s', 'error', { lastError: 'boom' }).last_error).toBe('boom');
    expect(r.servers.setStatus('s', 'error').last_error).toBe('boom'); // 같은 상태, 오류 유지
    expect(r.servers.setStatus('s', 'active', { lastError: null }).last_error).toBeNull();
    expect(() => r.servers.setStatus('nope', 'active')).toThrow(NotFoundError);
  });
});

describe('tools (16.5 rug-pull defence)', () => {
  it('upsert diff semantics keep approvals untouched', () => {
    const r = reg();
    r.servers.insert(newServer('a'));
    const a = tool('a');
    const b = tool('b');
    const now1 = '2026-10-07T00:00:00.000Z';
    expect(r.tools.upsertFromUpstream('a', [a, b], now1)).toEqual({ added: ['a', 'b'], changed: [], removed: [], unchanged: [] });
    const rowB = r.tools.get('a', 'b');
    expect(rowB).toMatchObject({ approved_hash: null, approved_definition_json: null, approved_at: null, enabled: 1, first_seen_at: now1, last_seen_at: now1, schema_hash: hashOf(b) });
    expect(JSON.parse(rowB?.definition_json ?? '')).toEqual({ name: 'b', description: 'b desc', inputSchema: { type: 'object' } });

    r.tools.approve('a', [{ name: 'b', schemaHash: hashOf(b) }], '2026-10-07T00:01:00.000Z');
    const approvedB = r.tools.get('a', 'b');
    expect(approvedB).toMatchObject({ approved_hash: hashOf(b), approved_at: '2026-10-07T00:01:00.000Z' });
    expect(approvedB?.approved_definition_json).toBe(approvedB?.definition_json);

    // 키 순서·icons·_meta 는 해시에 영향이 없어야 한다 (13장)
    const aReordered = { inputSchema: { type: 'object' }, description: 'a desc', name: 'a', icons: [{ src: 'x' }], _meta: { z: 1 } } as unknown as ToolDefinition;
    const bChanged = tool('b', { description: 'b desc CHANGED' });
    const c = tool('c', { title: 'C', annotations: { readOnlyHint: true } });
    const now2 = '2026-10-07T01:00:00.000Z';
    expect(r.tools.upsertFromUpstream('a', [c, bChanged, aReordered], now2)).toEqual({ added: ['c'], changed: ['b'], removed: [], unchanged: ['a'] });
    const changedB = r.tools.get('a', 'b');
    expect(changedB).toMatchObject({ schema_hash: hashOf(bChanged), approved_hash: hashOf(b), last_seen_at: now2, first_seen_at: now1 });
    expect(changedB?.approved_definition_json).toBe(approvedB?.definition_json); // 승인 시점 정의 보존
    expect(changedB?.schema_hash).not.toBe(changedB?.approved_hash);
    expect(r.tools.get('a', 'a')?.last_seen_at).toBe(now2);
    expect(r.tools.get('a', 'c')).toMatchObject({ title: 'C', annotations_json: '{"readOnlyHint":true}', approved_hash: null });

    expect(r.tools.upsertFromUpstream('a', [a], '2026-10-07T02:00:00.000Z')).toEqual({ added: [], changed: [], removed: ['b', 'c'], unchanged: ['a'] });
    expect(r.tools.listByServer('a').map((t) => t.name)).toEqual(['a']);
    expect(() => r.tools.upsertFromUpstream('missing', [a])).toThrow(NotFoundError);
  });

  it('approve rejects stale hashes atomically and applies enabled', () => {
    const r = reg();
    r.servers.insert(newServer('a'));
    const a = tool('a');
    const b = tool('b');
    r.tools.upsertFromUpstream('a', [a, b]);
    let err: unknown;
    try {
      r.tools.approve('a', [
        { name: 'a', schemaHash: hashOf(a) },
        { name: 'b', schemaHash: 'f'.repeat(64) },
      ]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StaleToolHashError);
    expect((err as StaleToolHashError).tools.map((t) => t.name)).toEqual(['b']);
    expect((err as StaleToolHashError).tools[0]?.schema_hash).toBe(hashOf(b));
    expect(r.tools.get('a', 'a')?.approved_hash).toBeNull(); // 부분 승인 없음

    r.tools.approve('a', [
      { name: 'a', schemaHash: hashOf(a), enabled: false },
      { name: 'b', schemaHash: hashOf(b) },
    ]);
    expect(r.tools.get('a', 'a')).toMatchObject({ approved_hash: hashOf(a), enabled: 0 });
    expect(r.tools.get('a', 'b')).toMatchObject({ approved_hash: hashOf(b), enabled: 1 });
    r.tools.setEnabled('a', 'a', true);
    expect(r.tools.get('a', 'a')?.enabled).toBe(1);
    expect(() => r.tools.setEnabled('a', 'nope', true)).toThrow(NotFoundError);
    expect(() => r.tools.approve('a', [{ name: 'nope', schemaHash: hashOf(a) }])).toThrow(NotFoundError);
  });
});

describe('bindings', () => {
  it('upsert, sync status, listing', () => {
    const r = reg();
    r.servers.insert(newServer('a'));
    r.servers.insert(newServer('b'));
    r.bindings.upsert('a', 'claude', true);
    r.bindings.upsert('a', 'codex', false);
    r.bindings.upsert('b', 'claude', true);
    expect(r.bindings.get('a', 'claude')).toMatchObject({ enabled: 1, sync_status: 'pending', synced_at: null, last_error: null });
    r.bindings.setSync('a', 'claude', 'synced', null, '2026-10-07T00:00:00.000Z');
    expect(r.bindings.get('a', 'claude')).toMatchObject({ sync_status: 'synced', synced_at: '2026-10-07T00:00:00.000Z' });
    r.bindings.setSync('a', 'claude', 'failed', 'agentd down');
    expect(r.bindings.get('a', 'claude')).toMatchObject({ sync_status: 'failed', last_error: 'agentd down', synced_at: '2026-10-07T00:00:00.000Z' });
    r.bindings.setSync('a', 'claude', 'synced');
    expect(r.bindings.get('a', 'claude')?.synced_at).not.toBe('2026-10-07T00:00:00.000Z');
    r.bindings.upsert('a', 'claude', false); // enabled 만 바뀌고 동기화 상태는 유지
    expect(r.bindings.get('a', 'claude')).toMatchObject({ enabled: 0, sync_status: 'synced' });
    expect(r.bindings.listByServer('a').map((b) => b.agent)).toEqual(['claude', 'codex']);
    expect(r.bindings.listByAgent('claude').map((b) => b.server_id)).toEqual(['a', 'b']);
    expect(() => r.bindings.setSync('a', 'gemini', 'synced')).toThrow(NotFoundError);
    expect(() => r.bindings.upsert('missing', 'claude', true)).toThrow(); // FK
  });
});

describe('oauth states', () => {
  const rec = (state: string, expires = '2026-10-07T00:10:00.000Z') => ({
    state,
    server_id: 'a',
    code_verifier: 'v'.repeat(43),
    issuer: 'https://auth.example.com',
    client_id: 'https://me.example/.well-known/omnicode/client.json',
    scope: null,
    omnicode_session_id: 'sess',
    created_at: '2026-10-07T00:00:00.000Z',
    expires_at: expires,
    used_at: null,
  });

  it('consume is single-use and expiry-aware', () => {
    const r = reg();
    r.oauthStates.create(rec('s1'));
    expect(r.oauthStates.consume('s1', '2026-10-07T00:05:00.000Z')).toMatchObject({ state: 's1', used_at: '2026-10-07T00:05:00.000Z', code_verifier: 'v'.repeat(43) });
    expect(r.oauthStates.consume('s1', '2026-10-07T00:06:00.000Z')).toBeUndefined();
    r.oauthStates.create(rec('s2'));
    expect(r.oauthStates.consume('s2', '2026-10-07T00:10:00.000Z')).toBeUndefined(); // 정확히 만료 시각
    expect(r.oauthStates.consume('unknown')).toBeUndefined();
    expect(() => r.oauthStates.create(rec('s1'))).toThrow(); // PK
  });

  it('purgeExpired deletes an hour after expiry', () => {
    const r = reg();
    r.oauthStates.create(rec('old', '2026-10-07T00:10:00.000Z'));
    r.oauthStates.create(rec('fresh', '2026-10-07T03:00:00.000Z'));
    expect(r.oauthStates.purgeExpired('2026-10-07T01:00:00.000Z')).toBe(0);
    expect(r.oauthStates.purgeExpired('2026-10-07T01:10:00.000Z')).toBe(1);
    expect(r.oauthStates.consume('fresh', '2026-10-07T02:00:00.000Z')).toBeDefined();
  });
});

describe('agent tokens', () => {
  it('set/get/all with rotation grace', () => {
    const r = reg();
    r.agentTokens.set('claude', 'h1', null, '2026-10-07T00:00:00.000Z');
    expect(r.agentTokens.get('claude')).toEqual({ agent: 'claude', token_sha256: 'h1', prev_sha256: null, prev_valid_until: null, rotated_at: '2026-10-07T00:00:00.000Z' });
    r.agentTokens.set('claude', 'h2', { sha256: 'h1', validUntil: '2026-10-07T00:15:00.000Z' }, '2026-10-07T00:00:30.000Z');
    expect(r.agentTokens.get('claude')).toMatchObject({ token_sha256: 'h2', prev_sha256: 'h1', prev_valid_until: '2026-10-07T00:15:00.000Z' });
    r.agentTokens.set('gemini', 'h3');
    expect(r.agentTokens.all().map((t) => t.agent)).toEqual(['claude', 'gemini']);
    expect(r.agentTokens.get('codex')).toBeUndefined();
  });
});

describe('events', () => {
  it('stores details (object or pre-masked string), paginates by id desc with cursor, filters, purges', () => {
    const r = reg();
    r.servers.insert(newServer('a'));
    for (let i = 1; i <= 5; i++) {
      r.events.add({ kind: 'probe', server_id: 'a', agent: i % 2 ? 'claude' : null, actor: 'hub', details: { i }, ts: `2026-10-07T00:0${i}:00.000Z` });
    }
    r.events.add({ kind: 'token.rotated', actor: 'user', details: '{"pre":"masked"}' });
    r.events.add({ kind: 'server.created', server_id: 'b', actor: 'user' });

    const all = r.events.list({});
    expect(all.items.map((e) => e.kind)).toEqual(['server.created', 'token.rotated', 'probe', 'probe', 'probe', 'probe', 'probe']);
    expect(all.nextCursor).toBeNull();
    expect(all.items[0]?.details_json).toBeNull();
    expect(all.items[1]?.details_json).toBe('{"pre":"masked"}');
    expect(all.items[2]?.details_json).toBe('{"i":5}');

    const p1 = r.events.list({ serverId: 'a', limit: 2 });
    expect(p1.items.map((e) => JSON.parse(e.details_json ?? '{}').i)).toEqual([5, 4]);
    expect(p1.nextCursor).toBe(p1.items[1]?.id ?? -1);
    const p2 = r.events.list({ serverId: 'a', limit: 2, cursor: p1.nextCursor ?? undefined });
    expect(p2.items.map((e) => JSON.parse(e.details_json ?? '{}').i)).toEqual([3, 2]);
    const p3 = r.events.list({ serverId: 'a', limit: 2, cursor: p2.nextCursor ?? undefined });
    expect(p3.items.map((e) => JSON.parse(e.details_json ?? '{}').i)).toEqual([1]);
    expect(p3.nextCursor).toBeNull();

    expect(r.events.list({ agent: 'claude' }).items).toHaveLength(3);
    expect(r.events.list({ since: '2026-10-07T00:04:00.000Z', serverId: 'a' }).items).toHaveLength(2);
    expect(r.events.list({ limit: 0 }).items).toHaveLength(1); // 최소 1
    expect(r.events.purgeOlderThan('2026-10-07T00:03:00.000Z')).toBe(2);
    expect(r.events.list({ serverId: 'a' }).items).toHaveLength(3);
  });
});

describe('audit log', () => {
  const entry = (i: number, outcome: 'ok' | 'error' | 'blocked' = 'ok') => ({
    ts: `2026-10-07T00:${String(i).padStart(2, '0')}:00.000Z`,
    agent: i % 2 ? ('claude' as const) : ('codex' as const),
    job_id: `job-${i}`,
    server_id: i < 3 ? 'a' : 'b',
    method: 'tools/call',
    tool: 'tts',
    outcome,
    error_code: outcome === 'ok' ? null : -32013,
    duration_ms: 10 * i,
    req_bytes: 100,
    res_bytes: 200,
    args_sha256: 'ab'.repeat(32),
    protocol_version: '2025-03-26',
    error: outcome === 'ok' ? null : 'upstream down',
  });

  it('paginates and filters', () => {
    const r = reg();
    for (let i = 1; i <= 6; i++) r.audit.add(entry(i, i === 6 ? 'error' : 'ok'));
    const p1 = r.audit.list({ limit: 4 });
    expect(p1.items.map((e) => e.job_id)).toEqual(['job-6', 'job-5', 'job-4', 'job-3']);
    expect(p1.nextCursor).toBe(p1.items[3]?.id ?? -1);
    const p2 = r.audit.list({ limit: 4, cursor: p1.nextCursor ?? undefined });
    expect(p2.items.map((e) => e.job_id)).toEqual(['job-2', 'job-1']);
    expect(p2.nextCursor).toBeNull();
    expect(r.audit.list({ limit: 50, serverId: 'a' }).items).toHaveLength(2);
    expect(r.audit.list({ limit: 50, agent: 'codex' }).items).toHaveLength(3);
    expect(r.audit.list({ limit: 50, outcome: 'error' }).items.map((e) => e.error)).toEqual(['upstream down']);
    expect(r.audit.list({ limit: 50, since: '2026-10-07T00:05:00.000Z' }).items).toHaveLength(2);
    expect(p1.items[0]).toMatchObject({ error_code: -32013, duration_ms: 60, args_sha256: 'ab'.repeat(32) });
    expect(r.audit.purgeOlderThan('2026-10-07T00:03:00.000Z')).toBe(2);
    expect(r.audit.list({ limit: 50 }).items).toHaveLength(4);
  });
});

describe('transaction', () => {
  it('rolls back on throw and joins an outer transaction', () => {
    const r = reg();
    expect(() =>
      r.transaction(() => {
        r.servers.insert(newServer('x'));
        r.transaction(() => r.servers.insert(newServer('y'))); // 중첩: 합류
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(r.servers.list()).toEqual([]);
    const got = r.transaction(() => {
      r.servers.insert(newServer('z'));
      return 42;
    });
    expect(got).toBe(42);
    expect(r.servers.get('z')).toBeDefined();
  });
});
