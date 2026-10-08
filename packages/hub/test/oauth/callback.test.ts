import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULTS } from '@omnicode/shared';
import { startFakeAs, type FakeAs } from '../fixtures/fake-as.js';
import { addServer, CIMD_CLIENT_ID, createEnv, login, REDIRECT_URI, secretRefOf } from './fakes.js';

describe('OAuthManager.start / handleCallback (10.3 인가 요청·state·콜백)', () => {
  const servers: FakeAs[] = [];
  const as = async (...args: Parameters<typeof startFakeAs>): Promise<FakeAs> => {
    const s = await startFakeAs(...args);
    servers.push(s);
    return s;
  };
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it('builds an https authorization URL with PKCE S256, resource, scope and a stored 10-minute state', async () => {
    const auth = await as({ cimd: true, prm: { scopes: ['tts'] } });
    const env = createEnv();
    const server = addServer(env, auth);
    await env.manager.prepare(server.id);

    const { authorizationUrl, expiresAt } = await env.manager.start(server.id, { sessionId: 'sess-1' });

    const u = new URL(authorizationUrl);
    expect(`${u.origin}${u.pathname}`).toBe('https://as.example/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe(CIMD_CLIENT_ID);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')!.length).toBeGreaterThanOrEqual(43);
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(u.searchParams.get('resource')).toBe(auth.mcpUrl);
    expect(u.searchParams.get('scope')).toBe('tts');
    const state = u.searchParams.get('state')!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32바이트 base64url
    expect(expiresAt).toBe(env.clock.plus(DEFAULTS.oauthStateTtlMs));

    const rec = env.registry.oauthStates.rows.get(state)!;
    expect(rec).toMatchObject({
      server_id: server.id,
      issuer: auth.issuer,
      client_id: CIMD_CLIENT_ID,
      scope: 'tts',
      omnicode_session_id: 'sess-1',
      created_at: env.clock.iso(),
      expires_at: expiresAt,
      used_at: null,
    });
    expect(rec.code_verifier.length).toBeGreaterThanOrEqual(43);
    expect(env.registry.events.ofKind('auth.started', server.id)).toHaveLength(1);
  });

  it('rejects a non-https authorization endpoint and stores no state', async () => {
    const auth = await as({ cimd: true });
    auth.options.authorizationEndpoint = `${auth.url}/authorize`;
    const env = createEnv();
    const server = addServer(env, auth);
    await env.manager.prepare(server.id);

    await expect(env.manager.start(server.id)).rejects.toMatchObject({ code: 'invalid_url' });
    expect(env.registry.oauthStates.rows.size).toBe(0);
  });

  it('refuses to start before prepare or without a public URL', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    await expect(env.manager.start(server.id)).rejects.toMatchObject({ code: 'oauth_not_applicable' });

    const noPublic = createEnv({ config: { publicUrl: null } });
    const s2 = addServer(noPublic, auth);
    await noPublic.manager.prepare(s2.id);
    await expect(noPublic.manager.start(s2.id)).rejects.toMatchObject({ code: 'oauth_not_applicable' });
  });

  it('exchanges the code with PKCE and resource, persists tokens and moves to pending_approval', async () => {
    const auth = await as({ cimd: true, prm: { scopes: ['tts', 'voices'] } });
    const env = createEnv();
    const server = addServer(env, auth);
    await env.manager.prepare(server.id);
    const { authorizationUrl } = await env.manager.start(server.id, { sessionId: 'sess-2' });
    const { code, state } = auth.issueCode(authorizationUrl);

    const result = await env.manager.handleCallback({ code, state: state! }); // iss 없음: AS가 지원을 선언하지 않았으므로 허용

    expect(result).toEqual({ ok: true, serverId: server.id });
    const tokenReq = auth.requestsTo('/token');
    expect(tokenReq).toHaveLength(1);
    expect(tokenReq[0]!.form).toMatchObject({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      resource: auth.mcpUrl,
      client_id: CIMD_CLIENT_ID,
    });
    expect(tokenReq[0]!.form.code_verifier).toBe(env.registry.oauthStates.rows.get(state!)!.code_verifier);

    const issued = auth.issued[0]!;
    const secret = env.secrets.oauth(secretRefOf(server.id));
    expect(secret).toMatchObject({
      access_token: issued.access_token,
      refresh_token: issued.refresh_token,
      expires_at: env.clock.plus(3600 * 1000),
      scope: 'tts voices',
      obtained_at: env.clock.iso(),
      client_id: CIMD_CLIENT_ID,
    });
    const row = env.registry.servers.get(server.id)!;
    expect(row.status).toBe('pending_approval');
    expect(row.granted_scope).toBe('tts voices');
    expect(row.last_error).toBeNull();
    expect(env.registry.oauthStates.rows.get(state!)!.used_at).toBe(env.clock.iso());
    const completed = env.registry.events.ofKind('auth.completed', server.id);
    expect(completed).toHaveLength(1);
    expect(env.registry.events.details(completed[0]!)).toMatchObject({ scope: 'tts voices', hasRefreshToken: true, sessionId: 'sess-2' });
    expect(completed[0]!.details_json).not.toContain(issued.access_token);
    expect(await env.manager.expiresAt(server.id)).toBe(secret.expires_at);
  });

  it('moves to active when approved tools already exist (re-login of a previously approved server)', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    env.registry.tools.seed(server.id, 'tts', { approvedHash: 'b'.repeat(64) });

    await login(env, auth, server.id);

    expect(env.registry.servers.get(server.id)!.status).toBe('active');
  });

  it('stores expires_at null when the AS omits expires_in', async () => {
    const auth = await as({ cimd: true, accessTokenTtlSec: null });
    const env = createEnv();
    const server = addServer(env, auth);
    const secret = await login(env, auth, server.id);
    expect(secret.expires_at).toBeNull();
    expect(await env.manager.expiresAt(server.id)).toBeNull();
  });

  it('rejects an unknown state and never touches the token endpoint', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    addServer(env, auth);
    expect(await env.manager.handleCallback({ code: 'c', state: 'nope' })).toEqual({ ok: false, serverId: null, error: 'oauth_state_invalid' });
    expect(await env.manager.handleCallback({ code: 'c' })).toEqual({ ok: false, serverId: null, error: 'oauth_state_invalid' });
    expect(auth.count('/token')).toBe(0);
  });

  it('state is single-use', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    await env.manager.prepare(server.id);
    const { authorizationUrl } = await env.manager.start(server.id);
    const { code, state } = auth.issueCode(authorizationUrl);

    expect((await env.manager.handleCallback({ code, state: state! })).ok).toBe(true);
    const again = await env.manager.handleCallback({ code, state: state! });

    expect(again).toEqual({ ok: false, serverId: null, error: 'oauth_state_invalid' });
    expect(auth.count('/token')).toBe(1);
  });

  it('rejects an expired state (10 minutes)', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    await env.manager.prepare(server.id);
    const { authorizationUrl } = await env.manager.start(server.id);
    const { code, state } = auth.issueCode(authorizationUrl);

    env.clock.advance(DEFAULTS.oauthStateTtlMs + 1);
    const result = await env.manager.handleCallback({ code, state: state! });

    expect(result).toEqual({ ok: false, serverId: null, error: 'oauth_state_invalid' });
    expect(auth.count('/token')).toBe(0);
  });

  it('rejects an iss that differs from the recorded issuer', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    await env.manager.prepare(server.id);
    const { authorizationUrl } = await env.manager.start(server.id);
    const { code, state } = auth.issueCode(authorizationUrl);

    const result = await env.manager.handleCallback({ code, state: state!, iss: 'https://evil.example' });

    expect(result).toEqual({ ok: false, serverId: server.id, error: 'oauth_issuer_mismatch' });
    expect(auth.count('/token')).toBe(0);
    const row = env.registry.servers.get(server.id)!;
    expect(row.status).toBe('needs_auth');
    expect(row.last_error).toContain('iss');
    const failed = env.registry.events.ofKind('auth.failed', server.id);
    expect(failed).toHaveLength(1);
    expect(env.registry.events.details(failed[0]!)).toMatchObject({ reason: 'issuer_mismatch', expected: auth.issuer, received: 'https://evil.example' });
  });

  it('requires iss when the AS advertises authorization_response_iss_parameter_supported', async () => {
    const auth = await as({ cimd: true, issParam: true });
    const env = createEnv();
    const server = addServer(env, auth);
    await env.manager.prepare(server.id);

    const first = auth.issueCode((await env.manager.start(server.id)).authorizationUrl);
    expect(await env.manager.handleCallback({ code: first.code, state: first.state! })).toEqual({ ok: false, serverId: server.id, error: 'oauth_issuer_mismatch' });
    expect(auth.count('/token')).toBe(0);

    const second = auth.issueCode((await env.manager.start(server.id)).authorizationUrl);
    expect(await env.manager.handleCallback({ code: second.code, state: second.state!, iss: auth.issuer })).toEqual({ ok: true, serverId: server.id });
    expect(env.registry.servers.get(server.id)!.status).toBe('pending_approval');
  });

  it('an error callback consumes the state, keeps needs_auth with last_error and emits auth.failed', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    await env.manager.prepare(server.id);
    const { authorizationUrl } = await env.manager.start(server.id);
    const { state } = auth.issueCode(authorizationUrl);

    const result = await env.manager.handleCallback({ state: state!, error: 'access_denied', error_description: 'User cancelled' });

    expect(result).toEqual({ ok: false, serverId: server.id, error: 'oauth_denied' });
    const row = env.registry.servers.get(server.id)!;
    expect(row.status).toBe('needs_auth');
    expect(row.last_error).toContain('access_denied');
    expect(row.last_error).toContain('User cancelled');
    const failed = env.registry.events.ofKind('auth.failed', server.id);
    expect(failed).toHaveLength(1);
    expect(env.registry.events.details(failed[0]!)).toMatchObject({ reason: 'callback_error', error: 'access_denied' });
    expect(auth.count('/token')).toBe(0);
    // state는 소진됐다
    expect(await env.manager.handleCallback({ state: state!, code: 'whatever' })).toMatchObject({ ok: false, error: 'oauth_state_invalid' });
  });

  it('marks needs_auth when the token exchange is rejected by the AS', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    await env.manager.prepare(server.id);
    const { authorizationUrl } = await env.manager.start(server.id);
    const { code, state } = auth.issueCode(authorizationUrl);
    auth.options.tokenFailure = 'invalid_grant';

    const result = await env.manager.handleCallback({ code, state: state! });

    expect(result).toEqual({ ok: false, serverId: server.id, error: 'oauth_denied' });
    const row = env.registry.servers.get(server.id)!;
    expect(row.status).toBe('needs_auth');
    expect(row.last_error).toContain('invalid_grant');
    expect(env.secrets.oauth(secretRefOf(server.id)).access_token).toBeNull();
  });

  it('authenticates a confidential pre-registered client with client_secret_post at the token endpoint', async () => {
    const auth = await as({ tokenAuthMethods: ['client_secret_post', 'none'] });
    auth.addClient({ client_id: 'conf-1', client_secret: 'conf-secret-value' });
    const env = createEnv();
    const server = addServer(env, auth);
    await env.manager.prepare(server.id);
    await env.manager.setPreregisteredClient(server.id, 'conf-1', 'conf-secret-value');

    const { authorizationUrl } = await env.manager.start(server.id);
    const { code, state } = auth.issueCode(authorizationUrl);
    const result = await env.manager.handleCallback({ code, state: state!, iss: auth.issuer });

    expect(result.ok).toBe(true);
    const form = auth.requestsTo('/token')[0]!.form;
    expect(form.client_id).toBe('conf-1');
    expect(form.client_secret).toBe('conf-secret-value');
    expect(env.secrets.oauth(secretRefOf(server.id)).access_token).toBe(auth.issued[0]!.access_token);
  });

  it('uses the DCR-registered client for the exchange', async () => {
    const auth = await as({ dcr: true, dcrClientSecret: 'dcr-secret-value' });
    const env = createEnv();
    const server = addServer(env, auth);

    const secret = await login(env, auth, server.id);

    const form = auth.requestsTo('/token')[0]!.form;
    expect(form.client_id).toBe(secret.client_id);
    expect(form.client_secret).toBe('dcr-secret-value');
    expect(secret.access_token).toBe(auth.issued[0]!.access_token);
  });
});
