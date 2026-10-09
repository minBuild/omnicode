import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authed, json, makeApp, recent, type ErrorResponse, type TestApp } from './helpers.js';
import { GRACE_UNTIL, NOW } from './fakeHub.js';

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});
afterEach(async () => {
  await t.app.close();
});

describe('sync', () => {
  it('POST /api/mcp/sync applies and returns per-agent outcomes', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/mcp/sync', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(json<Record<string, { status: string }>>(res)).toMatchObject({ claude: { status: 'synced' }, codex: { status: 'synced' }, gemini: { status: 'synced' } });
    expect(t.hub.callsTo('sync.all')).toHaveLength(1);
  });

  it('GET /api/mcp/sync/plan returns the diff without applying', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/mcp/sync/plan', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(json<Record<string, { result: { added: string[] } }>>(res).claude?.result.added).toEqual(['omni-fish-audio']);
    expect(t.hub.callsTo('sync.all')).toHaveLength(0);
  });
});

describe('audit / events', () => {
  it('GET /api/mcp/audit applies defaults and passes the parsed query', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/mcp/audit', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(json<{ items: unknown[]; nextCursor: null }>(res)).toMatchObject({ nextCursor: null });
    expect(t.hub.callsTo('audit')[0]?.args[0]).toEqual({ limit: 50 });
  });

  it('GET /api/mcp/audit coerces and validates filters', async () => {
    const ok = await t.app.inject({
      method: 'GET',
      url: '/api/mcp/audit?serverId=fish-audio&agent=claude&outcome=ok&since=2026-10-07T00:00:00Z&cursor=10&limit=200',
      headers: authed,
    });
    expect(ok.statusCode).toBe(200);
    expect(t.hub.callsTo('audit')[0]?.args[0]).toEqual({
      serverId: 'fish-audio',
      agent: 'claude',
      outcome: 'ok',
      since: '2026-10-07T00:00:00Z',
      cursor: 10,
      limit: 200,
    });

    for (const bad of ['limit=201', 'limit=0', 'agent=cursor', 'serverId=Bad', 'outcome=maybe', 'since=yesterday', 'cursor=-1']) {
      const res = await t.app.inject({ method: 'GET', url: `/api/mcp/audit?${bad}`, headers: authed });
      expect(res.statusCode, bad).toBe(400);
      const body = json<ErrorResponse>(res);
      expect(body.error.code).toBe('validation_error');
      expect(body.error.details?.in).toBe('query');
    }
  });

  it('GET /api/mcp/events uses the same filters without outcome', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/mcp/events?serverId=fish-audio&limit=5', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(t.hub.callsTo('events')[0]?.args[0]).toEqual({ serverId: 'fish-audio', limit: 5 });
    const bad = await t.app.inject({ method: 'GET', url: '/api/mcp/events?limit=999', headers: authed });
    expect(bad.statusCode).toBe(400);
  });
});

describe('hub', () => {
  it('GET /api/mcp/hub/status', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/mcp/hub/status', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ version: '0.1.0-test', downstreamSessions: { legacy: 1, modern: 2 }, agentd: { ok: true } });
  });

  it('POST /api/mcp/hub/tokens/rotate validates agents and returns rotation times', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/mcp/hub/tokens/rotate', headers: recent, payload: { agents: ['claude', 'gemini'] } });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ rotatedAt: NOW, graceUntil: GRACE_UNTIL });
    expect(t.hub.callsTo('tokens.rotate')[0]?.args).toEqual([['claude', 'gemini']]);

    for (const payload of [{ agents: [] }, { agents: ['cursor'] }, {}]) {
      const bad = await t.app.inject({ method: 'POST', url: '/api/mcp/hub/tokens/rotate', headers: recent, payload });
      expect(bad.statusCode).toBe(400);
      expect(json<ErrorResponse>(bad).error.code).toBe('validation_error');
    }
    expect(t.hub.callsTo('tokens.rotate')).toHaveLength(1);
  });
});

describe('presets / registry', () => {
  it('GET /api/mcp/presets returns presets with URLs', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/mcp/presets', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(json<Array<{ id: string; url: string }>>(res)[0]).toMatchObject({ id: 'fish-audio', url: 'https://api.fish.audio/mcp' });
  });

  it('GET /api/mcp/registry/search passes q and cursor to the hub catalog', async () => {
    t.hub.registrySearch = { enabled: true, source: 'registry.example', items: [], nextCursor: 'n2' };
    const res = await t.app.inject({ method: 'GET', url: '/api/mcp/registry/search?q=fish&cursor=c1', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ enabled: true, source: 'registry.example', items: [], nextCursor: 'n2' });
    expect(t.hub.callsTo('catalog.search')[0]?.args).toEqual(['fish', 'c1']);
    const long = await t.app.inject({ method: 'GET', url: `/api/mcp/registry/search?q=${'x'.repeat(101)}`, headers: authed });
    expect(long.statusCode).toBe(400);
  });

  it('still requires a session for registry search', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/mcp/registry/search?q=fish' });
    expect(res.statusCode).toBe(401);
  });
});

describe('unknown routes', () => {
  it('answers 404 not_found as JSON', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/mcp/nope?x=1', headers: authed });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = json<ErrorResponse>(res);
    expect(body.error.code).toBe('not_found');
    expect(body.error.details).toEqual({ method: 'GET', path: '/api/mcp/nope' });
  });

  it('answers 404 as JSON for the root when no static dir is configured', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    expect(json<ErrorResponse>(res).error.code).toBe('not_found');
  });
});
