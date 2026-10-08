/**
 * OAuth 탐색 (설계 10.3 "탐색"). PRM → 인가 서버 메타데이터 → (둘 다 없으면) 2025-03-26 기본 엔드포인트.
 * SDK의 후보 URL(buildDiscoveryUrls)·스키마를 쓰고, 모든 HTTP는 주입된 fetch(guardedFetch, 16.2)로 나간다.
 *
 * 메타데이터 문서는 SDK discover* 헬퍼 대신 직접 읽는다. 헬퍼는
 * - 네트워크 오류(TypeError)를 CORS 실패로 보고 "문서 없음"과 구분하지 않는다. 기본 엔드포인트 폴백은
 *   "확실히 없음"(모든 후보 4xx)일 때만 해야 한다.
 * - OIDC discovery 문서를 z.object 스키마로 읽어 RFC 8414·9207 필드(authorization_response_iss_parameter_supported,
 *   revocation_endpoint …)를 버린다. 그러면 10.3 iss 필수 검사와 9.4 토큰 폐기가 조용히 꺼진다.
 */
import { buildDiscoveryUrls, extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import {
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OpenIdProviderDiscoveryMetadataSchema,
  type AuthorizationServerMetadata,
  type OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { ApiError } from '@omnicode/shared';
import { SsrfBlockedError, type FetchLike, type Logger } from '../contracts.js';

export interface WwwAuthenticateParams {
  resourceMetadataUrl: string | null;
  scope: string | null;
  error: string | null;
}

const EMPTY_WWW: WwwAuthenticateParams = { resourceMetadataUrl: null, scope: null, error: null };

/** `WWW-Authenticate: Bearer …`에서 resource_metadata·scope·error를 뽑는다. 파싱 불가면 모두 null. */
export function parseWwwAuthenticate(header: string | null | undefined): WwwAuthenticateParams {
  if (!header) return EMPTY_WWW;
  let res: Response;
  try {
    res = new Response(null, { status: 401, headers: { 'WWW-Authenticate': header } });
  } catch {
    return EMPTY_WWW;
  }
  const p = extractWWWAuthenticateParams(res);
  return {
    resourceMetadataUrl: p.resourceMetadataUrl?.href ?? null,
    scope: p.scope ?? null,
    error: p.error ?? null,
  };
}

/**
 * RFC 8707 resource 파라미터용 canonical URL: scheme + host(+port) + path.
 * 쿼리·프래그먼트·userinfo 제거, 경로가 "/"가 아니면 끝 슬래시 제거.
 */
export function canonicalResourceUrl(input: string): string {
  const u = new URL(input);
  let path = u.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '') || '/';
  return `${u.protocol}//${u.host}${path}`;
}

/** issuer 비교용 정규화: URL이면 파싱해 href, 끝 슬래시 하나 제거. */
export function normalizeIssuer(s: string): string {
  let out = s;
  try {
    out = new URL(s).href;
  } catch {
    // URL이 아니면 문자열 그대로 비교
  }
  return out.endsWith('/') ? out.slice(0, -1) : out;
}

export function issuersEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeIssuer(a) === normalizeIssuer(b);
}

/** 스키마에 없는 선택 플래그(예: authorization_response_iss_parameter_supported)를 읽는다. */
export function metadataFlag(metadata: AuthorizationServerMetadata, key: string): boolean {
  return (metadata as Record<string, unknown>)[key] === true;
}

