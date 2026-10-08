import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '@omnicode/shared';
import { startFakeAs, type FakeAs } from '../fixtures/fake-as.js';
import { addServer, CIMD_CLIENT_ID, createEnv, PUBLIC_URL, REDIRECT_URI, secretRefOf, seedOAuthSecret } from './fakes.js';

describe('OAuthManager.prepare — discovery and registration precedence (10.3)', () => {
  const servers: FakeAs[] = [];
  const as = async (...args: Parameters<typeof startFakeAs>): Promise<FakeAs> => {
    const s = await startFakeAs(...args);
    servers.push(s);
    return s;
  };
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it('uses CIMD when the AS supports it and publicUrl is set, ahead of DCR', async () => {
    const auth = await as({ cimd: true, dcr: true, prm: { scopes: ['tts', 'voices'] } });
    const env = createEnv();
    const server = addServer(env, auth);

    const result = await env.manager.prepare(server.id);

    expect(result).toEqual({ issuer: auth.issuer, clientMode: 'cimd', scope: 'tts voices', needsClientInput: false });
    expect(auth.count('/register')).toBe(0);

    const row = env.registry.servers.get(server.id)!;
    expect(row).toMatchObject({
      auth_type: 'oauth',
      status: 'needs_auth',
      oauth_issuer: auth.issuer,
      oauth_client_mode: 'cimd',
      oauth_prm_url: auth.prmUrl,
      requested_scope: 'tts voices',
      canonical_url: auth.mcpUrl,
      secret_ref: secretRefOf(server.id),
    });
    expect(env.secrets.oauth(secretRefOf(server.id))).toEqual({
      type: 'oauth',
      issuer: auth.issuer,
      client_mode: 'cimd',
      client_id: CIMD_CLIENT_ID,
      client_secret: null,
      token_endpoint_auth_method: 'none',
      registration_access_token: null,
      registration_client_uri: null,
      resource: auth.mcpUrl,
      access_token: null,
      refresh_token: null,
      expires_at: null,
      scope: null,
      obtained_at: null,
    });
    const probe = env.registry.events.ofKind('probe', server.id);
    expect(probe).toHaveLength(1);
    expect(env.registry.events.details(probe[0]!)).toMatchObject({ oauth: { issuer: auth.issuer, clientMode: 'cimd', needsClientInput: false } });
    // 모든 outbound HTTP가 주입된 fetch를 거쳤다
    expect(env.fetchCalls.some((u) => u.startsWith(auth.url))).toBe(true);
  });

  it('prefers a pre-registered client over CIMD and DCR', async () => {
    const auth = await as({ cimd: true, dcr: true });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(
      env,
      server.id,
      auth,
      { client_mode: 'preregistered', client_id: 'pre-123', client_secret: 'pre-secret-xyz', token_endpoint_auth_method: 'client_secret_post', access_token: null, refresh_token: null, expires_at: null },
      { status: 'needs_auth' },
    );

    const result = await env.manager.prepare(server.id);

    expect(result.clientMode).toBe('preregistered');
    expect(result.needsClientInput).toBe(false);
    expect(auth.count('/register')).toBe(0);
    expect(env.secrets.oauth(secretRefOf(server.id))).toMatchObject({
      client_mode: 'preregistered',
      client_id: 'pre-123',
      client_secret: 'pre-secret-xyz',
      token_endpoint_auth_method: 'client_secret_post',
    });
    expect(env.registry.servers.get(server.id)!.oauth_client_mode).toBe('preregistered');
  });

  it('skips CIMD without publicUrl; DCR needs a redirect URI too, so client input is requested', async () => {
    const auth = await as({ cimd: true, dcr: true });
    const env = createEnv({ config: { publicUrl: null } });
    const server = addServer(env, auth);

    const result = await env.manager.prepare(server.id);

    expect(result.clientMode).not.toBe('cimd');
    expect(result.needsClientInput).toBe(true);
    expect(auth.count('/register')).toBe(0);
    expect(env.secrets.oauth(secretRefOf(server.id)).client_id).toBe('');
    await expect(env.manager.start(server.id)).rejects.toMatchObject({ code: 'oauth_not_applicable' });
  });

  it('falls back to DCR and persists the registration, including registration_access_token', async () => {
    const auth = await as({ dcr: true, prm: { scopes: ['tts'] } });
    const env = createEnv();
    const server = addServer(env, auth);

    const result = await env.manager.prepare(server.id);

    expect(result).toMatchObject({ clientMode: 'dcr', needsClientInput: false, scope: 'tts' });
    expect(auth.registrations).toHaveLength(1);
    expect(auth.registrations[0]).toEqual({
      client_name: 'OmniCode (omni.example)',
      client_uri: PUBLIC_URL,
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
      software_id: 'omnicode',
      software_version: env.config.version,
      scope: 'tts',
    });
    const secret = env.secrets.oauth(secretRefOf(server.id));
    expect(secret.client_mode).toBe('dcr');
    expect(secret.client_id).toMatch(/^dcr-/);
    expect(secret.client_secret).toBeNull();
    expect(secret.token_endpoint_auth_method).toBe('none');
    expect(secret.registration_access_token).toMatch(/^rat-/);
    expect(secret.registration_client_uri).toBe(`${auth.url}/register/${secret.client_id}`);

    // 같은 issuer로 다시 prepare하면 등록을 재사용한다
    await env.manager.prepare(server.id);
    expect(auth.count('/register')).toBe(1);
    expect(env.secrets.oauth(secretRefOf(server.id)).client_id).toBe(secret.client_id);
  });

  it('stores the client_secret and auth method when DCR issues a confidential client', async () => {
    const auth = await as({ dcr: true, dcrClientSecret: 'dcr-s3cr3t-value' });
    const env = createEnv();
    const server = addServer(env, auth);

    await env.manager.prepare(server.id);

    expect(env.secrets.oauth(secretRefOf(server.id))).toMatchObject({
      client_mode: 'dcr',
      client_secret: 'dcr-s3cr3t-value',
      token_endpoint_auth_method: 'client_secret_post',
    });
  });

  it('requests client input when neither CIMD nor DCR is available; setPreregisteredClient then unblocks start()', async () => {
    const auth = await as({});
    const env = createEnv();
    const server = addServer(env, auth);

    const result = await env.manager.prepare(server.id);
    expect(result).toMatchObject({ clientMode: 'preregistered', needsClientInput: true });
    expect(env.registry.servers.get(server.id)!.status).toBe('needs_auth');
    await expect(env.manager.start(server.id)).rejects.toMatchObject({ code: 'oauth_not_applicable', message: 'client_id가 필요합니다' });

    auth.addClient({ client_id: 'my-client', client_secret: 'my-client-secret' });
    await env.manager.setPreregisteredClient(server.id, 'my-client', 'my-client-secret');

    expect(env.registry.servers.get(server.id)!.status).toBe('needs_auth');
    expect(env.secrets.oauth(secretRefOf(server.id))).toMatchObject({
      client_mode: 'preregistered',
      client_id: 'my-client',
      client_secret: 'my-client-secret',
      token_endpoint_auth_method: 'client_secret_post',
      issuer: auth.issuer,
      resource: auth.mcpUrl,
    });
    expect(env.registry.events.ofKind('credentials.saved', server.id)).toHaveLength(1);
    const { authorizationUrl } = await env.manager.start(server.id);
    expect(new URL(authorizationUrl).searchParams.get('client_id')).toBe('my-client');
  });

  it('setPreregisteredClient without a secret uses token_endpoint_auth_method none and rejects before prepare', async () => {
    const auth = await as({});
    const env = createEnv();
    const server = addServer(env, auth);
    await expect(env.manager.setPreregisteredClient(server.id, 'x')).rejects.toMatchObject({ code: 'oauth_not_applicable' });
    await env.manager.prepare(server.id);
    await env.manager.setPreregisteredClient(server.id, 'public-client');
    expect(env.secrets.oauth(secretRefOf(server.id))).toMatchObject({ client_id: 'public-client', client_secret: null, token_endpoint_auth_method: 'none' });
  });

  it('scope: WWW-Authenticate wins over PRM scopes and is unioned with the existing requested_scope', async () => {
    const auth = await as({ cimd: true, prm: { scopes: ['a', 'b'] } });
    const env = createEnv();
    const server = addServer(env, auth, { requested_scope: 'x b' });

    const result = await env.manager.prepare(server.id, `Bearer realm="mcp", scope="b c", resource_metadata="${auth.prmUrl}"`);

    expect(result.scope).toBe('x b c');
    expect(env.registry.servers.get(server.id)!.requested_scope).toBe('x b c');
    expect(env.registry.servers.get(server.id)!.oauth_prm_url).toBe(auth.prmUrl);
  });

  it('uses PRM scopes_supported when the header has no scope, and null when neither has one', async () => {
    const withScopes = await as({ cimd: true, prm: { scopes: ['p', 'q'] } });
    const env = createEnv();
    const s1 = addServer(env, withScopes, { id: 's1' });
    expect((await env.manager.prepare(s1.id, 'Bearer realm="mcp"')).scope).toBe('p q');

    const noScopes = await as({ cimd: true });
    const s2 = addServer(env, noScopes, { id: 's2' });
    expect((await env.manager.prepare(s2.id)).scope).toBeNull();
    expect(env.registry.servers.get(s2.id)!.requested_scope).toBeNull();
  });

  it('falls back to AS metadata at the MCP server origin when there is no PRM (2025-03-26 behavior)', async () => {
    const auth = await as({ cimd: true, prm: { enabled: false } });
    const env = createEnv();
    const server = addServer(env, auth);

    const result = await env.manager.prepare(server.id);

    expect(result.issuer).toBe(auth.issuer);
    const row = env.registry.servers.get(server.id)!;
    expect(row.oauth_prm_url).toBeNull();
    expect(env.secrets.oauth(secretRefOf(server.id)).resource).toBe(auth.mcpUrl);
    // 경로 포함 → 루트 순으로 PRM을 찾아봤다
    expect(auth.count(`/.well-known/oauth-protected-resource/mcp`)).toBeGreaterThan(0);
    expect(auth.count('/.well-known/oauth-protected-resource')).toBeGreaterThan(0);
  });

  it('canonicalizes the server URL for the row (no trailing slash, no query/fragment) and accepts the PRM resource', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth, { url: `${auth.mcpUrl}/?x=1#frag` });

    await env.manager.prepare(server.id);

    const row = env.registry.servers.get(server.id)!;
    expect(row.canonical_url).toBe(auth.mcpUrl);
    expect(env.secrets.oauth(secretRefOf(server.id)).resource).toBe(auth.mcpUrl);
  });

  it('re-registers when the authorization server changes and discards credentials bound to the old issuer', async () => {
    const as1 = await as({ dcr: true });
    const as2 = await as({ dcr: true });
    const env = createEnv();
    const server = addServer(env, as1);

    await env.manager.prepare(server.id);
    const first = env.secrets.oauth(secretRefOf(server.id));
    expect(first.issuer).toBe(as1.issuer);
    // 로그인이 끝난 것처럼 토큰을 심고 active로 둔다
    env.secrets.values.set(secretRefOf(server.id), { ...first, access_token: 'at-old-000001', refresh_token: 'rt-old-000001', expires_at: env.clock.plus(3_600_000) });
    env.registry.servers.rows.get(server.id)!.status = 'active';

    as1.options.prm = { ...as1.options.prm, authorizationServers: [as2.url] };
    const result = await env.manager.prepare(server.id);

    expect(result).toMatchObject({ issuer: as2.issuer, clientMode: 'dcr', needsClientInput: false });
    expect(as2.count('/register')).toBe(1);
    const second = env.secrets.oauth(secretRefOf(server.id));
    expect(second.issuer).toBe(as2.issuer);
    expect(second.client_id).not.toBe(first.client_id);
    expect(second.access_token).toBeNull();
    expect(second.refresh_token).toBeNull();
    const row = env.registry.servers.get(server.id)!;
    expect(row.oauth_issuer).toBe(as2.issuer);
    expect(row.status).toBe('needs_auth');
    expect(row.last_error).toContain('인가 서버가 바뀌어');
    const updated = env.registry.events.ofKind('server.updated', server.id);
    expect(updated).toHaveLength(1);
    expect(env.registry.events.details(updated[0]!)).toMatchObject({ reason: 'oauth_issuer_changed', from: as1.issuer, to: as2.issuer });
  });

  it('keeps the CIMD client_id across an issuer change (but drops the old tokens)', async () => {
    const as1 = await as({ cimd: true });
    const as2 = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, as1);
    await env.manager.prepare(server.id);
    env.secrets.values.set(secretRefOf(server.id), { ...env.secrets.oauth(secretRefOf(server.id)), access_token: 'at-old-000002', refresh_token: 'rt-old-000002' });

    as1.options.prm = { ...as1.options.prm, authorizationServers: [as2.url] };
    const result = await env.manager.prepare(server.id);

    expect(result.clientMode).toBe('cimd');
    const secret = env.secrets.oauth(secretRefOf(server.id));
    expect(secret).toMatchObject({ issuer: as2.issuer, client_id: CIMD_CLIENT_ID, access_token: null, refresh_token: null });
  });

  it('switches auth_type none → oauth and rejects header/stdio_env servers and servers without a URL', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const ok = addServer(env, auth, { id: 'ok', auth_type: 'none' });
    await env.manager.prepare(ok.id);
    expect(env.registry.servers.get(ok.id)!.auth_type).toBe('oauth');

    const header = addServer(env, auth, { id: 'hdr', auth_type: 'header', header_name: 'X-API-Key' });
    await expect(env.manager.prepare(header.id)).rejects.toMatchObject({ code: 'oauth_not_applicable' });

    const noUrl = addServer(env, auth, { id: 'nourl', url: null });
    await expect(env.manager.prepare(noUrl.id)).rejects.toMatchObject({ code: 'invalid_url' });

    await expect(env.manager.prepare('missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('fails with oauth_registration_failed when no AS metadata can be found or the issuer does not match', async () => {
    const none = await as({ metadata: false, prm: { enabled: false } });
    const env = createEnv();
    const s1 = addServer(env, none, { id: 's1' });
    await expect(env.manager.prepare(s1.id)).rejects.toBeInstanceOf(ApiError);
    await expect(env.manager.prepare(s1.id)).rejects.toMatchObject({ code: 'oauth_registration_failed' });
    expect(env.registry.servers.get(s1.id)!.status).toBe('draft');

    const wrongIssuer = await as({ cimd: true, issuerOverride: 'https://someone-else.example' });
    const s2 = addServer(env, wrongIssuer, { id: 's2' });
    await expect(env.manager.prepare(s2.id)).rejects.toMatchObject({ code: 'oauth_registration_failed', message: expect.stringContaining('issuer') });
  });

  it('does not force a server with a valid token back to needs_auth when re-discovery changes nothing', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth, {}, { status: 'active' });

    const result = await env.manager.prepare(server.id);

    expect(result.clientMode).toBe('cimd');
    const row = env.registry.servers.get(server.id)!;
    expect(row.status).toBe('active');
    expect(env.secrets.oauth(secretRefOf(server.id)).access_token).toBe('at-seed-000001');
  });
});
