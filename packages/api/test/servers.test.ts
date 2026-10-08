import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerDetail, ServerSummary } from '@omnicode/shared';
import { UpstreamError } from '@omnicode/hub';
import { HASH_A, makeDetail } from './fakeHub.js';
import { authed, json, makeApp, recent, type ErrorResponse, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});
afterEach(async () => {
  await t.app.close();
});

describe('GET /api/mcp/servers', () => {
  it('returns summaries', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio', displayName: 'Fish Audio' }));
    const res = await t.app.inject({ method: 'GET', url: '/api/mcp/servers', headers: authed });
    expect(res.statusCode).toBe(200);
    const body = json<ServerSummary[]>(res);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: 'fish-audio', displayName: 'Fish Audio', toolCount: 1 });
    expect(body[0]).not.toHaveProperty('tools');
  });
});

describe('POST /api/mcp/servers', () => {
  it('creates a draft and returns 201 with the detail', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/mcp/servers',
      headers: authed,
      payload: { source: 'url', url: 'https://api.fish.audio/mcp', id: 'fish-audio', displayName: 'Fish Audio' },
    });
    expect(res.statusCode).toBe(201);
    const body = json<ServerDetail>(res);
    expect(body).toMatchObject({ id: 'fish-audio', displayName: 'Fish Audio', url: 'https://api.fish.audio/mcp', source: 'url' });
    expect(t.hub.callsTo('servers.create')[0]?.args[0]).toEqual({
      source: 'url',
      url: 'https://api.fish.audio/mcp',
      id: 'fish-audio',
      displayName: 'Fish Audio',
    });
  });

  it('rejects invalid bodies with 400 validation_error and zod issues', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/mcp/servers', headers: authed, payload: { source: 'url' } });
    expect(res.statusCode).toBe(400);
    const body = json<ErrorResponse>(res);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details?.in).toBe('body');
    const issues = body.error.details?.issues as Array<{ path: string; message: string }>;
    expect(issues.some((i) => i.path === 'url')).toBe(true);
    expect(t.hub.calls).toHaveLength(0);
  });

  it('rejects a bad id in the body', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/mcp/servers',
      headers: authed,
      payload: { source: 'url', url: 'https://a.example/mcp', id: 'Not Valid' },
    });
    expect(res.statusCode).toBe(400);
    expect(json<ErrorResponse>(res).error.code).toBe('validation_error');
  });

  it('passes a conflict ApiError from the hub through (409)', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio' }));
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/mcp/servers',
      headers: authed,
      payload: { source: 'url', url: 'https://a.example/mcp', id: 'fish-audio' },
    });
    expect(res.statusCode).toBe(409);
    expect(json<ErrorResponse>(res).error.code).toBe('conflict');
  });
});