export function metadataString(metadata: AuthorizationServerMetadata, key: string): string | null {
  const v = (metadata as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function metadataStringList(metadata: AuthorizationServerMetadata, key: string): string[] | null {
  const v = (metadata as Record<string, unknown>)[key];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------- 메타데이터 문서 읽기

/** SDK 탐색과 같은 헤더 */
const METADATA_REQUEST_HEADERS: Record<string, string> = {
  'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION,
  Accept: 'application/json',
};

type MetadataDocument = { kind: 'found'; json: unknown } | { kind: 'absent'; status: number };

/**
 * well-known 메타데이터 문서 하나를 주입된 fetch로 읽는다.
 * 4xx(와 따라가지 않은 3xx)는 "이 위치에 문서 없음", 5xx·네트워크 오류·JSON이 아닌 본문은 throw.
 */
async function fetchMetadataDocument(url: string | URL, fetchFn: FetchLike): Promise<MetadataDocument> {
  const res = await fetchFn(url, { headers: METADATA_REQUEST_HEADERS });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    if (res.status < 500) return { kind: 'absent', status: res.status };
    throw new Error(`HTTP ${res.status} (${String(url)})`);
  }
  return { kind: 'found', json: await res.json() };
}

// ---------------------------------------------------------------- PRM (RFC 9728)

/** PRM 후보 URL: 헤더의 resource_metadata가 있으면 그것만, 없으면 경로 포함 → 오리진 루트 순. */
function prmCandidates(serverUrl: URL, fromHeader: string | null): string[] {
  if (fromHeader) return [fromHeader];
  const out: string[] = [];
  let path = serverUrl.pathname;
  if (path.endsWith('/')) path = path.slice(0, -1);
  if (path.length > 0) {
    const u = new URL(`/.well-known/oauth-protected-resource${path}`, serverUrl);
    u.search = serverUrl.search;
    out.push(u.href);
  }
  out.push(new URL('/.well-known/oauth-protected-resource', serverUrl).href);
  return out;
}

export interface ProtectedResourceDiscovery {
  prm: OAuthProtectedResourceMetadata;
  url: string;
}

export interface ProtectedResourceProbe {
  found: ProtectedResourceDiscovery | null;
  /**
   * PRM이 "없다"고 단정할 수 없다: WWW-Authenticate가 알려 준 PRM을 못 읽었거나, 어느 후보가 4xx가 아닌 이유
   * (5xx·네트워크·잘못된 문서)로 실패했다. 이때는 2025-03-26 기본 엔드포인트로 폴백하지 않는다 (10.3).
   */
  inconclusive: boolean;
}

/** RFC 9728 PRM 조회. 첫 번째로 읽힌 문서를 쓴다. SSRF 차단은 그대로 던진다. */
export async function discoverProtectedResource(
  serverUrl: string,
  fromHeader: string | null,
  fetchFn: FetchLike,
  logger: Logger,
): Promise<ProtectedResourceProbe> {
  let inconclusive = fromHeader !== null;
  for (const candidate of prmCandidates(new URL(serverUrl), fromHeader)) {
    try {
      const doc = await fetchMetadataDocument(candidate, fetchFn);
      if (doc.kind === 'absent') {
        logger.debug({ url: candidate, status: doc.status }, 'oauth: no protected resource metadata at candidate');
        continue;
      }
      return { found: { prm: OAuthProtectedResourceMetadataSchema.parse(doc.json), url: candidate }, inconclusive: false };
    } catch (e) {
      if (e instanceof SsrfBlockedError) throw e;
      inconclusive = true;
      logger.debug({ url: candidate, err: errMessage(e) }, 'oauth: protected resource metadata not available');
    }
  }
  return { found: null, inconclusive };
}

// ---------------------------------------------------------------- AS 메타데이터 (RFC 8414 · OIDC discovery)

/** OIDC 문서에서 되살리는 필드 (SDK OpenIdProviderDiscoveryMetadataSchema가 버리는 것 중 Hub가 읽는 것) */
interface PreservedRfc8414Fields {
  /** RFC 9207 — 10.3 콜백 3번 "iss 필수" 판단 */
  authorization_response_iss_parameter_supported?: boolean;
  /** RFC 7009 — 9.4 삭제 절차 3번 토큰 폐기 */
  revocation_endpoint?: string;
  revocation_endpoint_auth_methods_supported?: string[];
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** 원문 JSON에서 PreservedRfc8414Fields를 타입을 확인하며 꺼낸다. 타입이 틀린 값은 버린다 (없는 것과 같다). */
function preservedRfc8414Fields(json: unknown): PreservedRfc8414Fields {
  const raw = json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  const out: PreservedRfc8414Fields = {};
  const iss = raw.authorization_response_iss_parameter_supported;
  if (typeof iss === 'boolean') out.authorization_response_iss_parameter_supported = iss;
  const revocation = raw.revocation_endpoint;
  if (typeof revocation === 'string' && isHttpUrl(revocation)) out.revocation_endpoint = revocation;
  const methods = raw.revocation_endpoint_auth_methods_supported;
  if (Array.isArray(methods) && methods.every((m): m is string => typeof m === 'string')) {
    out.revocation_endpoint_auth_methods_supported = methods;
  }
  return out;
}

function parseAuthorizationServerMetadata(type: 'oauth' | 'oidc', json: unknown): AuthorizationServerMetadata {
  // RFC 8414 스키마는 looseObject라 원문 필드가 그대로 남는다
  if (type === 'oauth') return OAuthMetadataSchema.parse(json);
  // OIDC 스키마는 모르는 키를 버리므로 Hub가 쓰는 RFC 8414 필드를 같은 원문에서 되살려 합친다
  return { ...OpenIdProviderDiscoveryMetadataSchema.parse(json), ...preservedRfc8414Fields(json) };
}

export interface AuthorizationServerDiscovery {
  metadata: AuthorizationServerMetadata;
  /** 메타데이터 문서를 읽은 URL */
  url: string;
}

/**
 * RFC 8414 → OIDC discovery 순서(SDK buildDiscoveryUrls)로 AS 메타데이터를 찾고 issuer를 검증한다 (RFC 8414 §3.3).
 * - 모든 후보가 4xx면 null: 메타데이터가 "없다" (10.3 폴백 판단은 호출자 몫).
 * - 5xx·네트워크 오류·잘못된 문서는 다음 후보로 넘어가되, 끝내 못 찾으면 oauth_registration_failed.
 * - OIDC 문서는 SDK 스키마가 버리는 RFC 8414 필드를 원문에서 되살린 결과를 돌려준다 (캐시도 이것을 담는다).
 */
export async function findAuthorizationServerMetadata(
  asUrl: string,
  fetchFn: FetchLike,
  logger?: Logger,
): Promise<AuthorizationServerDiscovery | null> {
  let failure: { error: unknown } | null = null;
  for (const { url, type } of buildDiscoveryUrls(asUrl)) {
    let metadata: AuthorizationServerMetadata;
    try {
      const doc = await fetchMetadataDocument(url, fetchFn);
      if (doc.kind === 'absent') continue;
      metadata = parseAuthorizationServerMetadata(type, doc.json);
    } catch (e) {
      if (e instanceof SsrfBlockedError) throw e;
      failure ??= { error: e };
      logger?.debug({ url: url.href, err: errMessage(e) }, 'oauth: authorization server metadata candidate failed');
      continue;
    }
    if (!issuersEqual(metadata.issuer, asUrl)) {
      throw new ApiError('oauth_registration_failed', `인가 서버 issuer(${metadata.issuer})가 탐색 URL(${asUrl})과 다릅니다`, {
        authorizationServer: asUrl,
        issuer: metadata.issuer,
      });
    }
    return { metadata, url: url.href };
  }
  if (failure) {
    throw new ApiError('oauth_registration_failed', `인가 서버 메타데이터 조회 실패: ${errMessage(failure.error)}`, { authorizationServer: asUrl });
  }
  return null;
}

/**
 * 2025-03-26 스펙의 기본 엔드포인트 (10.3 탐색 3번의 마지막 폴백): MCP 서버 오리진 기준 /authorize · /token · /register.
 * issuer는 오리진으로 둔다 (issuer 바인딩·state 기록·iss 비교). CIMD·iss 지원을 선언하지 않으므로
 * CIMD는 쓰지 않고 iss도 요구하지 않는다. 폐기 엔드포인트는 기본값이 없다.
 */
export function legacyDefaultMetadata(serverUrl: string): AuthorizationServerMetadata {
  const origin = new URL(serverUrl).origin;
  return {
    issuer: origin,
    authorization_endpoint: new URL('/authorize', origin).href,
    token_endpoint: new URL('/token', origin).href,
    registration_endpoint: new URL('/register', origin).href,
    response_types_supported: ['code'],
  };
}

export interface DiscoveryResult {
  prm: OAuthProtectedResourceMetadata | null;
  prmUrl: string | null;
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata;
  /** 메타데이터 문서 URL. 기본 엔드포인트 폴백이면 null */
  metadataUrl: string | null;
  /** PRM도 AS 메타데이터도 없어 2025-03-26 기본 엔드포인트를 합성했다 */
  metadataFallback: boolean;
  /** 메타데이터가 선언한 issuer (원문 그대로; iss 비교에 쓴다). 폴백이면 MCP 서버 오리진 */
  issuer: string;
}

/**
 * 10.3 탐색 절차:
 * 1. WWW-Authenticate resource_metadata → 없으면 well-known(경로 → 루트)
 * 2. PRM authorization_servers[0]의 AS 메타데이터 (RFC 8414 → OIDC)
 * 3. PRM이 없으면 MCP 서버 오리진의 AS 메타데이터 (2025-03-26 동작)
 * 4. 그것도 없으면 오리진의 기본 엔드포인트 (2025-03-26 이전 동작). PRM이 있거나 PRM 유무가 불확실하면
 *    여기까지 오지 않고 oauth_registration_failed — 그 서버는 메타데이터를 내야 하는 서버다.
 */
export async function discover(
  serverUrl: string,
  www: WwwAuthenticateParams,
  fetchFn: FetchLike,
  logger: Logger,
): Promise<DiscoveryResult> {
  const { found, inconclusive } = await discoverProtectedResource(serverUrl, www.resourceMetadataUrl, fetchFn, logger);
  const fromPrm = found?.prm.authorization_servers?.[0];
  const authorizationServerUrl = fromPrm ?? new URL('/', serverUrl).href;
  if (!found) logger.info({ serverUrl }, 'oauth: no protected resource metadata; falling back to the server origin as authorization server');

  const as = await findAuthorizationServerMetadata(authorizationServerUrl, fetchFn, logger);
  if (as) {
    return {
      prm: found?.prm ?? null,
      prmUrl: found?.url ?? null,
      authorizationServerUrl,
      metadata: as.metadata,
      metadataUrl: as.url,
      metadataFallback: false,
      issuer: as.metadata.issuer,
    };
  }
  if (found || inconclusive) {
    throw new ApiError('oauth_registration_failed', '인가 서버 메타데이터를 찾을 수 없습니다', {
      authorizationServer: authorizationServerUrl,
      protectedResourceMetadata: found ? 'present' : 'unavailable',
    });
  }

  const metadata = legacyDefaultMetadata(serverUrl);
  logger.warn({ serverUrl, issuer: metadata.issuer }, 'oauth: no metadata at all; using the 2025-03-26 default endpoints (/authorize, /token, /register)');
  return {
    prm: null,
    prmUrl: null,
    authorizationServerUrl: metadata.issuer,
    metadata,
    metadataUrl: null,
    metadataFallback: true,
    issuer: metadata.issuer,
  };
}

/**
 * resource 파라미터 선택 (selectResourceURL 의미론): PRM이 있으면 그 resource를 원문 그대로(서버 URL과 호환되는지 검사),
 * 없으면 canonical URL. canonical은 항상 서버 행에 기록한다.
 */
export function selectResource(serverUrl: string, prm: OAuthProtectedResourceMetadata | null): { canonical: string; resource: string } {
  const canonical = canonicalResourceUrl(serverUrl);
  if (!prm) return { canonical, resource: canonical };
  if (!checkResourceAllowed({ requestedResource: canonical, configuredResource: prm.resource })) {
    throw new ApiError('oauth_registration_failed', `PRM resource(${prm.resource})가 서버 URL(${canonical})과 맞지 않습니다`, {
      resource: prm.resource,
      canonical,
    });
  }
  return { canonical, resource: prm.resource };
}
