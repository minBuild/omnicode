import { afterEach, describe, expect, it } from 'vitest';
import { canonicalResourceUrl, issuersEqual, parseWwwAuthenticate, unionScope } from '../../src/oauth/index.js';
import { startFakeAs, type FakeAs } from '../fixtures/fake-as.js';
import { addServer, createEnv, secretRefOf, seedOAuthSecret } from './fakes.js';

describe('scope step-up (10.3) and revocation (RFC 7009, 9.4)', () => {
  const servers: FakeAs[] = [];
  const as = async (...args: Parameters<typeof startFakeAs>): Promise<FakeAs> => {
    const s = await startFakeAs(...args);
    servers.push(s);
    return s;
  };
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it('onInsufficientScope unions scopes (dedup, stable order), sets needs_auth and records an event', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth, { requested_scope: 'tts voices' });
    seedOAuthSecret(env, server.id, auth);

    await env.manager.onInsufficientScope(server.id, 'voices admin  tts');

    const row = env.registry.servers.get(server.id)!;
    expect(row.requested_scope).toBe('tts voices admin');
    expect(row.status).toBe('needs_auth');
    expect(row.last_error).toContain('admin');
    const failed = env.registry.events.ofKind('auth.failed', server.id);
    expect(failed).toHaveLength(1);
    expect(env.registry.events.details(failed[0]!)).toMatchObject({ reason: 'insufficient_scope', scope: 'voices admin  tts', requestedScope: 'tts voices admin' });

    // 다음 로그인은 합집합 scope로 요청한다
    const { authorizationUrl } = await env.manager.start(server.id);
    expect(new URL(authorizationUrl).searchParams.get('scope')).toBe('tts voices admin');
  });

  it('unionScope helper', () => {
    expect(unionScope(null, null)).toBeNull();
    expect(unionScope('a b', '')).toBe('a b');
    expect(unionScope('a b', 'b c a d')).toBe('a b c d');
    expect(unionScope(undefined, '  x   y ')).toBe('x y');
  });

  it('revoke posts refresh then access token to the revocation endpoint and clears tokens but keeps the client', async () => {
    const auth = await as({ cimd: true, revocation: true });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth);

    await env.manager.revoke(server.id);

    expect(auth.revoked).toEqual([
      { token: 'rt-seed-000001', token_type_hint: 'refresh_token', client_id: expect.stringContaining('https://omni.example') },
      { token: 'at-seed-000001', token_type_hint: 'access_token', client_id: expect.stringContaining('https://omni.example') },
    ]);
    expect(auth.validRefreshTokens.has('rt-seed-000001')).toBe(false);
    expect(env.secrets.oauth(secretRefOf(server.id))).toMatchObject({
      client_mode: 'cimd',
      client_id: expect.stringContaining('/.well-known/omnicode/client.json'),
      issuer: auth.issuer,
      access_token: null,
      refresh_token: null,
      expires_at: null,
      scope: null,
      obtained_at: null,
    });
    expect(env.registry.servers.get(server.id)!.status).toBe('active'); // 상태 전이는 삭제 절차(9.4)가 맡는다
    expect(await env.manager.expiresAt(server.id)).toBeNull();
  });

  it('revoke is best effort: a failing revocation endpoint still clears the tokens', async () => {
    const auth = await as({ cimd: true, revocation: true, revokeStatus: 500 });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth);

    await expect(env.manager.revoke(server.id)).resolves.toBeUndefined();

    expect(auth.count('/revoke')).toBe(2);
    expect(env.secrets.oauth(secretRefOf(server.id)).access_token).toBeNull();
    expect(env.secrets.oauth(secretRefOf(server.id)).refresh_token).toBeNull();
  });

  it('revoke clears tokens when the AS has no revocation endpoint, and is a no-op without a secret', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth);

    await env.manager.revoke(server.id);
    expect(auth.count('/revoke')).toBe(0);
    expect(env.secrets.oauth(secretRefOf(server.id)).access_token).toBeNull();

    const bare = addServer(env, auth, { id: 'bare' });
    await expect(env.manager.revoke(bare.id)).resolves.toBeUndefined();
    await expect(env.manager.revoke('missing')).resolves.toBeUndefined();
    expect(env.secrets.puts).toBe(1);
  });

  it('revoke authenticates confidential clients with their secret', async () => {
    const auth = await as({ revocation: true, tokenAuthMethods: ['client_secret_post', 'none'] });
    auth.addClient({ client_id: 'conf-2', client_secret: 'conf-2-secret' });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth, { client_mode: 'preregistered', client_id: 'conf-2', client_secret: 'conf-2-secret', token_endpoint_auth_method: 'client_secret_post' });

    await env.manager.revoke(server.id);

    const forms = auth.requestsTo('/revoke').map((r) => r.form);
    expect(forms).toHaveLength(2);
    for (const f of forms) expect(f).toMatchObject({ client_id: 'conf-2', client_secret: 'conf-2-secret' });
    expect(auth.revoked.every((r) => r.client_id === 'conf-2')).toBe(true);
  });

  it('helpers: canonicalResourceUrl, issuersEqual, parseWwwAuthenticate', () => {
    expect(canonicalResourceUrl('HTTPS://Api.Example.com:443/mcp/?q=1#f')).toBe('https://api.example.com/mcp');
    expect(canonicalResourceUrl('https://api.example.com:8443/')).toBe('https://api.example.com:8443/');
    expect(canonicalResourceUrl('https://api.example.com')).toBe('https://api.example.com/');
    expect(issuersEqual('https://auth.example.com/', 'https://auth.example.com')).toBe(true);
    expect(issuersEqual('https://auth.example.com/a', 'https://auth.example.com/b')).toBe(false);
    expect(issuersEqual(null, 'x')).toBe(false);
    expect(parseWwwAuthenticate('Bearer realm="mcp", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource", scope="a b"')).toEqual({
      resourceMetadataUrl: 'https://api.example.com/.well-known/oauth-protected-resource',
      scope: 'a b',
      error: null,
    });
    expect(parseWwwAuthenticate('Bearer error="insufficient_scope", scope=admin')).toEqual({ resourceMetadataUrl: null, scope: 'admin', error: 'insufficient_scope' });
    expect(parseWwwAuthenticate(undefined)).toEqual({ resourceMetadataUrl: null, scope: null, error: null });
    expect(parseWwwAuthenticate('Basic realm="x"')).toEqual({ resourceMetadataUrl: null, scope: null, error: null });
  });
});
