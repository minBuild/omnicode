/**
 * 가짜 인가 서버 (설계 18장 "OAuth 통합" 픽스처).
 * 임시 포트의 node:http 서버 하나가 인가 서버 메타데이터, PRM, /register, /token, /revoke, 그리고
 * 401을 돌려주는 MCP 서버 경로(/mcp)를 모두 제공한다.
 *
 * authorization_endpoint는 기본적으로 https://as.example/authorize 로 광고한다 (브라우저가 가는 곳이라
 * 테스트는 절대 fetch하지 않는다). 테스트는 `issueCode(authorizationUrl)`로 사용자의 로그인·동의를 흉내 낸다.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type TokenFailure = 'invalid_grant' | 'invalid_client' | 'server_error' | 'temporarily_unavailable' | 'network';

export interface FakeAsOptions {
  /** client_id_metadata_document_supported: true */
  cimd?: boolean;
  /** registration_endpoint 제공 */
  dcr?: boolean;
  /** authorization_response_iss_parameter_supported: true */
  issParam?: boolean;
  /** revocation_endpoint 제공 */
  revocation?: boolean;
  /** DCR 응답에 client_secret을 넣는다 */
  dcrClientSecret?: string | null;
  /** token_endpoint_auth_methods_supported (null이면 필드 생략) */
  tokenAuthMethods?: string[] | null;
  /** authorization_endpoint 덮어쓰기 (기본 https://as.example/authorize) */
  authorizationEndpoint?: string | null;
  /** AS 메타데이터 자체를 제공하지 않는다 (404) */
  metadata?: boolean;
  /** 메타데이터의 issuer를 다른 값으로 광고한다 (RFC 8414 §3.3 검증 테스트용) */
  issuerOverride?: string | null;
  prm?: { enabled?: boolean; scopes?: string[]; authorizationServers?: string[]; resource?: string };
  /** /token 실패 시뮬레이션 (언제든 바꿀 수 있다) */
  tokenFailure?: TokenFailure | null;
  /** /revoke 응답 코드 (기본 200) */
  revokeStatus?: number;
  /** expires_in (null이면 생략) */
  accessTokenTtlSec?: number | null;
  /** refresh 때 refresh token을 회전한다 (기본 true) */
  rotateRefreshTokens?: boolean;
  /** MCP 서버 경로 (기본 /mcp) */
  mcpPath?: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  form: Record<string, string>;
  json: unknown;
}

export interface IssuedTokens {
  grant: 'authorization_code' | 'refresh_token';
  client_id: string;
  access_token: string;
  refresh_token: string | null;
}

export interface FakeAs {
  readonly url: string;
  readonly issuer: string;
  readonly mcpUrl: string;
  readonly prmUrl: string;
  /** 변경 가능. 다음 요청부터 반영된다 */
  readonly options: FakeAsOptions;
  readonly requests: RecordedRequest[];
  readonly registrations: Array<Record<string, unknown>>;
  readonly revoked: Array<{ token: string; token_type_hint: string | null; client_id: string | null }>;
  readonly issued: IssuedTokens[];
  readonly validRefreshTokens: Set<string>;
  /** 사전 등록 client를 등록한다 (client_secret이 있으면 토큰·폐기 요청에서 검사한다) */
  addClient(client: { client_id: string; client_secret?: string }): void;
  /** 사용자가 로그인·동의했다고 치고 인가 코드를 발급한다 (인가 URL의 파라미터를 검증한다) */
  issueCode(authorizationUrl: string | URL): { code: string; state: string | null; params: URLSearchParams };
  /** refresh 가능한 토큰을 직접 심는다 */
  seedRefreshToken(token: string, info: { clientId: string; resource?: string | null; scope?: string | null }): void;
  count(path: string, method?: string): number;
  requestsTo(path: string, method?: string): RecordedRequest[];
  close(): Promise<void>;
}

interface CodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource: string | null;
  scope: string | null;
  used: boolean;
}