describe('GET /api/mcp/servers/:id', () => {
  it('returns the detail', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio' }));
    const res = await t.app.inject({ method: 'GET', url: '/api/mcp/servers/fish-audio', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(json<ServerDetail>(res).tools[0]?.schemaHash).toBe(HASH_A);
  });

  it('404 not_found for an unknown id', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/mcp/servers/nope', headers: authed });
    expect(res.statusCode).toBe(404);
    expect(json<ErrorResponse>(res).error.code).toBe('not_found');
  });

  it('400 validation_error for a malformed id without touching the hub', async () => {
    for (const bad of ['Fish_Audio', 'a'.repeat(41), 'x%20y', 'UPPER']) {
      const res = await t.app.inject({ method: 'GET', url: `/api/mcp/servers/${bad}`, headers: authed });
      expect(res.statusCode, bad).toBe(400);
      expect(json<ErrorResponse>(res).error.code).toBe('validation_error');
      expect(json<ErrorResponse>(res).error.details?.in).toBe('params');
    }
    expect(t.hub.calls).toHaveLength(0);
  });

  it('validates :id on every server route', async () => {
    const routes: Array<[string, string]> = [
      ['PATCH', '/api/mcp/servers/BAD'],
      ['DELETE', '/api/mcp/servers/BAD'],
      ['POST', '/api/mcp/servers/BAD/delete/force'],
      ['PUT', '/api/mcp/servers/BAD/credentials'],
      ['POST', '/api/mcp/servers/BAD/oauth/client'],
      ['POST', '/api/mcp/servers/BAD/oauth/start'],
      ['POST', '/api/mcp/servers/BAD/approve'],
      ['POST', '/api/mcp/servers/BAD/probe'],
      ['POST', '/api/mcp/servers/BAD/test'],
    ];
    for (const [method, url] of routes) {
      const res = await t.app.inject({ method: method as 'GET', url, headers: recent, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(400);
      expect(json<ErrorResponse>(res).error.code).toBe('validation_error');
    }
    expect(t.hub.calls).toHaveLength(0);
  });
});

describe('PATCH /api/mcp/servers/:id', () => {
  it('applies the patch and returns the detail', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio', status: 'active' }));
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/mcp/servers/fish-audio',
      headers: authed,
      payload: { displayName: 'Fish', enabled: false, bindings: { gemini: false }, callTimeoutMs: 30_000, cliAutoApprove: true },
    });
    expect(res.statusCode).toBe(200);
    const body = json<ServerDetail>(res);
    expect(body).toMatchObject({ displayName: 'Fish', status: 'disabled', callTimeoutMs: 30_000, cliAutoApprove: true });
    expect(body.bindings.gemini.enabled).toBe(false);
    expect(body.bindings.claude.enabled).toBe(true);
  });

  it('rejects out-of-range values', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio' }));
    const res = await t.app.inject({ method: 'PATCH', url: '/api/mcp/servers/fish-audio', headers: authed, payload: { callTimeoutMs: 10 } });
    expect(res.statusCode).toBe(400);
    expect(t.hub.callsTo('servers.patch')).toHaveLength(0);
  });
});

describe('DELETE /api/mcp/servers/:id', () => {
  it('202 while the procedure is still running', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio' }));
    const res = await t.app.inject({ method: 'DELETE', url: '/api/mcp/servers/fish-audio', headers: authed });
    expect(res.statusCode).toBe(202);
    expect(json(res)).toMatchObject({ status: 'deleting' });
    expect(t.hub.callsTo('servers.delete')[0]?.args).toEqual(['fish-audio', undefined]);
  });

  it('200 once the row is gone', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio' }));
    t.hub.deleteStatus = 'deleted';
    const res = await t.app.inject({ method: 'DELETE', url: '/api/mcp/servers/fish-audio', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ status: 'deleted' });
  });

  it('force delete passes force: true (with recent auth)', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio' }));
    const res = await t.app.inject({ method: 'POST', url: '/api/mcp/servers/fish-audio/delete/force', headers: recent });
    expect(res.statusCode).toBe(202);
    expect(t.hub.callsTo('servers.delete')[0]?.args).toEqual(['fish-audio', { force: true }]);
  });

  it('404 for an unknown id', async () => {
    const res = await t.app.inject({ method: 'DELETE', url: '/api/mcp/servers/nope', headers: authed });
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /api/mcp/servers/:id/credentials', () => {
  const secret = 'sk-live-very-secret-value-123456';

  it('stores write-only credentials and answers 204 with no body', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio' }));
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/mcp/servers/fish-audio/credentials',
      headers: authed,
      payload: { headerName: 'Authorization', value: secret },
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(t.hub.callsTo('servers.setCredentials')[0]?.args).toEqual(['fish-audio', 'Authorization', secret]);

    const detail = await t.app.inject({ method: 'GET', url: '/api/mcp/servers/fish-audio', headers: authed });
    expect(detail.body).not.toContain(secret);
    expect(json<ServerDetail>(detail).auth).toMatchObject({ type: 'header', headerName: 'Authorization' });
  });

  it('never echoes a known secret in error responses (masking)', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio' }));
    await t.app.inject({
      method: 'PUT',
      url: '/api/mcp/servers/fish-audio/credentials',
      headers: authed,
      payload: { headerName: 'X-Api-Key', value: secret },
    });
    t.hub.failWith('servers.probe', new UpstreamError('protocol', `upstream rejected key ${secret}`));
    const res = await t.app.inject({ method: 'POST', url: '/api/mcp/servers/fish-audio/probe', headers: authed });
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain(secret);
    expect(res.body).toContain('***');
  });

  it('validates the header name and value', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio' }));
    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/mcp/servers/fish-audio/credentials',
      headers: authed,
      payload: { headerName: 'Bad Header', value: secret },
    });
    expect(bad.statusCode).toBe(400);
    const empty = await t.app.inject({
      method: 'PUT',
      url: '/api/mcp/servers/fish-audio/credentials',
      headers: authed,
      payload: { headerName: 'Authorization', value: '' },
    });
    expect(empty.statusCode).toBe(400);
    expect(t.hub.callsTo('servers.setCredentials')).toHaveLength(0);
  });
});

