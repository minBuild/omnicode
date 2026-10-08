import { afterEach, describe, expect, it } from 'vitest';
import type { HubConfig } from '../../src/contracts.js';
import { findAuthorizationServerMetadata, legacyDefaultMetadata } from '../../src/oauth/discovery.js';
import { startFakeAs, type FakeAs, type FakeAsOptions } from '../fixtures/fake-as.js';
import {
  addServer,
  CIMD_CLIENT_ID,
  createEnv,
  followAuthorization,
  login,
  REDIRECT_URI,
  restartManager,
  secretRefOf,
  seedOAuthSecret,
} from './fakes.js';

/**
 * 메타데이터가 전혀 없는 2025-03-26 이전 서버의 (가상) https 오리진. 주입 fetch가 가짜 서버로 연결한다.
 * 인가 URL은 https여야 하므로(10.3) 기본 /authorize를 끝까지 시험하려면 https 오리진이 필요하다.
 */
const LEGACY = 'https://legacy.example';
const LEGACY_MCP = `${LEGACY}/mcp`;

const servers: FakeAs[] = [];
const as = async (options: FakeAsOptions = {}): Promise<FakeAs> => {
  const s = await startFakeAs(options);
  servers.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** 기본 엔드포인트만 가진 가짜 서버 + LEGACY 오리진으로 연결된 테스트 환경 + 등록된 서버 */
async function legacy(options: FakeAsOptions = {}, config: Partial<HubConfig> = {}) {
  const s = await as({ noMetadata: true, ...options });
  const hosts = { [LEGACY]: s.url };
  const env = createEnv({ config, hosts });
  const server = addServer(env, s, { url: LEGACY_MCP });
  return { s, env, server, hosts };
}

describe('10.3 탐색 폴백 — 메타데이터가 전혀 없는 서버는 2025-03-26 기본 엔드포인트', () => {
  it('uses /authorize, /token and /register at the MCP server origin when there is no PRM and no AS metadata, and records the fallback', async () => {
    const { s, env, server } = await legacy();
    // 2025-03-26 이전 서버의 401에는 resource_metadata가 없다
    const www = (await fetch(s.mcpUrl, { method: 'POST' })).headers.get('www-authenticate');
    expect(www).toBe('Bearer realm="mcp"');

    const result = await env.manager.prepare(server.id, www ?? undefined);

    // CIMD는 광고되지 않았으므로(publicUrl이 https여도) DCR을 기본 /register로 한다
    expect(result).toEqual({ issuer: LEGACY, clientMode: 'dcr', scope: null, needsClientInput: false });
    // 탐색 순서: PRM(경로 → 루트) → RFC 8414 → OIDC → 기본 /register. 모두 주입 fetch를 거쳤다
    expect(env.fetchCalls).toEqual([
      `${LEGACY}/.well-known/oauth-protected-resource/mcp`,
      `${LEGACY}/.well-known/oauth-protected-resource`,
      `${LEGACY}/.well-known/oauth-authorization-server`,
      `${LEGACY}/.well-known/openid-configuration`,
      `${LEGACY}/register`,
    ]);
    expect(s.registrations).toHaveLength(1);
    expect(s.registrations[0]).toMatchObject({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none', software_id: 'omnicode' });

    const secret = env.secrets.oauth(secretRefOf(server.id));
    expect(secret).toMatchObject({ issuer: LEGACY, client_mode: 'dcr', resource: LEGACY_MCP, access_token: null });
    expect(secret.client_id).toMatch(/^dcr-/);
    expect(env.registry.servers.get(server.id)).toMatchObject({
      status: 'needs_auth',
      oauth_issuer: LEGACY,
      oauth_client_mode: 'dcr',
      oauth_prm_url: null,
      canonical_url: LEGACY_MCP,
    });
    const probe = env.registry.events.ofKind('probe', server.id);
    expect(probe).toHaveLength(1);
    expect(env.registry.events.details(probe[0]!)).toMatchObject({
      oauth: { issuer: LEGACY, clientMode: 'dcr', metadataFallback: true, metadataUrl: null, prmUrl: null },
    });
  });

  it('logs in against the default endpoints: browser at /authorize, code exchange at /token without iss, refresh at /token', async () => {
    const { s, env, server, hosts } = await legacy();
    await env.manager.prepare(server.id);
    const { authorizationUrl } = await env.manager.start(server.id, { sessionId: 'sess-legacy' });

    const u = new URL(authorizationUrl);
    expect(`${u.origin}${u.pathname}`).toBe(`${LEGACY}/authorize`);
    const registered = env.secrets.oauth(secretRefOf(server.id));
    expect(u.searchParams.get('client_id')).toBe(registered.client_id);
    expect(u.searchParams.get('resource')).toBe(LEGACY_MCP);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(env.registry.oauthStates.rows.get(u.searchParams.get('state')!)!.issuer).toBe(LEGACY);

    // 브라우저가 기본 /authorize에서 동의하고 콜백으로 돌아온다. 메타데이터가 없으니 iss를 요구하지 않는다
    const back = await followAuthorization(authorizationUrl, hosts);
    expect(`${back.location.origin}${back.location.pathname}`).toBe(REDIRECT_URI);
    expect(back.iss).toBeNull();
    expect(await env.manager.handleCallback({ code: back.code, state: back.state })).toEqual({ ok: true, serverId: server.id });

    expect(env.fetchCalls.at(-1)).toBe(`${LEGACY}/token`);
    expect(s.requestsTo('/token')[0]!.form).toMatchObject({
      grant_type: 'authorization_code',
      code: back.code,
      redirect_uri: REDIRECT_URI,
      resource: LEGACY_MCP,
      client_id: registered.client_id,
    });
    const issued = s.issued[0]!;
    expect(env.secrets.oauth(secretRefOf(server.id))).toMatchObject({ access_token: issued.access_token, refresh_token: issued.refresh_token });
    expect(env.registry.servers.get(server.id)!.status).toBe('pending_approval');

    // refresh도 기본 /token으로. 캐시된 합성 메타데이터를 쓰므로 메타데이터 위치를 다시 묻지 않는다
    const before = env.fetchCalls.length;
    expect(await env.manager.refresh(server.id, { force: true })).toMatchObject({ status: 'refreshed' });
    expect(env.fetchCalls.slice(before)).toEqual([`${LEGACY}/token`]);
    expect(s.requestsTo('/token')[1]!.form).toMatchObject({ grant_type: 'refresh_token', refresh_token: issued.refresh_token, resource: LEGACY_MCP });
  });

  it('after a restart (cold cache) re-derives the defaults for a server recorded without PRM and refreshes at /token', async () => {
    const { s, env, server } = await legacy();
    await login(env, s, server.id, { iss: false });
    restartManager(env);
    const before = env.fetchCalls.length;

    expect(await env.manager.refresh(server.id, { force: true })).toMatchObject({ status: 'refreshed' });

    // 메타데이터가 여전히 없음을 확인한 뒤 기본 /token
    expect(env.fetchCalls.slice(before)).toEqual([
      `${LEGACY}/.well-known/oauth-authorization-server`,
      `${LEGACY}/.well-known/openid-configuration`,
      `${LEGACY}/token`,
    ]);
    expect(s.requestsTo('/token').at(-1)!.form).toMatchObject({ grant_type: 'refresh_token', resource: LEGACY_MCP });
    expect(env.registry.servers.get(server.id)!.status).toBe('pending_approval');
  });

  it('without publicUrl asks for client input instead of DCR; the recorded origin issuer lets a pre-registered client be saved', async () => {
    const { s, env, server } = await legacy({}, { publicUrl: null });

    const result = await env.manager.prepare(server.id);

    expect(result).toEqual({ issuer: LEGACY, clientMode: 'preregistered', scope: null, needsClientInput: true });
    expect(s.count('/register')).toBe(0);
    expect(env.registry.servers.get(server.id)).toMatchObject({ status: 'needs_auth', oauth_issuer: LEGACY });
    const probe = env.registry.events.ofKind('probe', server.id);
    expect(env.registry.events.details(probe[0]!)).toMatchObject({ oauth: { metadataFallback: true, needsClientInput: true } });

    await env.manager.setPreregisteredClient(server.id, 'legacy-client');
    expect(env.secrets.oauth(secretRefOf(server.id))).toMatchObject({
      issuer: LEGACY,
      client_mode: 'preregistered',
      client_id: 'legacy-client',
      resource: LEGACY_MCP,
    });
  });

  it('treats a missing default /register (404) as "no DCR": client input is requested and the entered client logs in via /authorize', async () => {
    const { s, env, server } = await legacy({ dcr: false });

    const result = await env.manager.prepare(server.id);

    expect(result).toEqual({ issuer: LEGACY, clientMode: 'preregistered', scope: null, needsClientInput: true });
    expect(s.count('/register', 'POST')).toBe(1);
    expect(env.registry.servers.get(server.id)!.status).toBe('needs_auth');

    s.addClient({ client_id: 'legacy-client' });
    await env.manager.setPreregisteredClient(server.id, 'legacy-client');
    const u = new URL((await env.manager.start(server.id)).authorizationUrl);
    expect(`${u.origin}${u.pathname}`).toBe(`${LEGACY}/authorize`);
    expect(u.searchParams.get('client_id')).toBe('legacy-client');
  });

  it('still fails on other default /register errors (e.g. 5xx) instead of guessing', async () => {
    const { s, env, server } = await legacy({ failures: { '/register': 500 } });

    await expect(env.manager.prepare(server.id)).rejects.toMatchObject({ code: 'oauth_registration_failed' });

    expect(s.count('/register', 'POST')).toBe(1);
    expect(env.secrets.values.size).toBe(0);
  });

  it('does not fall back when a PRM exists but its authorization server has no metadata', async () => {
    // PRM이 같은 오리진의 AS를 가리키지만 메타데이터가 없다. /register가 응답할 수 있어도 기본값을 쓰지 않는다
    const sameOrigin = await as({ metadata: false, dcr: true });
    const env = createEnv();
    const s1 = addServer(env, sameOrigin, { id: 's1' });
    await expect(env.manager.prepare(s1.id)).rejects.toMatchObject({
      code: 'oauth_registration_failed',
      details: { protectedResourceMetadata: 'present' },
    });
    expect(sameOrigin.count('/register')).toBe(0);
    expect(env.secrets.values.size).toBe(0);
    expect(env.registry.servers.get(s1.id)).toMatchObject({ status: 'draft', oauth_issuer: null });
    expect(env.registry.events.ofKind('probe', s1.id)).toHaveLength(0);

    // PRM이 다른 인가 서버를 가리키고, 그 서버는 기본 엔드포인트만 가졌다
    const bareAs = await as({ noMetadata: true });
    const resource = await as({ metadata: false, prm: { authorizationServers: [bareAs.url] } });
    const s2 = addServer(env, resource, { id: 's2' });
    await expect(env.manager.prepare(s2.id)).rejects.toMatchObject({ code: 'oauth_registration_failed' });
    expect(bareAs.count('/.well-known/oauth-authorization-server')).toBe(1);
    expect(bareAs.count('/register')).toBe(0);
    expect(resource.count('/register')).toBe(0);
  });

  it('does not fall back when the absence of a PRM is not certain: an advertised resource_metadata that 404s, or a PRM endpoint failing with 5xx', async () => {
    const advertised = await legacy();
    await expect(
      advertised.env.manager.prepare(advertised.server.id, `Bearer resource_metadata="${LEGACY}/.well-known/oauth-protected-resource/elsewhere"`),
    ).rejects.toMatchObject({ code: 'oauth_registration_failed', details: { protectedResourceMetadata: 'unavailable' } });
    expect(advertised.s.count('/register')).toBe(0);

    const broken = await legacy({ failures: { '/.well-known/oauth-protected-resource/mcp': 500 } });
    await expect(broken.env.manager.prepare(broken.server.id)).rejects.toMatchObject({ code: 'oauth_registration_failed' });
    expect(broken.s.count('/register')).toBe(0);
    expect(broken.env.secrets.values.size).toBe(0);
  });

  it('does not fall back when AS metadata discovery fails with 5xx or a network error — only clean 4xx means "no metadata"', async () => {
    const unavailable = await legacy({ failures: { '/.well-known/oauth-authorization-server': 503 } });
    await expect(unavailable.env.manager.prepare(unavailable.server.id)).rejects.toMatchObject({
      code: 'oauth_registration_failed',
      message: expect.stringContaining('HTTP 503'),
    });
    // 5xx 뒤에도 다음 후보(OIDC)까지는 확인한다
    expect(unavailable.s.count('/.well-known/openid-configuration')).toBe(1);
    expect(unavailable.s.count('/register')).toBe(0);

    const network = await legacy({ failures: { '/.well-known/openid-configuration': 'network' } });
    await expect(network.env.manager.prepare(network.server.id)).rejects.toMatchObject({ code: 'oauth_registration_failed' });
    expect(network.s.count('/register')).toBe(0);
    expect(network.env.secrets.values.size).toBe(0);
  });

  it('prefers real metadata over the defaults: RFC 8414 at the origin first, then OIDC discovery', async () => {
    const env = createEnv();
    const rfc = await as({ prm: { enabled: false }, cimd: true });
    const s1 = addServer(env, rfc, { id: 's1' });
    expect(await env.manager.prepare(s1.id)).toMatchObject({ issuer: rfc.issuer, clientMode: 'cimd' });
    expect(env.registry.events.details(env.registry.events.ofKind('probe', s1.id)[0]!)).toMatchObject({
      oauth: { metadataFallback: false, metadataUrl: `${rfc.url}/.well-known/oauth-authorization-server`, prmUrl: null },
    });
    // 기본 /authorize가 아니라 광고된 authorization_endpoint
    const u = new URL((await env.manager.start(s1.id)).authorizationUrl);
    expect(`${u.origin}${u.pathname}`).toBe('https://as.example/authorize');

    const oidc = await as({ prm: { enabled: false }, cimd: true, oidcOnly: true });
    const s2 = addServer(env, oidc, { id: 's2' });
    expect(await env.manager.prepare(s2.id)).toMatchObject({ issuer: oidc.issuer, clientMode: 'cimd' });
    expect(env.registry.events.details(env.registry.events.ofKind('probe', s2.id)[0]!)).toMatchObject({
      oauth: { metadataFallback: false, metadataUrl: `${oidc.url}/.well-known/openid-configuration` },
    });
    expect(oidc.count('/.well-known/oauth-authorization-server')).toBe(1);
  });

  it('after a restart, does not switch a PRM-discovered server to the defaults when its AS metadata disappears', async () => {
    const auth = await as({ cimd: true });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth);
    env.registry.servers.update(server.id, { oauth_prm_url: auth.prmUrl });
    auth.options.metadata = false;

    expect(await env.manager.refresh(server.id, { force: true })).toMatchObject({ status: 'failed', kind: 'transient' });

    expect(auth.count('/token')).toBe(0);
    expect(env.registry.servers.get(server.id)!.status).toBe('active');
  });

  it('never serves a synthetic cache entry to a PRM-discovered server that shares the issuer', async () => {
    // 같은 오리진: /legacy는 PRM이 없고(폴백 대상), /mcp는 PRM이 있다. 오리진에는 AS 메타데이터가 없다
    const origin = await as({ metadata: false, failures: { '/.well-known/oauth-protected-resource': 404 } });
    const env = createEnv();
    const withPrm = addServer(env, origin, { id: 'with-prm' });
    seedOAuthSecret(env, withPrm.id, origin);
    env.registry.servers.update(withPrm.id, { oauth_prm_url: origin.prmUrl });
    const noPrm = addServer(env, origin, { id: 'no-prm', url: `${origin.url}/legacy` });

    // 폴백 서버가 issuer(= 오리진) 키로 합성 메타데이터를 캐시한다 (/register는 404라 client 입력 요청)
    expect(await env.manager.prepare(noPrm.id)).toMatchObject({ issuer: origin.issuer, needsClientInput: true });
    expect(env.registry.events.details(env.registry.events.ofKind('probe', noPrm.id)[0]!)).toMatchObject({ oauth: { metadataFallback: true } });

    expect(await env.manager.refresh(withPrm.id, { force: true })).toMatchObject({ status: 'failed', kind: 'transient' });
    expect(origin.count('/token')).toBe(0);
  });

  it('legacyDefaultMetadata discards the MCP path and uses the origin as issuer, without CIMD or iss flags', () => {
    expect(legacyDefaultMetadata('https://api.example.com:8443/v1/mcp?x=1')).toEqual({
      issuer: 'https://api.example.com:8443',
      authorization_endpoint: 'https://api.example.com:8443/authorize',
      token_endpoint: 'https://api.example.com:8443/token',
      registration_endpoint: 'https://api.example.com:8443/register',
      response_types_supported: ['code'],
    });
  });
});

describe('OIDC discovery로만 찾은 인가 서버 — SDK 스키마가 버리는 RFC 8414 필드 보존 (10.3 iss, 9.4 폐기)', () => {
  it('requires iss when an OIDC-only AS advertises authorization_response_iss_parameter_supported, from the cache and after a restart', async () => {
    const auth = await as({ oidcOnly: true, cimd: true, issParam: true });
    const env = createEnv();
    const server = addServer(env, auth);
    await env.manager.prepare(server.id);

    // 1) prepare가 채운 캐시의 병합 결과
    const first = auth.issueCode((await env.manager.start(server.id)).authorizationUrl);
    expect(await env.manager.handleCallback({ code: first.code, state: first.state! })).toEqual({ ok: false, serverId: server.id, error: 'oauth_issuer_mismatch' });
    expect(auth.count('/.well-known/openid-configuration')).toBe(1);
    const failed = env.registry.events.ofKind('auth.failed', server.id);
    expect(env.registry.events.details(failed[0]!)).toMatchObject({ reason: 'issuer_missing', expected: auth.issuer });

    // 2) 재시작 뒤 빈 캐시에서 다시 읽은 메타데이터도 같다
    const second = auth.issueCode((await env.manager.start(server.id)).authorizationUrl);
    restartManager(env);
    expect(await env.manager.handleCallback({ code: second.code, state: second.state! })).toEqual({ ok: false, serverId: server.id, error: 'oauth_issuer_mismatch' });
    expect(auth.count('/.well-known/openid-configuration')).toBe(2);
    expect(auth.count('/token')).toBe(0);

    // 3) iss가 오면 통과
    const third = auth.issueCode((await env.manager.start(server.id)).authorizationUrl);
    expect(await env.manager.handleCallback({ code: third.code, state: third.state!, iss: auth.issuer })).toEqual({ ok: true, serverId: server.id });
  });

  it('revokes at the revocation_endpoint of an OIDC-only AS using the cached merged metadata', async () => {
    const auth = await as({ oidcOnly: true, cimd: true, revocation: true });
    const env = createEnv();
    const server = addServer(env, auth);
    const secret = await login(env, auth, server.id);

    await env.manager.revoke(server.id);

    expect(auth.revoked).toEqual([
      { token: secret.refresh_token, token_type_hint: 'refresh_token', client_id: CIMD_CLIENT_ID },
      { token: secret.access_token, token_type_hint: 'access_token', client_id: CIMD_CLIENT_ID },
    ]);
    expect(env.fetchCalls.filter((u) => u === `${auth.url}/revoke`)).toHaveLength(2);
    // 메타데이터는 prepare 때 한 번만 읽었다
    expect(auth.count('/.well-known/openid-configuration')).toBe(1);
    expect(env.secrets.oauth(secretRefOf(server.id))).toMatchObject({ access_token: null, refresh_token: null });
  });

  it('with a cold cache, re-reads the OIDC document and honors revocation_endpoint_auth_methods_supported', async () => {
    // token 엔드포인트는 client_secret_post, 폐기 엔드포인트는 client_secret_basic만 받는다
    const auth = await as({ oidcOnly: true, revocation: true, tokenAuthMethods: ['client_secret_post'], revocationAuthMethods: ['client_secret_basic'] });
    auth.addClient({ client_id: 'conf-oidc', client_secret: 'conf-oidc-secret' });
    const env = createEnv();
    const server = addServer(env, auth);
    seedOAuthSecret(env, server.id, auth, {
      client_mode: 'preregistered',
      client_id: 'conf-oidc',
      client_secret: 'conf-oidc-secret',
      token_endpoint_auth_method: 'client_secret_post',
    });

    await env.manager.revoke(server.id);

    const reqs = auth.requestsTo('/revoke');
    expect(reqs).toHaveLength(2);
    for (const r of reqs) {
      expect(r.headers.authorization).toBe(`Basic ${Buffer.from('conf-oidc:conf-oidc-secret').toString('base64')}`);
      expect(r.form.client_secret).toBeUndefined();
    }
    expect(auth.revoked.map((r) => r.client_id)).toEqual(['conf-oidc', 'conf-oidc']);
    expect(auth.count('/.well-known/oauth-authorization-server')).toBe(1);
    expect(auth.count('/.well-known/openid-configuration')).toBe(1);
  });

  it('findAuthorizationServerMetadata merges only well-typed RFC 8414 fields from the raw OIDC document', async () => {
    const env = createEnv();
    const good = await as({ oidcOnly: true, issParam: true, revocation: true, revocationAuthMethods: ['client_secret_basic'] });
    const found = await findAuthorizationServerMetadata(good.url, env.fetch);
    expect(found?.url).toBe(`${good.url}/.well-known/openid-configuration`);
    expect(found?.metadata).toMatchObject({
      issuer: good.issuer,
      authorization_response_iss_parameter_supported: true,
      revocation_endpoint: `${good.url}/revoke`,
      revocation_endpoint_auth_methods_supported: ['client_secret_basic'],
    });

    const bad = await as({
      oidcOnly: true,
      extraMetadata: {
        authorization_response_iss_parameter_supported: 'true',
        revocation_endpoint: 'javascript:alert(1)',
        revocation_endpoint_auth_methods_supported: ['client_secret_basic', 7],
      },
    });
    const metadata = (await findAuthorizationServerMetadata(bad.url, env.fetch))!.metadata as Record<string, unknown>;
    expect(metadata.issuer).toBe(bad.issuer);
    expect(metadata).not.toHaveProperty('authorization_response_iss_parameter_supported');
    expect(metadata).not.toHaveProperty('revocation_endpoint');
    expect(metadata).not.toHaveProperty('revocation_endpoint_auth_methods_supported');
  });
});
