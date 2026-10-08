/**
 * 인증 훅 계약 (설계 8.3, 16.1).
 *
 * 실제 `requireSession` / `requireRecentAuth`는 OmniCode 인증 설계가 제공한다. API는 네트워크 위치를
 * 신뢰하지 않으며, 훅이 쿠키·토큰을 직접 검증한다고 전제한다. 훅은 거부할 때
 * `ApiError('unauthenticated')` 또는 `ApiError('reauth_required')`를 던진다 (14.3). 오류 핸들러가 이를
 * 401 JSON으로 바꾼다.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { ApiError } from '@omnicode/shared';

/** Fastify preHandler 훅(async). 거부할 때는 ApiError를 던진다. */
export type AuthPreHandler = preHandlerAsyncHookHandler;

export interface AuthHooks {
  /** OmniCode 로그인 세션이 없으면 `ApiError('unauthenticated')` */
  requireSession: AuthPreHandler;
  /** 최근(5분) 재인증이 없으면 `ApiError('reauth_required')`. 항상 requireSession 뒤에 실행된다 */
  requireRecentAuth: AuthPreHandler;
  /** 요청에 실린 유효한 세션의 ID. 없으면 null (OAuth state 감사 기록, 완료 페이지 리다이렉트 판단에 쓴다) */
  sessionIdOf(req: FastifyRequest): string | null;
}

export const DEV_COOKIE_NAME = '__Host-omnicode_dev';
export const MIN_DEV_TOKEN_LENGTH = 16;

export interface DevAuthOptions {
  token: string;
}

/**
 * DEV ONLY — 운영 환경에서는 절대 쓰지 않는다.
 *
 * 단일 공유 토큰을 `Authorization: Bearer <token>` 또는 쿠키 `__Host-omnicode_dev=<token>`으로 받는다.
 * 모든 요청을 "방금 재인증한" 것으로 취급하므로 `requireRecentAuth`가 아무것도 추가로 요구하지 않는다.
 * 운영 훅(세션 쿠키 + 패스키 재인증)은 OmniCode 인증 설계(8.3)가 제공한다.
 * 쿠키를 읽으려면 `@fastify/cookie`가 등록돼 있어야 한다 (`buildApp`이 등록한다).
 */
export function createDevAuthHooks({ token }: DevAuthOptions): AuthHooks {
  if (typeof token !== 'string' || token.length < MIN_DEV_TOKEN_LENGTH) {
    throw new Error(`dev token must be at least ${MIN_DEV_TOKEN_LENGTH} characters`);
  }
  const expected = Buffer.from(token, 'utf8');
  const sessionId = `dev:${createHash('sha256').update(expected).digest('base64url').slice(0, 16)}`;

  const matches = (req: FastifyRequest): boolean => {
    const presented = bearerToken(req) ?? cookieToken(req);
    if (presented === undefined) return false;
    const actual = Buffer.from(presented, 'utf8');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  const requireSession: AuthPreHandler = async (req) => {
    if (!matches(req)) throw new ApiError('unauthenticated', '로그인이 필요합니다.');
  };

  return {
    requireSession,
    requireRecentAuth: requireSession,
    sessionIdOf: (req) => (matches(req) ? sessionId : null),
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
