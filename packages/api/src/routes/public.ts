/**
 * 로그인 없이 열리는 두 경로 (10.3, 14): CIMD 문서와 OAuth 콜백.
 * 콜백은 로그인 쿠키에 의존하지 않는다 — state가 서버 측에서 1회용·단기로 검증된다.
 */
import type { FastifyPluginAsync } from 'fastify';
import { ApiError, SERVER_ID_RE } from '@omnicode/shared';
import type { Hub, OAuthCallbackParams, OAuthCallbackResult } from '@omnicode/hub';
import type { AuthHooks } from '../auth.js';
import { CIMD_PATH, OAUTH_CALLBACK_PATH, buildClientMetadata } from '../cimd.js';
import { errorLogFields, mapError, statusForCode } from '../errors.js';
import { CALLBACK_CSP, renderCallbackPage } from '../pages.js';

export type PublicRoutesOptions = { hub: Hub; auth: AuthHooks; publicUrl: string | null };

const CALLBACK_PARAM_KEYS = ['code', 'state', 'iss', 'error', 'error_description'] as const;

/** 쿼리에서 문자열 값만 고른다 (반복된 키 등 비정상 형태는 없는 것으로 본다) */
export function pickCallbackParams(query: unknown): OAuthCallbackParams {
  const q = (typeof query === 'object' && query !== null ? query : {}) as Record<string, unknown>;
  const out: OAuthCallbackParams = {};
  for (const key of CALLBACK_PARAM_KEYS) {
    const v = q[key];
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

export const publicRoutes: FastifyPluginAsync<PublicRoutesOptions> = async (app, { hub, auth, publicUrl }) => {
  // Buffer로 보내야 Fastify가 charset을 덧붙이지 않아 설계(10.3)대로 `Content-Type: application/json`이 된다
  const cimdJson = publicUrl === null ? null : Buffer.from(JSON.stringify(buildClientMetadata(publicUrl), null, 2), 'utf8');

  app.get(CIMD_PATH, async (_req, reply) => {
    if (cimdJson === null) {
      throw new ApiError('not_found', 'OMNICODE_PUBLIC_URL이 설정되지 않아 CIMD 문서를 제공하지 않습니다.');
    }
    return reply.type('application/json').header('cache-control', 'public, max-age=3600').send(cimdJson);
  });

  app.get(OAUTH_CALLBACK_PATH, async (req, reply) => {
    let result: OAuthCallbackResult;
    try {
      result = await hub.oauth.handleCallback(pickCallbackParams(req.query));
    } catch (err) {
      const mapped = mapError(err);
      const fields = { ...errorLogFields(err, (s) => hub.masker.mask(s)), code: mapped.body.error.code };
      if (mapped.unexpected) req.log.error(fields, 'oauth callback failed');
      else req.log.info(fields, 'oauth callback rejected');
      result = { ok: false, serverId: null, error: mapped.body.error.code };
    }

    reply
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header('content-security-policy', CALLBACK_CSP);

    if (result.ok) {
      const serverId = result.serverId;
      if (serverId !== null && SERVER_ID_RE.test(serverId) && auth.sessionIdOf(req) !== null) {
        return reply.redirect(`/mcp/servers/${serverId}`, 303);
      }
      return reply.code(200).type('text/html; charset=utf-8').send(renderCallbackPage({ kind: 'success' }));
    }
    // 실패 이유는 오류 코드로만 표시한다. 코드가 없으면 Hub 결함이므로 internal(500)로 본다
    const code = result.error ?? 'internal';
    return reply
      .code(statusForCode(code))
      .type('text/html; charset=utf-8')
      .send(renderCallbackPage({ kind: 'failure', code }));
  });
};