interface RefreshRecord {
  clientId: string;
  resource: string | null;
  scope: string | null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function startFakeAs(options: FakeAsOptions = {}): Promise<FakeAs> {
  const opts: FakeAsOptions = {
    cimd: false,
    dcr: false,
    issParam: false,
    revocation: false,
    dcrClientSecret: null,
    tokenAuthMethods: ['none', 'client_secret_post', 'client_secret_basic'],
    authorizationEndpoint: null,
    metadata: true,
    issuerOverride: null,
    tokenFailure: null,
    revokeStatus: 200,
    accessTokenTtlSec: 3600,
    rotateRefreshTokens: true,
    mcpPath: '/mcp',
    ...options,
    prm: { enabled: true, ...options.prm },
  };

  const requests: RecordedRequest[] = [];
  const registrations: Array<Record<string, unknown>> = [];
  const revoked: FakeAs['revoked'] = [];
  const issued: IssuedTokens[] = [];
  const clients = new Map<string, { client_id: string; client_secret?: string }>();
  const codes = new Map<string, CodeRecord>();
  const refreshTokens = new Map<string, RefreshRecord>();
  let seq = 0;

  let url = '';
  const mcpPath = opts.mcpPath ?? '/mcp';
  const mcpUrl = (): string => `${url}${mcpPath}`;
  const prmUrl = (): string => `${url}/.well-known/oauth-protected-resource${mcpPath}`;

  const metadata = (): Record<string, unknown> => {
    const m: Record<string, unknown> = {
      issuer: opts.issuerOverride ?? url,
      authorization_endpoint: opts.authorizationEndpoint ?? 'https://as.example/authorize',
      token_endpoint: `${url}/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
    };
    if (opts.tokenAuthMethods) m.token_endpoint_auth_methods_supported = opts.tokenAuthMethods;
    if (opts.dcr) m.registration_endpoint = `${url}/register`;
    if (opts.cimd) m.client_id_metadata_document_supported = true;
    if (opts.issParam) m.authorization_response_iss_parameter_supported = true;
    if (opts.revocation) m.revocation_endpoint = `${url}/revoke`;
    return m;
  };

  const prm = (): Record<string, unknown> => ({
    resource: opts.prm?.resource ?? mcpUrl(),
    authorization_servers: opts.prm?.authorizationServers ?? [url],
    ...(opts.prm?.scopes ? { scopes_supported: opts.prm.scopes } : {}),
  });

  const isKnownClient = (clientId: string): boolean => clients.has(clientId) || (!!opts.cimd && clientId.startsWith('https://'));

  /** Basic 헤더 또는 본문의 client_id/client_secret으로 클라이언트를 확인한다. 실패하면 null */
  const authenticate = (req: IncomingMessage, form: Record<string, string>): string | null => {
    let clientId: string | null = form.client_id ?? null;
    let secret: string | null = form.client_secret ?? null;
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      clientId = i >= 0 ? decoded.slice(0, i) : decoded;
      secret = i >= 0 ? decoded.slice(i + 1) : null;
    }
    if (!clientId) return null;
    const known = clients.get(clientId);
    if (known) return known.client_secret === undefined || known.client_secret === secret ? clientId : null;
    if (opts.cimd && clientId.startsWith('https://')) return clientId;
    return null;
  };

  const issue = (grant: IssuedTokens['grant'], clientId: string, resource: string | null, scope: string | null, withRefresh: boolean): Record<string, unknown> => {
    seq += 1;
    const access_token = `at-${String(seq).padStart(3, '0')}-${randomBytes(6).toString('hex')}`;
    const body: Record<string, unknown> = { access_token, token_type: 'Bearer' };
    let refresh_token: string | null = null;
    if (withRefresh) {
      refresh_token = `rt-${String(seq).padStart(3, '0')}-${randomBytes(6).toString('hex')}`;
      refreshTokens.set(refresh_token, { clientId, resource, scope });
      body.refresh_token = refresh_token;
    }
    if (opts.accessTokenTtlSec !== null && opts.accessTokenTtlSec !== undefined) body.expires_in = opts.accessTokenTtlSec;
    if (scope) body.scope = scope;
    issued.push({ grant, client_id: clientId, access_token, refresh_token });
    return body;
  };

  const handleRegister = (res: ServerResponse, json: unknown): void => {
    if (!opts.dcr) return sendJson(res, 404, { error: 'not_found' });
    const meta = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
    const redirectUris = meta.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris required' });
    }
    const client_id = `dcr-${randomBytes(6).toString('hex')}`;
    const client_secret = opts.dcrClientSecret ?? undefined;
    clients.set(client_id, { client_id, ...(client_secret ? { client_secret } : {}) });
    registrations.push(meta);
    sendJson(res, 201, {
      ...meta,
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: client_secret ? 'client_secret_post' : 'none',
      registration_access_token: `rat-${randomBytes(6).toString('hex')}`,
      registration_client_uri: `${url}/register/${client_id}`,
      ...(client_secret ? { client_secret } : {}),
    });
  };

  const handleToken = (req: IncomingMessage, res: ServerResponse, form: Record<string, string>): void => {
    switch (opts.tokenFailure) {
      case 'network':
        req.socket.destroy();
        return;
      case 'server_error':
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('boom');
        return;
      case 'temporarily_unavailable':
        return sendJson(res, 503, { error: 'temporarily_unavailable', error_description: 'simulated outage' });
      case 'invalid_client':
        return sendJson(res, 401, { error: 'invalid_client', error_description: 'simulated' });
      case 'invalid_grant':
        return sendJson(res, 400, { error: 'invalid_grant', error_description: 'simulated' });
      default:
        break;
    }
    const clientId = authenticate(req, form);
    if (!clientId) return sendJson(res, 401, { error: 'invalid_client', error_description: 'client authentication failed' });

    if (form.grant_type === 'authorization_code') {
      const rec = codes.get(form.code ?? '');
      if (!rec || rec.used) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'unknown or used code' });
      if (rec.clientId !== clientId) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'code issued to another client' });
      const challenge = createHash('sha256').update(form.code_verifier ?? '').digest('base64url');
      if (challenge !== rec.codeChallenge) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'pkce verification failed' });
      if ((form.redirect_uri ?? '') !== rec.redirectUri) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      if (rec.resource !== null && form.resource !== rec.resource) return sendJson(res, 400, { error: 'invalid_target', error_description: 'resource mismatch' });
      rec.used = true;
      return sendJson(res, 200, issue('authorization_code', clientId, rec.resource, rec.scope, true));
    }

    if (form.grant_type === 'refresh_token') {
      const old = form.refresh_token ?? '';
      const info = refreshTokens.get(old);
      if (!info) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'unknown refresh token' });
      if (info.clientId !== clientId) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'refresh token issued to another client' });
      if (info.resource !== null && form.resource !== undefined && form.resource !== info.resource) {
        return sendJson(res, 400, { error: 'invalid_target', error_description: 'resource mismatch' });
      }
      const rotate = opts.rotateRefreshTokens !== false;
      if (rotate) refreshTokens.delete(old);
      return sendJson(res, 200, issue('refresh_token', clientId, info.resource, info.scope, rotate));
    }

    return sendJson(res, 400, { error: 'unsupported_grant_type' });
  };

  const handleRevoke = (req: IncomingMessage, res: ServerResponse, form: Record<string, string>): void => {
    if (!opts.revocation) return sendJson(res, 404, { error: 'not_found' });
    const clientId = authenticate(req, form);
    revoked.push({ token: form.token ?? '', token_type_hint: form.token_type_hint ?? null, client_id: clientId });
    if (!clientId) return sendJson(res, 401, { error: 'invalid_client' });
    if (form.token) refreshTokens.delete(form.token);
    res.writeHead(opts.revokeStatus ?? 200);
    res.end();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    const u = new URL(req.url ?? '/', url);
    const path = u.pathname;
    const method = req.method ?? 'GET';
    const ct = String(req.headers['content-type'] ?? '');
    const form = ct.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(body)) : {};
    let json: unknown = null;
    if (ct.includes('application/json') && body) {
      try {
        json = JSON.parse(body);
      } catch {
        json = null;
      }
    }
    requests.push({ method, path, headers: req.headers, body, form, json });

    if (method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      if (opts.metadata === false) return sendJson(res, 404, { error: 'not_found' });
      return sendJson(res, 200, metadata());
    }
    if (method === 'GET' && path.startsWith('/.well-known/openid-configuration')) return sendJson(res, 404, { error: 'not_found' });
    if (method === 'GET' && (path === `/.well-known/oauth-protected-resource${mcpPath}` || path === '/.well-known/oauth-protected-resource')) {
      if (opts.prm?.enabled === false) return sendJson(res, 404, { error: 'not_found' });
      return sendJson(res, 200, prm());
    }
    if (method === 'POST' && path === '/register') return handleRegister(res, json);
    if (method === 'POST' && path === '/token') return handleToken(req, res, form);
    if (method === 'POST' && path === '/revoke') return handleRevoke(req, res, form);
    if (path === mcpPath) {
      res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${prmUrl()}"` });
      res.end();
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      sendJson(res, 500, { error: 'server_error', error_description: e instanceof Error ? e.message : String(e) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    get url() {
      return url;
    },
    get issuer() {
      return opts.issuerOverride ?? url;
    },
    get mcpUrl() {
      return mcpUrl();
    },
    get prmUrl() {
      return prmUrl();
    },
    options: opts,
    requests,
    registrations,
    revoked,
    issued,
    get validRefreshTokens() {
      return new Set(refreshTokens.keys());
    },
    addClient(client) {
      clients.set(client.client_id, client);
    },
    issueCode(authorizationUrl) {
      const u = typeof authorizationUrl === 'string' ? new URL(authorizationUrl) : authorizationUrl;
      const p = u.searchParams;
      if (p.get('response_type') !== 'code') throw new Error('fake-as: response_type must be code');
      if (p.get('code_challenge_method') !== 'S256') throw new Error('fake-as: code_challenge_method must be S256');
      const clientId = p.get('client_id');
      const codeChallenge = p.get('code_challenge');
      if (!clientId || !isKnownClient(clientId)) throw new Error(`fake-as: unknown client_id ${clientId}`);
      if (!codeChallenge) throw new Error('fake-as: code_challenge missing');
      const code = `code-${randomBytes(8).toString('hex')}`;
      codes.set(code, {
        clientId,
        codeChallenge,
        redirectUri: p.get('redirect_uri') ?? '',
        resource: p.get('resource'),
        scope: p.get('scope'),
        used: false,
      });
      return { code, state: p.get('state'), params: p };
    },
    seedRefreshToken(token, info) {
      refreshTokens.set(token, { clientId: info.clientId, resource: info.resource ?? null, scope: info.scope ?? null });
    },
    count(path, method) {
      return requests.filter((r) => r.path === path && (!method || r.method === method)).length;
    },
    requestsTo(path, method) {
      return requests.filter((r) => r.path === path && (!method || r.method === method));
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
