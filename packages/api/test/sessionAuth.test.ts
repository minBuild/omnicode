/**
 * 운영 인증 (설계 0002) — buildApp + createSessionAuthHooks + 소프트웨어 인증기로 실제 WebAuthn 검증을 거친다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import {
  buildApp,
  createAuthService,
  createSessionAuthHooks,
  openAuthStore,
  SESSION_COOKIE_NAME,
  type AuthService,
  type AuthStore,
} from '../src/index.js';
import { FakeHub, makeDetail } from './fakeHub.js';
import { json, type ErrorResponse } from './helpers.js';
import { VirtualAuthenticator, type CreationOptionsLike, type RequestOptionsLike } from './virtualAuthenticator.js';

const ORIGIN = 'https://omni.example';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

interface World {
  app: FastifyInstance;
  hub: FakeHub;
  store: AuthStore;
  service: AuthService;
  auth: VirtualAuthenticator;
  setupToken: string;
  clock: { t: number };
  dataDir: string;
}

let w: World;

function makeWorld(hookOpts: { optionsPerMinute?: number; failuresPer10Min?: number } = {}): World {
  const clock = { t: Date.parse('2026-10-08T00:00:00Z') };
  const now = () => new Date(clock.t);
  const dataDir = mkdtempSync(join(tmpdir(), 'omni-auth-'));
  const store = openAuthStore(':memory:');
  const service = createAuthService({ store, origin: ORIGIN, rpId: 'omni.example', dataDir, now });
  const setup = service.ensureSetupToken();
  const hooks = createSessionAuthHooks(service, { ...hookOpts, now: () => clock.t });
  const hub = new FakeHub();
  const app = buildApp({ hub, auth: hooks, publicUrl: ORIGIN });
  return { app, hub, store, service, auth: new VirtualAuthenticator(ORIGIN), setupToken: setup.token as string, clock, dataDir };
}

beforeEach(() => {
  w = makeWorld();
});
afterEach(async () => {
  await w.app.close();
  w.store.close();
});

function sessionCookie(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = list.find((x) => x.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!c) throw new Error('no session cookie in response');
  return c;
}
const cookieHeader = (setCookie: string) => ({ cookie: setCookie.split(';')[0] as string });

async function post(url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return w.app.inject({ method: 'POST', url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

/** 설치 토큰으로 첫 패스키를 등록하고 세션 쿠키 헤더를 돌려준다 */
async function doSetup(label = '아이폰') {
  const opt = await post('/api/auth/setup/options', { setupToken: w.setupToken });
  expect(opt.statusCode).toBe(200);
  const { challengeId, options } = json<{ challengeId: string; options: CreationOptionsLike }>(opt);
  const response = w.auth.register(options);
  const res = await post('/api/auth/setup/verify', { setupToken: w.setupToken, challengeId, response, label });
  expect(res.statusCode, res.body).toBe(201);
  return cookieHeader(sessionCookie(res));
}

async function doLogin(tweaks: Parameters<VirtualAuthenticator['assert']>[1] = {}) {
  const opt = await post('/api/auth/login/options');
  expect(opt.statusCode).toBe(200);
  const { challengeId, options } = json<{ challengeId: string; options: RequestOptionsLike }>(opt);
  const response = w.auth.assert(options, tweaks);
  return post('/api/auth/login/verify', { challengeId, response });
}

async function doReauth(cookie: Record<string, string>) {
  const opt = await post('/api/auth/reauth/options', undefined, cookie);
  expect(opt.statusCode).toBe(200);
  const { challengeId, options } = json<{ challengeId: string; options: RequestOptionsLike }>(opt);
  return post('/api/auth/reauth/verify', { challengeId, response: w.auth.assert(options) }, cookie);
}

