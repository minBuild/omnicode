import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULTS } from '@omnicode/shared';
import { UpstreamError } from '../../src/contracts.js';
import { createRefreshScheduler } from '../../src/oauth/index.js';
import { startFakeAs, type FakeAs } from '../fixtures/fake-as.js';
import { addServer, CIMD_CLIENT_ID, createEnv, secretRefOf, seedOAuthSecret } from './fakes.js';

describe('OAuthManager.headersFor / refresh (10.4 토큰 갱신)', () => {
  const servers: FakeAs[] = [];
  const as = async (...args: Parameters<typeof startFakeAs>): Promise<FakeAs> => {
    const s = await startFakeAs(...args);
    servers.push(s);
    return s;
  };
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it('returns the bearer header without refreshing when the token is not near expiry', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth, { expires_at: env.clock.plus(3_600_000) });

    expect(await env.manager.headersFor(server.id)).toEqual({ Authorization: 'Bearer at-seed-000001' });
    expect(auth.count('/token')).toBe(0);
  });

  it('refreshes when the token expires within 60s, rotating the refresh token and persisting once', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth, { expires_at: env.clock.plus(DEFAULTS.refreshAtCallAheadMs - 1000) });

    const headers = await env.manager.headersFor(server.id);

    const issued = auth.issued[0]!;
    expect(issued.grant).toBe('refresh_token');
    expect(headers).toEqual({ Authorization: `Bearer ${issued.access_token}` });
    expect(auth.count('/token')).toBe(1);
    expect(auth.requestsTo('/token')[0]!.form).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'rt-seed-000001',
      resource: auth.mcpUrl,
      client_id: CIMD_CLIENT_ID,
    });
    expect(env.secrets.puts).toBe(1);
    expect(env.secrets.oauth(secretRefOf(server.id))).toMatchObject({
      access_token: issued.access_token,
      refresh_token: issued.refresh_token,
      expires_at: env.clock.plus(3600 * 1000),
      obtained_at: env.clock.iso(),
      scope: 'tts',
    });
    expect(issued.refresh_token).not.toBe('rt-seed-000001');
    expect(auth.validRefreshTokens.has('rt-seed-000001')).toBe(false);
    expect(env.registry.servers.get(server.id)!.status).toBe('active');
  });

  it('refreshes an already-expired token', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth, { expires_at: env.clock.plus(-10_000) });

    const headers = await env.manager.headersFor(server.id);

    expect(headers.Authorization).toBe(`Bearer ${auth.issued[0]!.access_token}`);
  });

  it('keeps the old refresh token when the AS does not rotate', async () => {
    const auth = await as({ cimd: true, rotateRefreshTokens: false });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth, { expires_at: env.clock.plus(1_000) });

    await env.manager.headersFor(server.id);

    expect(env.secrets.oauth(secretRefOf(server.id)).refresh_token).toBe('rt-seed-000001');
  });

  it('issues exactly one token request for concurrent callers (single-flight)', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth, { expires_at: env.clock.plus(5_000) });

    const results = await Promise.all(Array.from({ length: 8 }, () => env.manager.headersFor(server.id)));

    expect(auth.count('/token')).toBe(1);
    const expected = `Bearer ${auth.issued[0]!.access_token}`;
    for (const r of results) expect(r.Authorization).toBe(expected);
    expect(env.secrets.puts).toBe(1);
  });

  it('invalid_grant → needs_auth, auth.failed, UpstreamError(unauthorized)', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth, { expires_at: env.clock.plus(1_000) }, { registerRefreshToken: false });

    await expect(env.manager.headersFor(server.id)).rejects.toSatisfy((e: unknown) => e instanceof UpstreamError && e.kind === 'unauthorized');

    const row = env.registry.servers.get(server.id)!;
    expect(row.status).toBe('needs_auth');
    expect(row.last_error).toContain('invalid_grant');
    const failed = env.registry.events.ofKind('auth.failed', server.id);
    expect(failed).toHaveLength(1);
    expect(env.registry.events.details(failed[0]!)).toMatchObject({ reason: 'refresh_failed', error: 'invalid_grant' });
    // 토큰은 그대로 남아 있고(사용자는 다시 로그인), 두 번째 호출도 같은 결과
    await expect(env.manager.headersFor(server.id)).rejects.toSatisfy((e: unknown) => e instanceof UpstreamError && e.kind === 'unauthorized');
  });

  it('5xx with a still-valid token → returns the current token and keeps the status', async () => {
    const auth = await as({ cimd: true, tokenFailure: 'server_error' });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth, { expires_at: env.clock.plus(30_000) });

    expect(await env.manager.headersFor(server.id)).toEqual({ Authorization: 'Bearer at-seed-000001' });

    expect(auth.count('/token')).toBe(1);
    expect(env.registry.servers.get(server.id)!.status).toBe('active');
    expect(env.registry.events.ofKind('auth.failed', server.id)).toHaveLength(0);
  });

  it('5xx / network failure with an expired token → UpstreamError(unavailable), status kept', async () => {
    const auth = await as({ cimd: true, tokenFailure: 'server_error' });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth, { expires_at: env.clock.plus(-1_000) });

    await expect(env.manager.headersFor(server.id)).rejects.toSatisfy((e: unknown) => e instanceof UpstreamError && e.kind === 'unavailable');
    expect(env.registry.servers.get(server.id)!.status).toBe('active');

    auth.options.tokenFailure = 'network';
    await expect(env.manager.headersFor(server.id)).rejects.toSatisfy((e: unknown) => e instanceof UpstreamError && e.kind === 'unavailable');
    expect(env.registry.servers.get(server.id)!.status).toBe('active');

    auth.options.tokenFailure = 'temporarily_unavailable';
    await expect(env.manager.headersFor(server.id)).rejects.toSatisfy((e: unknown) => e instanceof UpstreamError && e.kind === 'unavailable');
    expect(env.registry.servers.get(server.id)!.status).toBe('active');
  });

  it('no access token → UpstreamError(unauthorized)', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth, { access_token: null, refresh_token: null, expires_at: null }, { status: 'needs_auth' });
    await expect(env.manager.headersFor(server.id)).rejects.toSatisfy((e: unknown) => e instanceof UpstreamError && e.kind === 'unauthorized');
    await expect(env.manager.headersFor('missing')).rejects.toSatisfy((e: unknown) => e instanceof UpstreamError && e.kind === 'unauthorized');
  });

  it('expired token without a refresh token → needs_auth + unauthorized; unknown expiry is used as-is', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const expired = addServer(env, auth, { id: 'expired' });
    seedOAuthSecret(env, expired.id, auth, { refresh_token: null, expires_at: env.clock.plus(-1) });
    await expect(env.manager.headersFor(expired.id)).rejects.toSatisfy((e: unknown) => e instanceof UpstreamError && e.kind === 'unauthorized');
    expect(env.registry.servers.get(expired.id)!.status).toBe('needs_auth');

    const unknown = addServer(env, auth, { id: 'unknown' });
    seedOAuthSecret(env, unknown.id, auth, { expires_at: null });
    expect(await env.manager.headersFor(unknown.id)).toEqual({ Authorization: 'Bearer at-seed-000001' });
    expect(auth.count('/token')).toBe(0);
  });

  it('onUnauthorized: a successful refresh answers retry', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth, { expires_at: env.clock.plus(3_600_000) });

    expect(await env.manager.onUnauthorized(server.id, 'Bearer realm="mcp", error="invalid_token"')).toBe('retry');

    expect(auth.count('/token')).toBe(1);
    expect(env.secrets.oauth(secretRefOf(server.id)).access_token).toBe(auth.issued[0]!.access_token);
    expect(env.registry.servers.get(server.id)!.status).toBe('active');
  });

  it('onUnauthorized: a failed refresh answers needs_auth and records last_error', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth, {}, { registerRefreshToken: false });

    expect(await env.manager.onUnauthorized(server.id)).toBe('needs_auth');
    expect(env.registry.servers.get(server.id)!.status).toBe('needs_auth');
    expect(env.registry.events.ofKind('auth.failed', server.id)).toHaveLength(1);

    const noRefresh = addServer(env, auth, { id: 'norefresh' });
    seedOAuthSecret(env, noRefresh.id, auth, { refresh_token: null });
    expect(await env.manager.onUnauthorized(noRefresh.id)).toBe('needs_auth');
    expect(env.registry.servers.get(noRefresh.id)!.status).toBe('needs_auth');
    expect(env.registry.servers.get(noRefresh.id)!.last_error).toContain('refresh token');
  });

  it('onUnauthorized: transient failure also answers needs_auth (the token was just rejected)', async () => {
    const auth = await as({ cimd: true, tokenFailure: 'server_error' });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth);

    expect(await env.manager.onUnauthorized(server.id)).toBe('needs_auth');
    expect(env.registry.servers.get(server.id)!.status).toBe('needs_auth');
  });

  it('onUnauthorized: insufficient_scope delegates to the scope union and does not refresh', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth, { requested_scope: 'tts' });
    seedOAuthSecret(env, server.id, auth);

    expect(await env.manager.onUnauthorized(server.id, 'Bearer error="insufficient_scope", scope="tts admin"')).toBe('needs_auth');

    const row = env.registry.servers.get(server.id)!;
    expect(row.requested_scope).toBe('tts admin');
    expect(row.status).toBe('needs_auth');
    expect(auth.count('/token')).toBe(0);
  });

  it('refresh(): skips unless expiring within aheadMs, force refreshes anyway', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const soon = addServer(env, auth, { id: 'soon' });
    seedOAuthSecret(env, soon.id, auth, { expires_at: env.clock.plus(4 * 60_000) });
    const later = addServer(env, auth, { id: 'later' });
    seedOAuthSecret(env, later.id, auth, { access_token: 'at-seed-000002', refresh_token: 'rt-seed-000002', expires_at: env.clock.plus(60 * 60_000) });

    expect(await env.manager.refresh(soon.id, { aheadMs: DEFAULTS.refreshAheadMs })).toMatchObject({ status: 'refreshed', expiresAt: env.clock.plus(3600 * 1000) });
    expect(await env.manager.refresh(later.id, { aheadMs: DEFAULTS.refreshAheadMs })).toEqual({ status: 'skipped', reason: 'not_expiring' });
    expect(await env.manager.refresh(later.id, { force: true })).toMatchObject({ status: 'refreshed' });
    expect(await env.manager.refresh('missing')).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(auth.count('/token')).toBe(2);
  });

  it('scheduler refreshes servers expiring within aheadMs, skips the rest and purges expired states', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const s1 = addServer(env, auth, { id: 's1' });
    seedOAuthSecret(env, s1.id, auth, { expires_at: env.clock.plus(2 * 60_000) });
    const s2 = addServer(env, auth, { id: 's2' });
    seedOAuthSecret(env, s2.id, auth, { access_token: 'at-seed-000002', refresh_token: 'rt-seed-000002', expires_at: env.clock.plus(60 * 60_000) });
    const s3 = addServer(env, auth, { id: 's3' });
    seedOAuthSecret(env, s3.id, auth, { access_token: 'at-seed-000003', refresh_token: 'rt-seed-000003', expires_at: env.clock.plus(60_000) }, { status: 'needs_auth' });
    env.registry.oauthStates.create({
      state: 'old', server_id: s1.id, code_verifier: 'v', issuer: auth.issuer, client_id: CIMD_CLIENT_ID, scope: null,
      omnicode_session_id: null, created_at: env.clock.plus(-20 * 60_000), expires_at: env.clock.plus(-10 * 60_000), used_at: null,
    });

    const scheduler = createRefreshScheduler(env.manager, env.registry, { aheadMs: DEFAULTS.refreshAheadMs, intervalMs: 60_000, now: () => env.clock.now() });
    const sweep = await scheduler.runOnce();

    expect(sweep).toMatchObject({ scanned: 2, refreshed: ['s1'], skipped: ['s2'], failed: [], purgedStates: 1 });
    expect(auth.count('/token')).toBe(1);
    expect(env.registry.oauthStates.rows.has('old')).toBe(false);
    expect(scheduler.running).toBe(false);
    scheduler.start();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });

  it('scheduler backs off after a transient failure and retries once the backoff elapses', async () => {
    const auth = await as({ cimd: true, tokenFailure: 'server_error' });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth, { expires_at: env.clock.plus(60_000) });
    const scheduler = createRefreshScheduler(env.manager, env.registry, { aheadMs: DEFAULTS.refreshAheadMs, backoffBaseMs: 30_000, now: () => env.clock.now() });

    expect((await scheduler.runOnce()).failed).toEqual([{ serverId: server.id, kind: 'transient', error: expect.stringContaining('HTTP 500') }]);
    expect(auth.count('/token')).toBe(1);
    expect((await scheduler.runOnce()).skipped).toEqual([server.id]);
    expect(auth.count('/token')).toBe(1);

    env.clock.advance(31_000);
    auth.options.tokenFailure = null;
    expect((await scheduler.runOnce()).refreshed).toEqual([server.id]);
    expect(auth.count('/token')).toBe(2);
    expect(env.registry.servers.get(server.id)!.status).toBe('active');
  });
});
