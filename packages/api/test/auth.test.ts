import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, createDevAuthHooks, DEV_COOKIE_NAME } from '../src/index.js';
import { FakeHub, makeDetail } from './fakeHub.js';
import { authed, json, makeApp, recent, type ErrorResponse } from './helpers.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe('auth gate', () => {
  it('rejects /api/mcp/* without a session (401 unauthenticated) before touching the hub', async () => {
    const { app, hub } = makeApp();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/api/mcp/servers' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(json<ErrorResponse>(res).error.code).toBe('unauthenticated');
    expect(hub.calls).toHaveLength(0);

    const post = await app.inject({ method: 'POST', url: '/api/mcp/servers', payload: { source: 'url', url: 'https://a.example/mcp' } });
    expect(post.statusCode).toBe(401);
    expect(hub.calls).toHaveLength(0);
  });

  it('requires recent auth for token rotation (401 reauth_required)', async () => {
    const { app, hub } = makeApp();
    apps.push(app);
    const res = await app.inject({ method: 'POST', url: '/api/mcp/hub/tokens/rotate', headers: authed, payload: { agents: ['claude'] } });
    expect(res.statusCode).toBe(401);
    expect(json<ErrorResponse>(res).error.code).toBe('reauth_required');
    expect(hub.callsTo('tokens.rotate')).toHaveLength(0);

    const ok = await app.inject({ method: 'POST', url: '/api/mcp/hub/tokens/rotate', headers: recent, payload: { agents: ['claude'] } });
    expect(ok.statusCode).toBe(200);
    expect(hub.callsTo('tokens.rotate')[0]?.args).toEqual([['claude']]);
  });

  it('requires recent auth for forced delete', async () => {
    const { app, hub } = makeApp();
    apps.push(app);
    hub.seed(makeDetail({ id: 'fish-audio' }));
    const res = await app.inject({ method: 'POST', url: '/api/mcp/servers/fish-audio/delete/force', headers: authed });
    expect(res.statusCode).toBe(401);
    expect(json<ErrorResponse>(res).error.code).toBe('reauth_required');
    expect(hub.callsTo('servers.delete')).toHaveLength(0);
  });

  it('public routes work without any session', async () => {
    const { app } = makeApp();
    apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/.well-known/omnicode/client.json' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/oauth/callback?code=c&state=s' })).statusCode).toBe(200);
  });
});

describe('createDevAuthHooks (DEV ONLY)', () => {
  const token = 'dev-token-0123456789abcdef';

  function devApp() {
    const hub = new FakeHub();
    const app = buildApp({ hub, auth: createDevAuthHooks({ token }), publicUrl: null });
    apps.push(app);
    return { app, hub };
  }

  it('accepts Authorization: Bearer <token>', async () => {
    const { app } = devApp();
    const res = await app.inject({ method: 'GET', url: '/api/mcp/servers', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });

  it('accepts the __Host-omnicode_dev cookie', async () => {
    const { app } = devApp();
    const res = await app.inject({ method: 'GET', url: '/api/mcp/servers', headers: { cookie: `${DEV_COOKIE_NAME}=${token}` } });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a wrong or missing token', async () => {
    const { app, hub } = devApp();
    const wrong = await app.inject({ method: 'GET', url: '/api/mcp/servers', headers: { authorization: `Bearer ${token}x` } });
    expect(wrong.statusCode).toBe(401);
    const shorter = await app.inject({ method: 'GET', url: '/api/mcp/servers', headers: { authorization: `Bearer ${token.slice(0, -1)}` } });
    expect(shorter.statusCode).toBe(401);
    const none = await app.inject({ method: 'GET', url: '/api/mcp/servers' });
    expect(none.statusCode).toBe(401);
    const basic = await app.inject({ method: 'GET', url: '/api/mcp/servers', headers: { authorization: `Basic ${token}` } });
    expect(basic.statusCode).toBe(401);
    expect(hub.calls).toHaveLength(0);
  });

  it('treats every authenticated request as recently re-authenticated', async () => {
    const { app } = devApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/hub/tokens/rotate',
      headers: { authorization: `Bearer ${token}` },
      payload: { agents: ['claude', 'codex'] },
    });
    expect(res.statusCode).toBe(200);
  });

  it('sessionIdOf is stable for the token and null otherwise', async () => {
    const hooks = createDevAuthHooks({ token });
    const withToken = { headers: { authorization: `Bearer ${token}` } } as never;
    const without = { headers: {} } as never;
    const id = hooks.sessionIdOf(withToken);
    expect(id).toMatch(/^dev:/);
    expect(id).not.toContain(token);
    expect(hooks.sessionIdOf(withToken)).toBe(id);
    expect(hooks.sessionIdOf(without)).toBeNull();
  });

  it('refuses short tokens', () => {
    expect(() => createDevAuthHooks({ token: 'short' })).toThrow();
  });
});
