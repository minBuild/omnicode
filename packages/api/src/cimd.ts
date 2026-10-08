/**
 * 10.3 CIMD(Client ID Metadata Document). 비밀값이 없는 공개 문서다.
 * Hub의 OAuth 모듈은 같은 규칙으로 `client_id`·`redirect_uri`를 만들어야 한다 (`clientIdFor`, `redirectUriFor`).
 */
export const CIMD_PATH = '/.well-known/omnicode/client.json';
export const OAUTH_CALLBACK_PATH = '/oauth/callback';

export interface ClientMetadataDocument {
  client_id: string;
  client_name: string;
  client_uri: string;
  redirect_uris: string[];
  grant_types: ['authorization_code', 'refresh_token'];
  response_types: ['code'];
  token_endpoint_auth_method: 'none';
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * `OMNICODE_PUBLIC_URL`을 오리진(`https://<도메인>`)으로 정규화한다.
 * 경로·쿼리·해시·자격증명은 거부하고, `http:`는 루프백 호스트(개발)에만 허용한다.
 */
export function normalizePublicUrl(publicUrl: string): string {
  let u: URL;
  try {
    u = new URL(publicUrl.trim());
  } catch {
    throw new Error(`OMNICODE_PUBLIC_URL이 URL이 아닙니다: ${publicUrl}`);
  }
  const httpLoopback = u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
  if (u.protocol !== 'https:' && !httpLoopback) {
    throw new Error('OMNICODE_PUBLIC_URL은 https 오리진이어야 합니다 (http는 루프백만 허용)');
  }
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') {
    throw new Error('OMNICODE_PUBLIC_URL은 경로·쿼리 없는 오리진(https://<도메인>)이어야 합니다');
  }
  return u.origin;
}

export function clientIdFor(publicUrl: string): string {
  return normalizePublicUrl(publicUrl) + CIMD_PATH;
}

export function redirectUriFor(publicUrl: string): string {
  return normalizePublicUrl(publicUrl) + OAUTH_CALLBACK_PATH;
}

export function buildClientMetadata(publicUrl: string): ClientMetadataDocument {
  const origin = normalizePublicUrl(publicUrl);
  const host = new URL(origin).host;
  return {
    client_id: origin + CIMD_PATH,
    client_name: `OmniCode (${host})`,
    client_uri: origin,
    redirect_uris: [origin + OAUTH_CALLBACK_PATH],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}
