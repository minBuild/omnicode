/**
 * OAuth 탐색 (설계 10.3 "탐색"). PRM → 인가 서버 메타데이터.
 * SDK 헬퍼를 쓰되 모든 HTTP는 주입된 fetch(guardedFetch, 16.2)로 나간다.
 */
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type { AuthorizationServerMetadata, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
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

/** RFC 9728 PRM 조회. 없으면 null. SSRF 차단은 그대로 던진다. */
export async function discoverProtectedResource(
  serverUrl: string,
  fromHeader: string | null,
  fetchFn: FetchLike,
  logger: Logger,
): Promise<ProtectedResourceDiscovery | null> {
  const base = new URL(serverUrl);
  for (const candidate of prmCandidates(base, fromHeader)) {
    try {
      const prm = await discoverOAuthProtectedResourceMetadata(serverUrl, { resourceMetadataUrl: candidate }, fetchFn);
      return { prm, url: candidate };
    } catch (e) {
      if (e instanceof SsrfBlockedError) throw e;
      logger.debug({ url: candidate, err: errMessage(e) }, 'oauth: protected resource metadata not available');
    }
  }
  return null;
}

/** RFC 8414 / OIDC 메타데이터 조회 + issuer 검증 (RFC 8414 §3.3). */
export async function discoverAuthorizationServer(asUrl: string, fetchFn: FetchLike): Promise<AuthorizationServerMetadata> {
  let metadata: AuthorizationServerMetadata | undefined;
  try {
    metadata = await discoverAuthorizationServerMetadata(asUrl, { fetchFn });
  } catch (e) {
    if (e instanceof SsrfBlockedError) throw e;
    throw new ApiError('oauth_registration_failed', `인가 서버 메타데이터 조회 실패: ${errMessage(e)}`, { authorizationServer: asUrl });
  }
  if (!metadata) {
    throw new ApiError('oauth_registration_failed', '인가 서버 메타데이터를 찾을 수 없습니다', { authorizationServer: asUrl });
  }
  if (!issuersEqual(metadata.issuer, asUrl)) {
    throw new ApiError('oauth_registration_failed', `인가 서버 issuer(${metadata.issuer})가 탐색 URL(${asUrl})과 다릅니다`, {
      authorizationServer: asUrl,
      issuer: metadata.issuer,
    });
  }
  return metadata;
}

export interface DiscoveryResult {
  prm: OAuthProtectedResourceMetadata | null;
  prmUrl: string | null;
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata;
  /** 메타데이터가 선언한 issuer (원문 그대로; iss 비교에 쓴다) */
  issuer: string;
}

/**
 * 10.3 탐색 절차:
 * 1. WWW-Authenticate resource_metadata → 없으면 well-known(경로 → 루트)
 * 2. PRM authorization_servers[0]의 AS 메타데이터
 * 3. PRM이 없으면 MCP 서버 오리진의 AS 메타데이터 (2025-03-26 동작)
 */
export async function discover(
  serverUrl: string,
  www: WwwAuthenticateParams,
  fetchFn: FetchLike,
  logger: Logger,
): Promise<DiscoveryResult> {
  const found = await discoverProtectedResource(serverUrl, www.resourceMetadataUrl, fetchFn, logger);
  const fromPrm = found?.prm.authorization_servers?.[0];
  const authorizationServerUrl = fromPrm ?? new URL('/', serverUrl).href;
  if (!found) logger.info({ serverUrl }, 'oauth: no protected resource metadata; falling back to the server origin as authorization server');
  const metadata = await discoverAuthorizationServer(authorizationServerUrl, fetchFn);
  return {
    prm: found?.prm ?? null,
    prmUrl: found?.url ?? null,
    authorizationServerUrl,
    metadata,
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
