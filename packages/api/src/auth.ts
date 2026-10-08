/**
 * 인증 훅 계약 (0001 8.3·16.1, 0002).
 *
 * API는 네트워크 위치를 신뢰하지 않으며, 훅이 쿠키·토큰을 직접 검증한다. 훅은 거부할 때
 * `ApiError('unauthenticated')` 또는 `ApiError('reauth_required')`를 던진다 (14.3). 오류 핸들러가 이를
 * 401 JSON으로 바꾼다. 훅은 Fastify `onRequest` 에서 실행된다 — 본문 파싱보다 먼저이므로
 * 인증 없는 큰 본문은 413이 아니라 401을 받는다 (0002 10장).
 *
 * 운영 구현은 `auth/session.ts` 의 `createSessionAuthHooks` (패스키 + 세션 쿠키),
 * 개발 구현은 이 파일의 `createDevAuthHooks` (공유 토큰) 이다.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { ApiError, type AuthStatus } from '@omnicode/shared';
import { validate } from './errors.js';

/** Fastify onRequest 훅(async). 거부할 때는 ApiError를 던진다. */
export type AuthHook = onRequestAsyncHookHandler;
/** @deprecated AuthHook 을 쓴다 (훅은 이제 onRequest 에서 실행된다) */
export type AuthPreHandler = AuthHook;

export interface AuthHooks {
  /** OmniCode 로그인 세션이 없으면 `ApiError('unauthenticated')` */
  requireSession: AuthHook;
  /** 최근(5분) 재인증이 없으면 `ApiError('reauth_required')`. 항상 requireSession 뒤에 실행된다 */
  requireRecentAuth: AuthHook;
  /** 요청에 실린 유효한 세션의 ID. 없으면 null (OAuth state 감사 기록, 완료 페이지 리다이렉트 판단에 쓴다) */
  sessionIdOf(req: FastifyRequest): string | null;
  /** `/api/auth/*` 라우트 (상태·로그인·재인증 등). buildApp 이 prefix `/api/auth` 로 등록한다 */
  routes?: FastifyPluginAsync;
}

export const DEV_COOKIE_NAME = '__Host-omnicode_dev';
export const MIN_DEV_TOKEN_LENGTH = 16;

export interface DevAuthOptions {
  token: string;
}

const DevLoginBodySchema = z.object({ token: z.string().min(1).max(512) });

/**
 * DEV ONLY — 운영 환경에서는 절대 쓰지 않는다.
 *
 * 단일 공유 토큰을 `Authorization: Bearer <token>` 또는 쿠키 `__Host-omnicode_dev=<token>`으로 받는다.
 * 모든 요청을 "방금 재인증한" 것으로 취급하므로 `requireRecentAuth`가 아무것도 추가로 요구하지 않는다.
 * 브라우저에서 쓸 수 있도록 `POST /api/auth/dev-login { token }` 이 쿠키를 설정한다.
 * 쿠키를 읽으려면 `@fastify/cookie`가 등록돼 있어야 한다 (`buildApp`이 등록한다).
 */
export function createDevAuthHooks({ token }: DevAuthOptions): AuthHooks {
  if (typeof token !== 'string' || token.length < MIN_DEV_TOKEN_LENGTH) {
    throw new Error(`dev token must be at least ${MIN_DEV_TOKEN_LENGTH} characters`);
  }
  const expected = Buffer.from(token, 'utf8');
  const sessionId = `dev:${createHash('sha256').update(expected).digest('base64url').slice(0, 16)}`;

  const same = (presented: string | undefined): boolean => {
    if (presented === undefined) return false;
    const actual = Buffer.from(presented, 'utf8');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const matches = (req: FastifyRequest): boolean => same(bearerToken(req) ?? cookieToken(req));

  const requireSession: AuthHook = async (req) => {
    if (!matches(req)) throw new ApiError('unauthenticated', '로그인이 필요합니다.');
  };

  const cookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'lax' as const };

  const routes: FastifyPluginAsync = async (app) => {
    app.addHook('onSend', async (_req, reply, payload) => {
      reply.header('cache-control', 'no-store');
      return payload;
    });

    app.get('/status', async (req): Promise<AuthStatus> => {
      const ok = matches(req);
      return {
        mode: 'dev',
        authenticated: ok,
        setupRequired: false,
        recentAuthUntil: ok ? new Date(Date.now() + 5 * 60 * 1000).toISOString() : null,
        session: ok ? { id: sessionId, createdAt: new Date(0).toISOString(), expiresAt: new Date(8.64e15).toISOString() } : null,
      };
    });

    app.post('/dev-login', async (req, reply) => {
      const body = validate(DevLoginBodySchema, req.body, 'body');
      if (!same(body.token)) throw new ApiError('unauthenticated', '개발용 토큰이 올바르지 않습니다.');
      return reply.setCookie(DEV_COOKIE_NAME, body.token, cookieOptions).code(204).send();
    });

    app.post('/logout', async (_req, reply) => reply.clearCookie(DEV_COOKIE_NAME, cookieOptions).code(204).send());
  };

  return {
    requireSession,
    requireRecentAuth: requireSession,
    sessionIdOf: (req) => (matches(req) ? sessionId : null),
    routes,
  };
}

function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1];
}

function cookieToken(req: FastifyRequest): string | undefined {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;
  return cookies?.[DEV_COOKIE_NAME];
}