describe('first setup (0002 5.1)', () => {
  it('reports setupRequired and writes the setup token file with mode 0600', async () => {
    const status = await w.app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(json(status)).toMatchObject({ mode: 'session', authenticated: false, setupRequired: true, session: null });
    const file = join(w.dataDir, 'setup-token');
    expect(readFileSync(file, 'utf8').trim()).toBe(w.setupToken);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // 다시 호출해도 유효한 파일 토큰은 바꾸지 않는다
    expect(w.service.ensureSetupToken()).toMatchObject({ required: true, token: null });
  });

  it('rejects a wrong setup token with 403 and accepts the right one', async () => {
    const bad = await post('/api/auth/setup/options', { setupToken: 'x'.repeat(43) });
    expect(bad.statusCode).toBe(403);
    expect(json<ErrorResponse>(bad).error.code).toBe('setup_token_invalid');
    const cookie = await doSetup();
    expect(existsSync(join(w.dataDir, 'setup-token'))).toBe(false);
    const status = await w.app.inject({ method: 'GET', url: '/api/auth/status', headers: cookie });
    expect(json(status)).toMatchObject({ authenticated: true, setupRequired: false });
    expect(json<{ recentAuthUntil: string }>(status).recentAuthUntil).toBe(new Date(w.clock.t + 5 * MIN).toISOString());
  });

  it('sets a __Host- cookie with Secure, HttpOnly, SameSite=Lax and Path=/', async () => {
    const opt = await post('/api/auth/setup/options', { setupToken: w.setupToken });
    const { challengeId, options } = json<{ challengeId: string; options: CreationOptionsLike }>(opt);
    const res = await post('/api/auth/setup/verify', { setupToken: w.setupToken, challengeId, response: w.auth.register(options) });
    const c = sessionCookie(res);
    expect(c).toMatch(/; Path=\//);
    expect(c).toMatch(/; Secure/);
    expect(c).toMatch(/; HttpOnly/);
    expect(c).toMatch(/; SameSite=Lax/);
    expect(c).not.toMatch(/Domain=/i);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses a second setup once a passkey exists (409) and keeps the token single-use', async () => {
    await doSetup();
    const again = await post('/api/auth/setup/options', { setupToken: w.setupToken });
    expect(again.statusCode).toBe(409);
  });

  it('requires user verification and the right origin during registration', async () => {
    const opt = await post('/api/auth/setup/options', { setupToken: w.setupToken });
    const { challengeId, options } = json<{ challengeId: string; options: CreationOptionsLike }>(opt);
    const noUv = await post('/api/auth/setup/verify', { setupToken: w.setupToken, challengeId, response: w.auth.register(options, { uv: false }) });
    expect(json<ErrorResponse>(noUv).error.code).toBe('webauthn_failed');
    const opt2 = await post('/api/auth/setup/options', { setupToken: w.setupToken });
    const c2 = json<{ challengeId: string; options: CreationOptionsLike }>(opt2);
    const phish = await post('/api/auth/setup/verify', { setupToken: w.setupToken, challengeId: c2.challengeId, response: w.auth.register(c2.options, { origin: 'https://evil.example' }) });
    expect(json<ErrorResponse>(phish).error.code).toBe('webauthn_failed');
    expect(w.store.passkeys.count()).toBe(0);
  });
});

describe('login and session gate (0002 5.2, 6)', () => {
  it('logs in with the registered passkey and gates /api/mcp/*', async () => {
    await doSetup();
    const res = await doLogin();
    expect(res.statusCode).toBe(200);
    const cookie = cookieHeader(sessionCookie(res));
    expect((await w.app.inject({ method: 'GET', url: '/api/mcp/servers', headers: cookie })).statusCode).toBe(200);
    const none = await w.app.inject({ method: 'GET', url: '/api/mcp/servers' });
    expect(none.statusCode).toBe(401);
    expect(json<ErrorResponse>(none).error.code).toBe('unauthenticated');
    const forged = await w.app.inject({ method: 'GET', url: '/api/mcp/servers', headers: { cookie: `${SESSION_COOKIE_NAME}=${'a'.repeat(43)}` } });
    expect(forged.statusCode).toBe(401);
  });

  it('login options do not reveal credential ids', async () => {
    await doSetup();
    const opt = await post('/api/auth/login/options');
    expect(json<{ options: RequestOptionsLike }>(opt).options.allowCredentials ?? []).toEqual([]);
  });

  it('rejects reused challenges, foreign origins, missing UV and unknown user handles', async () => {
    await doSetup();
    const opt = await post('/api/auth/login/options');
    const { challengeId, options } = json<{ challengeId: string; options: RequestOptionsLike }>(opt);
    expect((await post('/api/auth/login/verify', { challengeId, response: w.auth.assert(options) })).statusCode).toBe(200);
    const reuse = await post('/api/auth/login/verify', { challengeId, response: w.auth.assert(options) });
    expect(json<ErrorResponse>(reuse).error.code).toBe('challenge_invalid');
    expect(json<ErrorResponse>(await doLogin({ origin: 'https://evil.example' })).error.code).toBe('webauthn_failed');
    expect(json<ErrorResponse>(await doLogin({ uv: false })).error.code).toBe('webauthn_failed');
    expect(json<ErrorResponse>(await doLogin({ userHandle: Buffer.alloc(32, 7).toString('base64url') })).error.code).toBe('webauthn_failed');
  });

  it('expires sessions after 7 idle days and after 30 days absolute', async () => {
    const cookie = await doSetup();
    w.clock.t += 6 * DAY;
    expect((await w.app.inject({ method: 'GET', url: '/api/mcp/servers', headers: cookie })).statusCode).toBe(200);
    w.clock.t += 7 * DAY + MIN;
    expect((await w.app.inject({ method: 'GET', url: '/api/mcp/servers', headers: cookie })).statusCode).toBe(401);

    const res = await doLogin();
    const fresh = cookieHeader(sessionCookie(res));
    for (let d = 0; d < 29; d++) {
      w.clock.t += DAY;
      expect((await w.app.inject({ method: 'GET', url: '/api/mcp/servers', headers: fresh })).statusCode, `day ${d}`).toBe(200);
    }
    w.clock.t += DAY + MIN;
    expect((await w.app.inject({ method: 'GET', url: '/api/mcp/servers', headers: fresh })).statusCode).toBe(401);
  });

  it('logout deletes the server-side session', async () => {
    const cookie = await doSetup();
    const out = await post('/api/auth/logout', undefined, cookie);
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(new RegExp(`${SESSION_COOKIE_NAME}=;`));
    expect((await w.app.inject({ method: 'GET', url: '/api/mcp/servers', headers: cookie })).statusCode).toBe(401);
  });

  it('authenticates before parsing bodies: an unauthenticated oversized body gets 401, not 413', async () => {
    const res = await w.app.inject({
      method: 'POST',
      url: '/api/mcp/servers',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ source: 'url', url: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('step-up re-authentication (0002 5.3)', () => {
  it('requires a passkey signature within 5 minutes for token rotation', async () => {
    const cookie = await doSetup();
    const rotate = () => post('/api/mcp/hub/tokens/rotate', { agents: ['claude'] }, cookie);
    expect((await rotate()).statusCode).toBe(200);
    w.clock.t += 5 * MIN + 1000;
    const denied = await rotate();
    expect(denied.statusCode).toBe(401);
    expect(json<ErrorResponse>(denied).error.code).toBe('reauth_required');
    const re = await doReauth(cookie);
    expect(re.statusCode).toBe(200);
    expect(json<{ recentAuthUntil: string }>(re).recentAuthUntil).toBe(new Date(w.clock.t + 5 * MIN).toISOString());
    expect((await rotate()).statusCode).toBe(200);
  });

  it('binds re-auth challenges to the session that asked for them', async () => {
    const a = await doSetup();
    const b = cookieHeader(sessionCookie(await doLogin()));
    const opt = await post('/api/auth/reauth/options', undefined, a);
    const { challengeId, options } = json<{ challengeId: string; options: RequestOptionsLike }>(opt);
    const stolen = await post('/api/auth/reauth/verify', { challengeId, response: w.auth.assert(options) }, b);
    expect(json<ErrorResponse>(stolen).error.code).toBe('challenge_invalid');
    expect((await post('/api/auth/reauth/options')).statusCode).toBe(401);
  });

  it('forced delete also needs recent auth', async () => {
    const cookie = await doSetup();
    w.hub.seed(makeDetail({ id: 'fish-audio' }));
    w.clock.t += 10 * MIN;
    const res = await post('/api/mcp/servers/fish-audio/delete/force', undefined, cookie);
    expect(json<ErrorResponse>(res).error.code).toBe('reauth_required');
  });
});

describe('passkeys and sessions management', () => {
  it('adds a second passkey (recent auth), refuses deleting the last one, deletes one of two', async () => {
    const cookie = await doSetup();
    const second = new VirtualAuthenticator(ORIGIN, false);
    const opt = await post('/api/auth/passkeys/options', undefined, cookie);
    expect(opt.statusCode).toBe(200);
    const { challengeId, options } = json<{ challengeId: string; options: CreationOptionsLike & { excludeCredentials?: Array<{ id: string }> } }>(opt);
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([w.auth.credentials[0]?.id]);
    const add = await post('/api/auth/passkeys/verify', { challengeId, response: second.register(options), label: '보안 키' }, cookie);
    expect(add.statusCode).toBe(201);
    expect(json(add)).toMatchObject({ label: '보안 키', deviceType: 'singleDevice', backedUp: false });

    const list = json<Array<{ id: string; label: string; backedUp: boolean }>>(await w.app.inject({ method: 'GET', url: '/api/auth/passkeys', headers: cookie }));
    expect(list.map((p) => p.label)).toEqual(['아이폰', '보안 키']);
    expect(list[0]?.backedUp).toBe(true);

    const firstId = list[0]?.id as string;
    expect((await w.app.inject({ method: 'DELETE', url: `/api/auth/passkeys/${firstId}`, headers: cookie })).statusCode).toBe(204);
    const last = await w.app.inject({ method: 'DELETE', url: `/api/auth/passkeys/${list[1]?.id}`, headers: cookie });
    expect(last.statusCode).toBe(409);

    // 지운 패스키로는 로그인할 수 없다
    expect(json<ErrorResponse>(await doLogin({ credentialId: firstId })).error.code).toBe('webauthn_failed');
    w.auth = second;
    expect((await doLogin()).statusCode).toBe(200);
  });

  it('adding a passkey without recent auth is refused', async () => {
    const cookie = await doSetup();
    w.clock.t += 6 * MIN;
    const res = await post('/api/auth/passkeys/options', undefined, cookie);
    expect(json<ErrorResponse>(res).error.code).toBe('reauth_required');
  });

  it('lists sessions, ends another session with recent auth, and ends its own as logout', async () => {
    const a = await doSetup();
    const b = cookieHeader(sessionCookie(await doLogin()));
    const sessions = json<Array<{ id: string; current: boolean }>>(await w.app.inject({ method: 'GET', url: '/api/auth/sessions', headers: a }));
    expect(sessions).toHaveLength(2);
    const other = sessions.find((s) => !s.current)?.id as string;
    const mine = sessions.find((s) => s.current)?.id as string;

    w.clock.t += 6 * MIN;
    const denied = await w.app.inject({ method: 'DELETE', url: `/api/auth/sessions/${other}`, headers: a });
    expect(json<ErrorResponse>(denied).error.code).toBe('reauth_required');
    await doReauth(a);
    expect((await w.app.inject({ method: 'DELETE', url: `/api/auth/sessions/${other}`, headers: a })).statusCode).toBe(204);
    expect((await w.app.inject({ method: 'GET', url: '/api/mcp/servers', headers: b })).statusCode).toBe(401);

    expect((await w.app.inject({ method: 'DELETE', url: `/api/auth/sessions/${mine}`, headers: a })).statusCode).toBe(204);
    expect((await w.app.inject({ method: 'GET', url: '/api/mcp/servers', headers: a })).statusCode).toBe(401);
  });
});

describe('request forgery and abuse (0002 7)', () => {
  it('rejects state-changing requests from another origin or a cross-site fetch', async () => {
    const cookie = await doSetup();
    const evil = await post('/api/mcp/hub/tokens/rotate', { agents: ['claude'] }, { ...cookie, origin: 'https://evil.example' });
    expect(evil.statusCode).toBe(403);
    expect(json<ErrorResponse>(evil).error.code).toBe('forbidden');
    const cross = await post('/api/mcp/hub/tokens/rotate', { agents: ['claude'] }, { ...cookie, 'sec-fetch-site': 'cross-site' });
    expect(cross.statusCode).toBe(403);
    const same = await post('/api/mcp/hub/tokens/rotate', { agents: ['claude'] }, { ...cookie, origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
    expect(same.statusCode).toBe(200);
    expect(w.hub.callsTo('tokens.rotate')).toHaveLength(1);
  });

  it('rate-limits public option requests per minute', async () => {
    await w.app.close();
    w.store.close();
    w = makeWorld({ optionsPerMinute: 3, failuresPer10Min: 100 });
    for (let i = 0; i < 3; i++) expect((await post('/api/auth/setup/options', { setupToken: w.setupToken })).statusCode).toBe(200);
    const limited = await post('/api/auth/setup/options', { setupToken: w.setupToken });
    expect(limited.statusCode).toBe(429);
    expect(json<ErrorResponse>(limited).error.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    w.clock.t += MIN;
    expect((await post('/api/auth/setup/options', { setupToken: w.setupToken })).statusCode).toBe(200);
  });

  it('blocks verification for 10 minutes after repeated failures (setup-token brute force)', async () => {
    await w.app.close();
    w.store.close();
    w = makeWorld({ optionsPerMinute: 100, failuresPer10Min: 2 });
    expect((await post('/api/auth/setup/options', { setupToken: 'y'.repeat(43) })).statusCode).toBe(403);
    expect((await post('/api/auth/setup/options', { setupToken: 'z'.repeat(43) })).statusCode).toBe(403);
    // 올바른 토큰이어도 실패 한도가 찬 동안은 막힌다
    const blocked = await post('/api/auth/setup/options', { setupToken: w.setupToken });
    expect(blocked.statusCode).toBe(429);
    w.clock.t += 10 * MIN;
    expect((await post('/api/auth/setup/options', { setupToken: w.setupToken })).statusCode).toBe(200);
  });
});

describe('OAuth callback uses the session only to decide the redirect', () => {
  it('redirects to the server page with a session, shows the page without one', async () => {
    const cookie = await doSetup();
    w.hub.callbackResult = { ok: true, serverId: 'fish-audio' };
    const withSession = await w.app.inject({ method: 'GET', url: '/oauth/callback?code=c&state=s', headers: cookie });
    expect(withSession.statusCode).toBe(303);
    expect(withSession.headers.location).toBe('/mcp/servers/fish-audio');
    const without = await w.app.inject({ method: 'GET', url: '/oauth/callback?code=c&state=s' });
    expect(without.statusCode).toBe(200);
  });
});

describe('recovery (0002 5.5)', () => {
  it('regenerates a setup token only while no passkey exists, and reset wipes everything', async () => {
    const t2 = w.service.regenerateSetupToken();
    expect(t2).not.toBe(w.setupToken);
    expect((await post('/api/auth/setup/options', { setupToken: w.setupToken })).statusCode).toBe(403);
    w.setupToken = t2;
    const cookie = await doSetup();
    expect(() => w.service.regenerateSetupToken()).toThrow();

    const r = w.service.resetAll();
    expect(r).toMatchObject({ passkeys: 1, sessions: 1 });
    expect(readFileSync(join(w.dataDir, 'setup-token'), 'utf8').trim()).toBe(r.token);
    expect((await w.app.inject({ method: 'GET', url: '/api/mcp/servers', headers: cookie })).statusCode).toBe(401);
    expect(json(await w.app.inject({ method: 'GET', url: '/api/auth/status' }))).toMatchObject({ setupRequired: true });
  });
});