describe('OAuth routes', () => {
  it('POST oauth/client stores the preregistered client and returns the detail without the secret', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio', authType: 'oauth', auth: { ...makeDetail({ id: 'x' }).auth, type: 'oauth', needsClientInput: true } }));
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/mcp/servers/fish-audio/oauth/client',
      headers: authed,
      payload: { clientId: 'client-123', clientSecret: 'client-secret-abcdef-0123456789' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('client-secret-abcdef');
    expect(json<ServerDetail>(res).auth).toMatchObject({ clientMode: 'preregistered', needsClientInput: false });
    expect(t.hub.callsTo('oauth.setPreregisteredClient')[0]?.args).toEqual(['fish-audio', 'client-123', 'client-secret-abcdef-0123456789']);
  });

  it('POST oauth/client validates the body', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio' }));
    const res = await t.app.inject({ method: 'POST', url: '/api/mcp/servers/fish-audio/oauth/client', headers: authed, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('POST oauth/start returns the authorization URL and passes the session id', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio' }));
    const res = await t.app.inject({ method: 'POST', url: '/api/mcp/servers/fish-audio/oauth/start', headers: authed });
    expect(res.statusCode).toBe(200);
    const body = json<{ authorizationUrl: string; expiresAt: string }>(res);
    expect(body.authorizationUrl).toMatch(/^https:/);
    expect(body.expiresAt).toBeTruthy();
    expect(t.hub.callsTo('oauth.start')[0]?.args).toEqual(['fish-audio', { sessionId: 'sess-1' }]);
  });

  it('POST oauth/start → 404 for an unknown server', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/mcp/servers/nope/oauth/start', headers: authed });
    expect(res.statusCode).toBe(404);
  });
});

describe('approve / probe / test', () => {
  it('POST approve returns the ApproveResult', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio' }));
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/mcp/servers/fish-audio/approve',
      headers: authed,
      payload: { tools: [{ name: 'text_to_speech', schemaHash: HASH_A, enabled: true }], bindings: { claude: true, codex: true, gemini: false } },
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ status: string; approved: string[]; sync: Record<string, { status: string }> }>(res);
    expect(body.status).toBe('active');
    expect(body.approved).toEqual(['text_to_speech']);
    expect(body.sync.claude?.status).toBe('synced');
  });

  it('POST approve validates the schema hash format', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio' }));
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/mcp/servers/fish-audio/approve',
      headers: authed,
      payload: { tools: [{ name: 'text_to_speech', schemaHash: 'nope' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(t.hub.callsTo('servers.approve')).toHaveLength(0);
  });

  it('POST probe returns the refreshed detail', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio' }));
    const res = await t.app.inject({ method: 'POST', url: '/api/mcp/servers/fish-audio/probe', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(json<ServerDetail>(res).id).toBe('fish-audio');
    expect(t.hub.callsTo('servers.probe')).toHaveLength(1);
  });

  it('POST test returns the TestResult', async () => {
    t.hub.seed(makeDetail({ id: 'fish-audio' }));
    const res = await t.app.inject({ method: 'POST', url: '/api/mcp/servers/fish-audio/test', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true, latencyMs: 12, error: null, protocol: { era: 'modern', version: '2026-07-28' } });
  });
});
