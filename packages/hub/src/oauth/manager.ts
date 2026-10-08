/**
 * OAuth 관리자 (설계 10장). Hub = MCP 클라이언트.
 *
 * - 탐색(PRM·AS 메타데이터)은 discovery.ts(SDK 후보 URL·스키마)가 맡고, 모든 HTTP는 주입된 guardedFetch로 나간다 (16.2).
 * - 여기서 직접 구현하는 것: 등록 우선순위(사전 등록 > CIMD > DCR > 입력 요청), issuer 바인딩,
 *   state 1회용 저장, iss 검증, refresh 단일 비행, scope step-up, RFC 7009 폐기, 시크릿 저장.
 * - AS 메타데이터는 issuer별로 메모리에만 캐시한다 (영속화하지 않음). OIDC 문서는 원문 필드를 되살린 결과를,
 *   메타데이터가 전혀 없는 서버(10.3 폴백)는 2025-03-26 기본 엔드포인트로 합성한 결과를 담는다.
 */
import { randomBytes } from 'node:crypto';
import {
  exchangeAuthorization,
  parseErrorResponse,
  refreshAuthorization,
  selectClientAuthMethod,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthError, ServerError, TemporarilyUnavailableError, TooManyRequestsError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationServerMetadata, OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { ApiError, DEFAULTS, base64url, createMasker, truncate } from '@omnicode/shared';
import type { EventRecord, OAuthClientMode, OAuthStartResult, ServerRecord, ServerStatus } from '@omnicode/shared';
import {
  canTransition,
  secretRefFor,
  UpstreamError,
  type FetchLike,
  type HubConfig,
  type Logger,
  type OAuthCallbackParams,
  type OAuthCallbackResult,
  type OAuthManager,
  type OAuthPrepareResult,
  type OAuthSecret,
  type Registry,
  type SecretStore,
  type SecretValue,
} from '../contracts.js';
import {
  canonicalResourceUrl,
  discover,
  findAuthorizationServerMetadata,
  issuersEqual,
  legacyDefaultMetadata,
  metadataFlag,
  metadataString,
  metadataStringList,
  normalizeIssuer,
  parseWwwAuthenticate,
  selectResource,
} from './discovery.js';
import { unionScope } from './scope.js';
import { SingleFlight } from './single-flight.js';

export interface OAuthManagerDeps {
  config: HubConfig;
  registry: Registry;
  secrets: SecretStore;
  /** guardedFetch. 모든 PRM·AS·토큰·등록·폐기 요청이 이것으로 나간다 */
  fetch: FetchLike;
  logger: Logger;
  /** 테스트용 시계 */
  now?: () => Date;
}

export type RefreshFailureKind =
  | 'permanent'        // invalid_grant·invalid_client 등 → needs_auth
  | 'transient'        // 네트워크·5xx·temporarily_unavailable → 상태 유지
  | 'no_refresh_token'
  | 'not_configured';

export class RefreshFailure extends Error {
  constructor(
    readonly kind: RefreshFailureKind,
    message: string,
    readonly oauthError: string | null = null,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RefreshFailure';
  }
}

export type RefreshOutcome =
  | { status: 'refreshed'; expiresAt: string | null }
  | { status: 'skipped'; reason: 'not_configured' | 'no_refresh_token' | 'not_expiring' }
  | { status: 'failed'; kind: RefreshFailureKind; error: string };

/** 계약(OAuthManager) + 조합 코드·스케줄러용 추가 메서드 */
export interface HubOAuthManager extends OAuthManager {
  /**
   * 만료가 aheadMs 안이면(또는 force면) refresh한다. 서버당 단일 비행.
   * 실패 분류는 10.4: permanent → needs_auth 전이, transient → 상태 유지.
   */
  refresh(serverId: string, opts?: { aheadMs?: number; force?: boolean }): Promise<RefreshOutcome>;
}

const CIMD_PATH = '/.well-known/omnicode/client.json';
const CALLBACK_PATH = '/oauth/callback';
const LAST_ERROR_MAX = 512;
const DCR_SOFTWARE_ID = 'omnicode';
/** 추측한 등록 엔드포인트(10.3 폴백의 /register)가 "없다"는 응답: 그 서버는 DCR을 지원하지 않는다 */
const ABSENT_ENDPOINT_STATUSES: ReadonlySet<number> = new Set([404, 405, 501]);

type ClientAuthMethod = ReturnType<typeof selectClientAuthMethod>;

interface CachedMetadata {
  metadata: AuthorizationServerMetadata;
  /** 10.3 폴백으로 합성한 2025-03-26 기본 엔드포인트 */
  fallback: boolean;
}

interface DcrRegistration {
  client_id: string;
  client_secret: string | null;
  token_endpoint_auth_method: string;
  registration_access_token: string | null;
  registration_client_uri: string | null;
}

function publicBase(publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  try {
    const u = new URL(publicUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return null;
  }
}

function emptyTokens(): Pick<OAuthSecret, 'access_token' | 'refresh_token' | 'expires_at' | 'scope' | 'obtained_at'> {
  return { access_token: null, refresh_token: null, expires_at: null, scope: null, obtained_at: null };
}

/** SecretValue 합집합에는 type 필드가 없는 HubTokensSecret도 있어 타입 가드로 좁힌다 */
function isOAuthSecret(v: SecretValue | undefined): v is OAuthSecret {
  return !!v && 'type' in v && v.type === 'oauth';
}

function isTransientOAuthError(e: unknown): boolean {
  return e instanceof ServerError || e instanceof TemporarilyUnavailableError || e instanceof TooManyRequestsError;
}

export function createOAuthManager(deps: OAuthManagerDeps): HubOAuthManager {
  const { config, registry, secrets, fetch: fetchFn, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const nowIso = (): string => now().toISOString();
  const masker = createMasker();
  const metadataCache = new Map<string, CachedMetadata>();
  const refreshFlights = new SingleFlight<OAuthSecret>();

  const base = publicBase(config.publicUrl);
  const redirectUri = base ? `${base}${CALLBACK_PATH}` : null;
  const cimdClientId = base && base.startsWith('https://') ? `${base}${CIMD_PATH}` : null;
  const publicHost = base ? new URL(base).host : null;

  // ---------------------------------------------------------------- 도우미

  const mask = (s: string): string => truncate(masker.mask(s), LAST_ERROR_MAX);
  const errMsg = (e: unknown): string => mask(e instanceof Error ? e.message : String(e));
  const describeError = (e: unknown): string =>
    e instanceof OAuthError ? mask(`${e.errorCode}${e.message ? `: ${e.message}` : ''}`) : errMsg(e);

  function requireServer(serverId: string): ServerRecord {
    const server = registry.servers.get(serverId);
    if (!server) throw new ApiError('not_found', `서버를 찾을 수 없습니다: ${serverId}`);
    return server;
  }

  function secretRef(server: ServerRecord): string {
    return server.secret_ref ?? secretRefFor(config.secretsPrefix, server.id);
  }

  function remember(secret: OAuthSecret): void {
    masker.add(secret.access_token);
    masker.add(secret.refresh_token);
    masker.add(secret.client_secret);
    masker.add(secret.registration_access_token);
  }

  async function loadSecret(server: ServerRecord): Promise<OAuthSecret | null> {
    const value = await secrets.get(secretRef(server));
    if (!isOAuthSecret(value)) return null;
    remember(value);
    return value;
  }

  async function saveSecret(ref: string, secret: OAuthSecret): Promise<void> {
    remember(secret);
    await secrets.put(ref, secret);
  }

  /**
   * 10.3 폴백(2025-03-26 기본 엔드포인트)으로 등록된 서버인가: PRM 없이 탐색했고(oauth_prm_url 없음)
   * issuer가 MCP 서버 오리진이다. 폴백 여부는 따로 저장하지 않으므로 재시작 뒤에는 이 조건으로 판단한다.
   */
  function usesLegacyDefaults(server: ServerRecord, issuer: string): boolean {
    if (!server.url || server.oauth_prm_url) return false;
    try {
      return issuersEqual(issuer, new URL(server.url).origin);
    } catch {
      return false;
    }
  }

  /**
   * issuer의 AS 메타데이터. 캐시가 비어 있으면(재시작 등) 다시 탐색한다. 탐색 결과가 "없음"일 때
   * 기본 엔드포인트로 되돌아가는 것은 폴백 대상 서버뿐이다 — PRM이 가리킨 인가 서버의 메타데이터가 사라졌다고
   * 기본값으로 바꾸지 않는다. 합성 캐시는 폴백 대상이 아닌 서버에 쓰지 않는다.
   */
  async function getMetadata(server: ServerRecord, issuer: string): Promise<AuthorizationServerMetadata> {
    const key = normalizeIssuer(issuer);
    const fallbackAllowed = usesLegacyDefaults(server, issuer);
    const cached = metadataCache.get(key);
    if (cached && (!cached.fallback || fallbackAllowed)) return cached.metadata;

    const found = await findAuthorizationServerMetadata(issuer, fetchFn, logger);
    if (found) {
      metadataCache.set(key, { metadata: found.metadata, fallback: false });
      return found.metadata;
    }
    if (!fallbackAllowed || !server.url) {
      throw new ApiError('oauth_registration_failed', '인가 서버 메타데이터를 찾을 수 없습니다', { authorizationServer: issuer });
    }
    const metadata = legacyDefaultMetadata(server.url);
    metadataCache.set(key, { metadata, fallback: true });
    logger.info({ serverId: server.id, issuer }, 'oauth: no authorization server metadata; using the 2025-03-26 default endpoints');
    return metadata;
  }

  function clientInformationFor(secret: OAuthSecret): OAuthClientInformationFull {
    return {
      client_id: secret.client_id,
      client_secret: secret.client_secret ?? undefined,
      token_endpoint_auth_method: secret.token_endpoint_auth_method,
      redirect_uris: redirectUri ? [redirectUri] : [],
    };
  }

  function applyTokens(secret: OAuthSecret, tokens: OAuthTokens, fallbackScope: string | null): OAuthSecret {
    const t = now();
    const expiresIn = typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) ? tokens.expires_in : null;
    return {
      ...secret,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? secret.refresh_token ?? null,
      expires_at: expiresIn !== null ? new Date(t.getTime() + expiresIn * 1000).toISOString() : null,
      scope: tokens.scope ?? fallbackScope,
      obtained_at: t.toISOString(),
    };
  }

  function addEvent(kind: EventRecord['kind'], serverId: string, actor: EventRecord['actor'], details: Record<string, unknown>): void {
    try {
      registry.events.add({ kind, server_id: serverId, actor, details });
    } catch (e) {
      logger.warn({ serverId, kind, err: errMsg(e) }, 'oauth: failed to record event');
    }
  }

  /** 9.2 전이표를 지키며 상태를 바꾼다. 같은 상태면 last_error만 갱신한다. */
  function transitionTo(serverId: string, target: ServerStatus, lastError: string | null): void {
    const cur = registry.servers.get(serverId);
    if (!cur) return;
    if (cur.status === target) {
      if (cur.last_error !== lastError) registry.servers.update(serverId, { last_error: lastError });
      return;
    }
    if (!canTransition(cur.status, target)) {
      logger.warn({ serverId, from: cur.status, to: target }, 'oauth: status transition not allowed; leaving status unchanged');
      return;
    }
    try {
      registry.servers.setStatus(serverId, target, { lastError });
    } catch (e) {
      logger.warn({ serverId, from: cur.status, to: target, err: errMsg(e) }, 'oauth: status transition failed');
    }
  }

  function markNeedsAuth(serverId: string, reason: string, details: Record<string, unknown>, actor: EventRecord['actor'] = 'hub'): void {
    const message = mask(reason);
    transitionTo(serverId, 'needs_auth', message);
    addEvent('auth.failed', serverId, actor, { ...details, message });
  }

  function applyClientAuth(method: ClientAuthMethod, secret: OAuthSecret, headers: Headers, params: URLSearchParams): void {
    switch (method) {
      case 'client_secret_basic':
        if (secret.client_secret) {
          headers.set('Authorization', `Basic ${Buffer.from(`${secret.client_id}:${secret.client_secret}`).toString('base64')}`);
          return;
        }
        params.set('client_id', secret.client_id);
        return;
      case 'client_secret_post':
        params.set('client_id', secret.client_id);
        if (secret.client_secret) params.set('client_secret', secret.client_secret);
        return;
      default:
        params.set('client_id', secret.client_id);
    }
  }

  // ---------------------------------------------------------------- DCR (10.3 등록 3번)

  /**
   * DCR 요청. endpointGuessed(10.3 폴백의 /register)면 404·405·501을 "DCR 미지원"으로 보고 null을 돌려준다 —
   * 2025-03-26 스펙도 DCR을 지원하지 않는 서버에는 client 정보를 직접 입력받으라고 한다. 그 밖의 실패는 throw.
   */
  async function registerDynamically(registrationEndpoint: string, scope: string | null, endpointGuessed: boolean): Promise<DcrRegistration | null> {
    if (!redirectUri) throw new ApiError('oauth_registration_failed', 'OMNICODE_PUBLIC_URL이 없어 동적 등록을 할 수 없습니다');
    const body: Record<string, unknown> = {
      client_name: `OmniCode (${publicHost})`,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
      software_id: DCR_SOFTWARE_ID,
      software_version: config.version,
    };
    if (base) body.client_uri = base;
    if (scope) body.scope = scope;

    let res: Response;
    try {
      res = await fetchFn(registrationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError('oauth_registration_failed', `동적 클라이언트 등록 요청 실패: ${errMsg(e)}`, { registrationEndpoint });
    }
    if (!res.ok) {
      if (endpointGuessed && ABSENT_ENDPOINT_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      const err = await parseErrorResponse(res);
      throw new ApiError('oauth_registration_failed', `동적 클라이언트 등록 거부: ${describeError(err)}`, {
        registrationEndpoint,
        status: res.status,
        error: err.errorCode,
      });
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new ApiError('oauth_registration_failed', `동적 클라이언트 등록 응답 파싱 실패: ${errMsg(e)}`, { registrationEndpoint });
    }
    const obj = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
    const str = (k: string): string | null => (typeof obj[k] === 'string' && (obj[k] as string).length > 0 ? (obj[k] as string) : null);
    const clientId = str('client_id');
    if (!clientId) throw new ApiError('oauth_registration_failed', '동적 클라이언트 등록 응답에 client_id가 없습니다', { registrationEndpoint });
    const clientSecret = str('client_secret');
    return {
      client_id: clientId,
      client_secret: clientSecret,
      token_endpoint_auth_method: str('token_endpoint_auth_method') ?? (clientSecret ? 'client_secret_basic' : 'none'),
      registration_access_token: str('registration_access_token'),
      registration_client_uri: str('registration_client_uri'),
    };
  }

  // ---------------------------------------------------------------- prepare (10.3 탐색·등록)

  async function prepare(serverId: string, wwwAuthenticate?: string): Promise<OAuthPrepareResult> {
    const server = requireServer(serverId);
    if (server.auth_type !== 'oauth' && server.auth_type !== 'none') {
      throw new ApiError('oauth_not_applicable', `auth_type=${server.auth_type} 서버에는 OAuth를 적용할 수 없습니다`);
    }
    if (!server.url) throw new ApiError('invalid_url', '원격 URL이 없는 서버입니다');
    if (server.status === 'deleting') throw new ApiError('invalid_transition', '삭제 중인 서버입니다');

    const www = parseWwwAuthenticate(wwwAuthenticate);
    const disc = await discover(server.url, www, fetchFn, logger);
    const issuer = disc.issuer;
    metadataCache.set(normalizeIssuer(issuer), { metadata: disc.metadata, fallback: disc.metadataFallback });

    const { canonical, resource } = selectResource(server.url, disc.prm);
    const prmScopes = disc.prm?.scopes_supported;
    const discoveredScope = www.scope ?? (prmScopes && prmScopes.length > 0 ? prmScopes.join(' ') : null);
    const requestedScope = unionScope(server.requested_scope, discoveredScope);

    const ref = secretRef(server);
    let existing = await loadSecret(server);
    const previousIssuer = existing?.issuer ?? server.oauth_issuer;
    const issuerChanged = !!previousIssuer && !issuersEqual(previousIssuer, issuer);
    if (issuerChanged) {
      logger.warn({ serverId, from: previousIssuer, to: issuer }, 'oauth: authorization server changed; discarding credentials bound to the old issuer');
      addEvent('server.updated', serverId, 'hub', { reason: 'oauth_issuer_changed', from: previousIssuer, to: issuer });
      // 사전 등록·DCR 자격증명은 다른 인가 서버에 재사용하지 않는다. CIMD는 아래에서 다시 계산된다.
      existing = null;
    }

    let clientMode: OAuthClientMode;
    let clientId: string;
    let clientSecret: string | null = null;
    let authMethod = 'none';
    let registrationAccessToken: string | null = null;
    let registrationClientUri: string | null = null;
    let needsClientInput = false;

    if (existing?.client_mode === 'preregistered' && existing.client_id) {
      clientMode = 'preregistered';
      clientId = existing.client_id;
      clientSecret = existing.client_secret;
      authMethod = existing.token_endpoint_auth_method;
    } else if (metadataFlag(disc.metadata, 'client_id_metadata_document_supported') && cimdClientId) {
      clientMode = 'cimd';
      clientId = cimdClientId;
    } else if (disc.metadata.registration_endpoint && redirectUri) {
      if (existing?.client_mode === 'dcr' && existing.client_id) {
        clientMode = 'dcr';
        clientId = existing.client_id;
        clientSecret = existing.client_secret;
        authMethod = existing.token_endpoint_auth_method;
        registrationAccessToken = existing.registration_access_token;
        registrationClientUri = existing.registration_client_uri;
      } else {
        const reg = await registerDynamically(disc.metadata.registration_endpoint, requestedScope, disc.metadataFallback);
        if (reg) {
          clientMode = 'dcr';
          clientId = reg.client_id;
          clientSecret = reg.client_secret;
          authMethod = reg.token_endpoint_auth_method;
          registrationAccessToken = reg.registration_access_token;
          registrationClientUri = reg.registration_client_uri;
          logger.info({ serverId, issuer, authMethod }, 'oauth: dynamic client registration completed');
        } else {
          // 기본 /register가 없다: DCR을 지원하지 않는 2025-03-26 서버 → 사전 등록 입력 (10.3 등록 4번)
          logger.info({ serverId, issuer, registrationEndpoint: disc.metadata.registration_endpoint }, 'oauth: default registration endpoint not found; client input required');
          needsClientInput = true;
          clientMode = 'preregistered';
          clientId = '';
        }
      }
    } else {
      needsClientInput = true;
      clientMode = 'preregistered';
      clientId = '';
    }

    const keepTokens = !!existing && existing.client_id === clientId;
    const tokensCleared = !!existing && !keepTokens && !!(existing.access_token || existing.refresh_token);
    const secret: OAuthSecret = {
      type: 'oauth',
      issuer,
      client_mode: clientMode,
      client_id: clientId,
      client_secret: clientSecret,
      token_endpoint_auth_method: authMethod,
      registration_access_token: registrationAccessToken,
      registration_client_uri: registrationClientUri,
      resource,
      ...(keepTokens && existing
        ? {
            access_token: existing.access_token,
            refresh_token: existing.refresh_token,
            expires_at: existing.expires_at,
            scope: existing.scope,
            obtained_at: existing.obtained_at,
          }
        : emptyTokens()),
    };
    await saveSecret(ref, secret);

    registry.servers.update(serverId, {
      auth_type: 'oauth',
      secret_ref: ref,
      oauth_issuer: issuer,
      oauth_client_mode: clientMode,
      oauth_prm_url: disc.prmUrl,
      requested_scope: requestedScope,
      canonical_url: canonical,
    });

    const current = registry.servers.get(serverId)?.status ?? server.status;
    const mustLogin = current === 'draft' || current === 'error' || !secret.access_token || issuerChanged;
    if (mustLogin) {
      const reason = issuerChanged
        ? '인가 서버가 바뀌어 다시 로그인해야 합니다'
        : tokensCleared
          ? 'OAuth 클라이언트가 바뀌어 다시 로그인해야 합니다'
          : null;
      transitionTo(serverId, 'needs_auth', reason);
    }

    addEvent('probe', serverId, 'hub', {
      oauth: {
        issuer,
        clientMode,
        scope: requestedScope,
        needsClientInput,
        prmUrl: disc.prmUrl,
        metadataUrl: disc.metadataUrl,
        // 10.3 탐색 폴백: PRM·AS 메타데이터가 전혀 없어 2025-03-26 기본 엔드포인트를 썼다
        metadataFallback: disc.metadataFallback,
        resource,
        issuerChanged,
      },
    });
    logger.info(
      { serverId, issuer, clientMode, needsClientInput, scope: requestedScope, metadataFallback: disc.metadataFallback },
      'oauth: discovery completed',
    );

    return { issuer, clientMode, scope: requestedScope, needsClientInput };
  }

  // ---------------------------------------------------------------- start (10.3 인가 요청·state)

  async function start(serverId: string, opts?: { sessionId?: string | null }): Promise<OAuthStartResult> {
    const server = requireServer(serverId);
    if (server.status === 'deleting') throw new ApiError('invalid_transition', '삭제 중인 서버입니다');
    if (server.auth_type !== 'oauth' || !server.oauth_issuer) {
      throw new ApiError('oauth_not_applicable', 'OAuth 탐색(prepare)이 먼저 필요합니다');
    }
    if (!redirectUri) {
      throw new ApiError('oauth_not_applicable', 'OMNICODE_PUBLIC_URL이 설정되지 않아 OAuth 로그인을 시작할 수 없습니다');
    }
    const secret = await loadSecret(server);
    if (!secret || !secret.client_id) {
      throw new ApiError('oauth_not_applicable', 'client_id가 필요합니다', { needsClientInput: true });
    }
    const metadata = await getMetadata(server, secret.issuer);
    const state = base64url(randomBytes(32));
    const scope = server.requested_scope ?? undefined;

    let authorizationUrl: URL;
    let codeVerifier: string;
    try {
      ({ authorizationUrl, codeVerifier } = await startAuthorization(secret.issuer, {
        metadata,
        clientInformation: clientInformationFor(secret),
        redirectUrl: redirectUri,
        scope,
        state,
        resource: secret.resource,
      }));
    } catch (e) {
      throw new ApiError('oauth_registration_failed', `인가 URL 생성 실패: ${errMsg(e)}`);
    }
    if (authorizationUrl.protocol !== 'https:') {
      throw new ApiError('invalid_url', `인가 URL이 https가 아닙니다 (${authorizationUrl.protocol})`);
    }

    const created = now();
    const expiresAt = new Date(created.getTime() + DEFAULTS.oauthStateTtlMs).toISOString();
    registry.oauthStates.create({
      state,
      server_id: serverId,
      code_verifier: codeVerifier,
      issuer: secret.issuer,
      client_id: secret.client_id,
      scope: scope ?? null,
      omnicode_session_id: opts?.sessionId ?? null,
      created_at: created.toISOString(),
      expires_at: expiresAt,
      used_at: null,
    });
    addEvent('auth.started', serverId, 'user', {
      issuer: secret.issuer,
      clientMode: secret.client_mode,
      scope: scope ?? null,
      sessionId: opts?.sessionId ?? null,
      expiresAt,
    });
    logger.info({ serverId, issuer: secret.issuer, clientMode: secret.client_mode }, 'oauth: authorization started');
    return { authorizationUrl: authorizationUrl.href, expiresAt };
  }

  // ---------------------------------------------------------------- callback (10.3 콜백 처리)

  async function handleCallback(params: OAuthCallbackParams): Promise<OAuthCallbackResult> {
    const fail = (serverId: string | null, error: string): OAuthCallbackResult => ({ ok: false, serverId, error });

    if (!params.state) return fail(null, 'oauth_state_invalid');
    const rec = registry.oauthStates.consume(params.state, nowIso());
    if (!rec) {
      logger.warn('oauth: callback with unknown, expired or already used state');
      return fail(null, 'oauth_state_invalid');
    }
    const serverId = rec.server_id;
    const server = registry.servers.get(serverId);
    if (!server) return fail(serverId, 'not_found');

    if (params.error) {
      const desc = params.error_description ? `${params.error}: ${params.error_description}` : params.error;
      markNeedsAuth(serverId, `인가 거부 (${desc})`, {
        reason: 'callback_error',
        error: params.error,
        error_description: params.error_description ?? null,
      }, 'user');
      return fail(serverId, 'oauth_denied');
    }

    const secret = await loadSecret(server);
    if (!secret || !secret.client_id || !issuersEqual(secret.issuer, rec.issuer) || secret.client_id !== rec.client_id) {
      markNeedsAuth(serverId, '로그인 도중 OAuth 설정이 바뀌었습니다. 다시 로그인하세요', { reason: 'state_stale' });
      return fail(serverId, 'oauth_state_invalid');
    }

    let metadata: AuthorizationServerMetadata;
    try {
      metadata = await getMetadata(server, secret.issuer);
    } catch (e) {
      markNeedsAuth(serverId, `인가 서버 메타데이터 조회 실패: ${errMsg(e)}`, { reason: 'discovery_failed' });
      return fail(serverId, 'oauth_registration_failed');
    }

    // iss 검증 (RFC 9207): 있으면 기록한 issuer와 정확히 비교, AS가 지원을 선언했는데 없으면 거부
    if (params.iss !== undefined) {
      if (params.iss !== rec.issuer) {
        markNeedsAuth(serverId, `인가 응답의 iss가 기록된 issuer와 다릅니다`, {
          reason: 'issuer_mismatch',
          expected: rec.issuer,
          received: params.iss,
        });
        return fail(serverId, 'oauth_issuer_mismatch');
      }
    } else if (metadataFlag(metadata, 'authorization_response_iss_parameter_supported')) {
      markNeedsAuth(serverId, '인가 응답에 iss 파라미터가 없습니다', { reason: 'issuer_missing', expected: rec.issuer });
      return fail(serverId, 'oauth_issuer_mismatch');
    }

    if (!params.code) {
      markNeedsAuth(serverId, '인가 응답에 code가 없습니다', { reason: 'code_missing' });
      return fail(serverId, 'validation_error');
    }
    if (!redirectUri) {
      markNeedsAuth(serverId, 'OMNICODE_PUBLIC_URL이 설정되지 않았습니다', { reason: 'no_public_url' });
      return fail(serverId, 'oauth_not_applicable');
    }

    let tokens: OAuthTokens;
    try {
      tokens = await exchangeAuthorization(secret.issuer, {
        metadata,
        clientInformation: clientInformationFor(secret),
        authorizationCode: params.code,
        codeVerifier: rec.code_verifier,
        redirectUri,
        resource: secret.resource,
        fetchFn,
      });
    } catch (e) {
      markNeedsAuth(serverId, `토큰 교환 실패: ${describeError(e)}`, {
        reason: 'exchange_failed',
        error: e instanceof OAuthError ? e.errorCode : null,
      });
      return fail(serverId, e instanceof OAuthError ? 'oauth_denied' : 'upstream_error');
    }

    const updated = applyTokens({ ...secret, refresh_token: null }, tokens, rec.scope);
    await saveSecret(secretRef(server), updated);
    registry.servers.update(serverId, { granted_scope: updated.scope });

    const anyApproved = registry.tools.listByServer(serverId).some((t) => !!t.approved_hash);
    transitionTo(serverId, anyApproved ? 'active' : 'pending_approval', null);

    addEvent('auth.completed', serverId, 'user', {
      issuer: secret.issuer,
      clientMode: secret.client_mode,
      scope: updated.scope,
      expiresAt: updated.expires_at,
      hasRefreshToken: !!updated.refresh_token,
      sessionId: rec.omnicode_session_id,
    });
    logger.info({ serverId, issuer: secret.issuer, expiresAt: updated.expires_at }, 'oauth: tokens obtained');
    return { ok: true, serverId };
  }

  // ---------------------------------------------------------------- 사전 등록 client (10.3 등록 4번)

  async function setPreregisteredClient(serverId: string, clientId: string, clientSecret?: string): Promise<void> {
    const server = requireServer(serverId);
    if (!clientId) throw new ApiError('validation_error', 'clientId가 비어 있습니다');
    const existing = await loadSecret(server);
    const issuer = existing?.issuer ?? server.oauth_issuer;
    if (!issuer || server.auth_type !== 'oauth') {
      throw new ApiError('oauth_not_applicable', 'OAuth 탐색(prepare)이 먼저 필요합니다');
    }
    const resource = existing?.resource ?? server.canonical_url ?? (server.url ? canonicalResourceUrl(server.url) : null);
    if (!resource) throw new ApiError('invalid_url', '원격 URL이 없는 서버입니다');

    const sameClient = !!existing && existing.client_id === clientId && existing.client_mode === 'preregistered';
    const secret: OAuthSecret = {
      type: 'oauth',
      issuer,
      client_mode: 'preregistered',
      client_id: clientId,
      client_secret: clientSecret ?? null,
      token_endpoint_auth_method: clientSecret ? 'client_secret_post' : 'none',
      registration_access_token: null,
      registration_client_uri: null,
      resource,
      ...(sameClient && existing
        ? {
            access_token: existing.access_token,
            refresh_token: existing.refresh_token,
            expires_at: existing.expires_at,
            scope: existing.scope,
            obtained_at: existing.obtained_at,
          }
        : emptyTokens()),
    };
    const ref = secretRef(server);
    await saveSecret(ref, secret);
    registry.servers.update(serverId, { secret_ref: ref, oauth_client_mode: 'preregistered' });
    addEvent('credentials.saved', serverId, 'user', { clientMode: 'preregistered', hasClientSecret: !!clientSecret });
    logger.info({ serverId, issuer, hasClientSecret: !!clientSecret }, 'oauth: pre-registered client saved');
  }

  // ---------------------------------------------------------------- refresh (10.4)

  function classifyRefreshError(e: unknown): RefreshFailure {
    if (e instanceof RefreshFailure) return e;
    if (e instanceof OAuthError && !isTransientOAuthError(e)) {
      return new RefreshFailure('permanent', `토큰 갱신 거부: ${describeError(e)}`, e.errorCode, e);
    }
    return new RefreshFailure('transient', `토큰 갱신 실패: ${describeError(e)}`, e instanceof OAuthError ? e.errorCode : null, e);
  }

  /** 단일 비행 안에서 실행된다. permanent 실패는 여기서 needs_auth로 바꾼다 (호출자 수와 무관하게 한 번). */
  async function refreshNow(serverId: string): Promise<OAuthSecret> {
    const server = registry.servers.get(serverId);
    if (!server || server.auth_type !== 'oauth') throw new RefreshFailure('not_configured', 'OAuth 서버가 아닙니다');
    const secret = await loadSecret(server);
    if (!secret) throw new RefreshFailure('not_configured', 'OAuth 시크릿이 없습니다');
    if (!secret.refresh_token) throw new RefreshFailure('no_refresh_token', 'refresh token이 없습니다');

    let metadata: AuthorizationServerMetadata;
    try {
      metadata = await getMetadata(server, secret.issuer);
    } catch (e) {
      throw new RefreshFailure('transient', `인가 서버 메타데이터 조회 실패: ${errMsg(e)}`, null, e);
    }

    let tokens: OAuthTokens;
    try {
      tokens = await refreshAuthorization(secret.issuer, {
        metadata,
        clientInformation: clientInformationFor(secret),
        refreshToken: secret.refresh_token,
        resource: secret.resource,
        fetchFn,
      });
    } catch (e) {
      const failure = classifyRefreshError(e);
      if (failure.kind === 'permanent') {
        markNeedsAuth(serverId, failure.message, { reason: 'refresh_failed', error: failure.oauthError });
      } else {
        logger.warn({ serverId, err: failure.message }, 'oauth: transient refresh failure; keeping status');
      }
      throw failure;
    }

    const updated = applyTokens(secret, tokens, secret.scope);
    await saveSecret(secretRef(server), updated);
    if (updated.scope !== server.granted_scope) registry.servers.update(serverId, { granted_scope: updated.scope });
    logger.info({ serverId, expiresAt: updated.expires_at, rotated: updated.refresh_token !== secret.refresh_token }, 'oauth: token refreshed');
    return updated;
  }

  function refreshSingleFlight(serverId: string): Promise<OAuthSecret> {
    return refreshFlights.run(serverId, () => refreshNow(serverId));
  }

  function expiresInMs(secret: OAuthSecret): number | null {
    if (!secret.expires_at) return null;
    const exp = Date.parse(secret.expires_at);
    return Number.isFinite(exp) ? exp - now().getTime() : null;
  }

  async function refresh(serverId: string, opts?: { aheadMs?: number; force?: boolean }): Promise<RefreshOutcome> {
    const server = registry.servers.get(serverId);
    if (!server || server.auth_type !== 'oauth') return { status: 'skipped', reason: 'not_configured' };
    const secret = await loadSecret(server);
    if (!secret) return { status: 'skipped', reason: 'not_configured' };
    if (!secret.refresh_token) return { status: 'skipped', reason: 'no_refresh_token' };
    if (!opts?.force) {
      const left = expiresInMs(secret);
      // 만료를 모르면(expires_in 없음) 401에 반응한다 (10.4)
      if (left === null || left >= (opts?.aheadMs ?? DEFAULTS.refreshAheadMs)) return { status: 'skipped', reason: 'not_expiring' };
    }
    try {
      const updated = await refreshSingleFlight(serverId);
      return { status: 'refreshed', expiresAt: updated.expires_at };
    } catch (e) {
      const failure = classifyRefreshError(e);
      return { status: 'failed', kind: failure.kind, error: failure.message };
    }
  }

  async function headersFor(serverId: string): Promise<Record<string, string>> {
    const server = registry.servers.get(serverId);
    if (!server || server.auth_type !== 'oauth') throw new UpstreamError('unauthorized', `OAuth 서버가 아닙니다: ${serverId}`);
    let secret = await loadSecret(server);
    if (!secret?.access_token) throw new UpstreamError('unauthorized', 'OAuth access token이 없습니다');

    const left = expiresInMs(secret);
    if (left !== null && left < DEFAULTS.refreshAtCallAheadMs) {
      if (!secret.refresh_token) {
        if (left <= 0) {
          markNeedsAuth(serverId, 'access token이 만료되었고 refresh token이 없습니다', { reason: 'expired_no_refresh_token' });
          throw new UpstreamError('unauthorized', 'OAuth access token 만료 (refresh token 없음)');
        }
        // 60초 안에 만료되지만 아직 유효: 그대로 쓴다
      } else {
        try {
          secret = await refreshSingleFlight(serverId);
        } catch (e) {
          const failure = classifyRefreshError(e);
          if (failure.kind === 'transient' && left > 0) {
            logger.warn({ serverId, err: failure.message }, 'oauth: refresh failed transiently; using the still-valid token');
          } else if (failure.kind === 'transient') {
            throw new UpstreamError('unavailable', failure.message);
          } else {
            throw new UpstreamError('unauthorized', failure.message);
          }
        }
      }
    }
    return { Authorization: `Bearer ${secret.access_token}` };
  }

  async function onUnauthorized(serverId: string, wwwAuthenticate?: string): Promise<'retry' | 'needs_auth'> {
    const www = parseWwwAuthenticate(wwwAuthenticate);
    if (www.error === 'insufficient_scope') {
      await onInsufficientScope(serverId, www.scope ?? '');
      return 'needs_auth';
    }
    try {
      await refreshSingleFlight(serverId);
      return 'retry';
    } catch (e) {
      const failure = classifyRefreshError(e);
      // permanent 실패는 refreshNow 안에서 이미 needs_auth로 바꿨다
      if (failure.kind !== 'permanent') {
        markNeedsAuth(serverId, `401 후 토큰 갱신 실패: ${failure.message}`, { reason: 'unauthorized', kind: failure.kind, error: failure.oauthError });
      }
      return 'needs_auth';
    }
  }

  async function onInsufficientScope(serverId: string, scope: string): Promise<void> {
    const server = requireServer(serverId);
    const merged = unionScope(server.requested_scope, scope);
    if (merged !== server.requested_scope) registry.servers.update(serverId, { requested_scope: merged });
    markNeedsAuth(serverId, `추가 권한 필요: ${scope || '(scope 미지정)'}`, {
      reason: 'insufficient_scope',
      scope: scope || null,
      requestedScope: merged,
    });
    logger.info({ serverId, scope, requestedScope: merged }, 'oauth: scope step-up required');
  }

  // ---------------------------------------------------------------- revoke (RFC 7009, best effort)

  async function revokeToken(endpoint: string, token: string, hint: 'refresh_token' | 'access_token', secret: OAuthSecret, metadata: AuthorizationServerMetadata): Promise<void> {
    const params = new URLSearchParams({ token, token_type_hint: hint });
    const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' });
    const supported =
      metadataStringList(metadata, 'revocation_endpoint_auth_methods_supported') ??
      metadata.token_endpoint_auth_methods_supported ??
      [];
    applyClientAuth(selectClientAuthMethod(clientInformationFor(secret), supported), secret, headers, params);
    const res = await fetchFn(endpoint, { method: 'POST', headers, body: params });
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  async function revoke(serverId: string): Promise<void> {
    const server = registry.servers.get(serverId);
    if (!server) return;
    const secret = await loadSecret(server);
    if (!secret) return;

    if (secret.access_token || secret.refresh_token) {
      let endpoint: string | null = null;
      let metadata: AuthorizationServerMetadata | null = null;
      try {
        metadata = await getMetadata(server, secret.issuer);
        endpoint = metadataString(metadata, 'revocation_endpoint');
      } catch (e) {
        logger.warn({ serverId, err: errMsg(e) }, 'oauth: revocation skipped (metadata unavailable)');
      }
      if (endpoint && metadata) {
        const targets: Array<[string | null, 'refresh_token' | 'access_token']> = [
          [secret.refresh_token, 'refresh_token'],
          [secret.access_token, 'access_token'],
        ];
        for (const [token, hint] of targets) {
          if (!token) continue;
          try {
            await revokeToken(endpoint, token, hint, secret, metadata);
          } catch (e) {
            logger.warn({ serverId, hint, err: errMsg(e) }, 'oauth: token revocation failed (ignored)');
          }
        }
      } else {
        logger.info({ serverId }, 'oauth: authorization server has no revocation_endpoint; clearing tokens only');
      }
    }

    await saveSecret(secretRef(server), { ...secret, ...emptyTokens() });
    logger.info({ serverId }, 'oauth: tokens cleared');
  }

  async function expiresAt(serverId: string): Promise<string | null> {
    const server = registry.servers.get(serverId);
    if (!server) return null;
    const secret = await loadSecret(server);
    return secret?.expires_at ?? null;
  }

  return {
    prepare,
    start,
    handleCallback,
    setPreregisteredClient,
    headersFor,
    onUnauthorized,
    onInsufficientScope,
    revoke,
    expiresAt,
    refresh,
  };
}
