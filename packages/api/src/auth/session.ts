/**
 * 운영 인증 훅 — 패스키 + `__Host-omnicode_session` 쿠키 (설계 0002).
 * `/api/auth/*` 라우트도 여기서 제공한다 (AuthHooks.routes).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, type AuthStatus, type PasskeyView, type ReauthResult, type SessionView, type WebAuthnChallenge } from '@omnicode/shared';
import type { AuthHook, AuthHooks } from '../auth.js';
import { validate } from '../errors.js';
import { SESSION_COOKIE_NAME, type AuthService, type IssuedSession } from './service.js';
import type { SessionRecord } from './store.js';

/** 단순 고정 창 카운터. 프로세스 전체 기준 (CloudFront 뒤라 클라이언트 IP 를 믿지 않는다, 0002 7장) */
export class FixedWindowLimiter {
  private windowStart = 0;
  private count = 0;
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private roll(): void {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.count = 0;
    }
  }

  /** 남은 양이 있으면 하나 쓰고 true */
  take(): boolean {
    this.roll();
    if (this.count >= this.limit) return false;
    this.count++;
    return true;
  }

  /** 쓰지 않고 남은 양만 본다 */
  exhausted(): boolean {
    this.roll();
    return this.count >= this.limit;
  }

  retryAfterSec(): number {
    return Math.max(1, Math.ceil((this.windowStart + this.windowMs - this.now()) / 1000));
  }
}

export interface SessionAuthOptions {
  /** 공개 인증 엔드포인트(options) 분당 한도. 기본 30 */
  optionsPerMinute?: number;
  /** 검증 실패 10분 한도. 기본 20 */
  failuresPer10Min?: number;
  now?: () => number;
}

const CredentialJsonSchema = z
  .object({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal('public-key'),
    response: z.record(z.string(), z.unknown()),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
    authenticatorAttachment: z.string().max(40).optional(),
  })
  .loose();

const SetupOptionsBody = z.object({ setupToken: z.string().min(20).max(200) });
const SetupVerifyBody = z.object({
  setupToken: z.string().min(20).max(200),
  challengeId: z.string().min(1).max(64),
  response: CredentialJsonSchema,
  label: z.string().max(200).optional(),
});
const AssertionBody = z.object({ challengeId: z.string().min(1).max(64), response: CredentialJsonSchema });
const AddPasskeyBody = z.object({ challengeId: z.string().min(1).max(64), response: CredentialJsonSchema, label: z.string().min(1).max(200) });
const PasskeyParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/) });
const SessionParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });

const COOKIE_OPTIONS = { path: '/', secure: true, httpOnly: true, sameSite: 'lax' as const };

function cookieOf(req: FastifyRequest): string | undefined {
  return (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies?.[SESSION_COOKIE_NAME];
}

function userAgentOf(req: FastifyRequest): string | undefined {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : undefined;
}

export function createSessionAuthHooks(service: AuthService, opts: SessionAuthOptions = {}): AuthHooks {
  // 한 요청 안에서 세션을 여러 번 풀지 않는다
  const resolved = new WeakMap<FastifyRequest, SessionRecord | null>();
  const resolve = (req: FastifyRequest): SessionRecord | null => {
    if (resolved.has(req)) return resolved.get(req) ?? null;
    const s = service.resolveSession(cookieOf(req));
    resolved.set(req, s);
    return s;
  };

  const requireSession: AuthHook = async (req) => {
    if (!resolve(req)) throw new ApiError('unauthenticated', '로그인이 필요합니다.');
  };
  const requireRecentAuth: AuthHook = async (req) => {
    const s = resolve(req);
    if (!s) throw new ApiError('unauthenticated', '로그인이 필요합니다.');
    if (!service.isRecent(s)) throw new ApiError('reauth_required', '보안을 위해 패스키로 한 번 더 확인해야 합니다.');
  };
  const current = (req: FastifyRequest): SessionRecord => {
    const s = resolve(req);
    if (!s) throw new ApiError('unauthenticated', '로그인이 필요합니다.');
    return s;
  };

  const now = opts.now ?? Date.now;
  const optionsLimiter = new FixedWindowLimiter(opts.optionsPerMinute ?? 30, 60_000, now);
  const failureLimiter = new FixedWindowLimiter(opts.failuresPer10Min ?? 20, 10 * 60_000, now);

  const rateLimited = (limiter: FixedWindowLimiter, reply: FastifyReply): never => {
    reply.header('retry-after', String(limiter.retryAfterSec()));
    throw new ApiError('rate_limited', '요청이 너무 잦습니다. 잠시 후 다시 시도하세요.', { retryAfterSec: limiter.retryAfterSec() });
  };
  const limitOptions = (reply: FastifyReply) => {
    if (!optionsLimiter.take()) rateLimited(optionsLimiter, reply);
  };
  /** 공개 검증 엔드포인트: 실패가 한도를 넘으면 막고, 실패하면 센다 */
  const guardVerify = async <T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T> => {
    if (failureLimiter.exhausted()) rateLimited(failureLimiter, reply);
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && ['webauthn_failed', 'challenge_invalid', 'setup_token_invalid'].includes(e.code)) failureLimiter.take();
      throw e;
    }
  };

  const setSessionCookie = (reply: FastifyReply, issued: IssuedSession) =>
    reply.setCookie(SESSION_COOKIE_NAME, issued.token, { ...COOKIE_OPTIONS, expires: new Date(issued.session.expiresAt) });
  const clearSessionCookie = (reply: FastifyReply) => reply.clearCookie(SESSION_COOKIE_NAME, COOKIE_OPTIONS);

  const routes: FastifyPluginAsync = async (app) => {
    app.addHook('onSend', async (_req, reply, payload) => {
      reply.header('cache-control', 'no-store');
      return payload;
    });
    const sessionOnly = { onRequest: requireSession };
    const recentOnly = { onRequest: [requireSession, requireRecentAuth] };

    // --- 공개 -----------------------------------------------------------
    app.get('/status', async (req): Promise<AuthStatus> => service.status(cookieOf(req)));

    app.post('/setup/options', async (req, reply): Promise<WebAuthnChallenge> => {
      limitOptions(reply);
      const body = validate(SetupOptionsBody, req.body, 'body');
      return guardVerify(reply, () => service.setupOptions(body.setupToken));
    });

    app.post('/setup/verify', async (req, reply) => {
      const body = validate(SetupVerifyBody, req.body, 'body');
      const issued = await guardVerify(reply, () =>
        service.setupVerify({
          setupToken: body.setupToken,
          challengeId: body.challengeId,
          response: body.response,
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(userAgentOf(req) ? { userAgent: userAgentOf(req) as string } : {}),
        }),
      );
      return setSessionCookie(reply, issued).code(201).send({ ok: true });
    });

    app.post('/login/options', async (_req, reply): Promise<WebAuthnChallenge> => {
      limitOptions(reply);
      return service.loginOptions();
    });

    app.post('/login/verify', async (req, reply) => {
      const body = validate(AssertionBody, req.body, 'body');
      const issued = await guardVerify(reply, () =>
        service.loginVerify({ challengeId: body.challengeId, response: body.response, ...(userAgentOf(req) ? { userAgent: userAgentOf(req) as string } : {}) }),
      );
      return setSessionCookie(reply, issued).send({ ok: true });
    });

    // --- 세션 필요 ----------------------------------------------------------
    app.post('/reauth/options', sessionOnly, async (req): Promise<WebAuthnChallenge> => service.reauthOptions(current(req)));

    app.post('/reauth/verify', sessionOnly, async (req): Promise<ReauthResult> => {
      const body = validate(AssertionBody, req.body, 'body');
      return service.reauthVerify(current(req), { challengeId: body.challengeId, response: body.response });
    });

    app.post('/logout', async (req, reply) => {
      service.logout(cookieOf(req));
      return clearSessionCookie(reply).code(204).send();
    });

    app.get('/passkeys', sessionOnly, async (): Promise<PasskeyView[]> => service.listPasskeys());

    app.post('/passkeys/options', recentOnly, async (req): Promise<WebAuthnChallenge> => service.addPasskeyOptions(current(req)));

    app.post('/passkeys/verify', recentOnly, async (req, reply) => {
      const body = validate(AddPasskeyBody, req.body, 'body');
      const view = await service.addPasskeyVerify(current(req), { challengeId: body.challengeId, response: body.response, label: body.label });
      return reply.code(201).send(view);
    });

    app.delete<{ Params: { id: string } }>('/passkeys/:id', recentOnly, async (req, reply) => {
      const { id } = validate(PasskeyParams, req.params, 'params');
      service.deletePasskey(id);
      return reply.code(204).send();
    });

    app.get('/sessions', sessionOnly, async (req): Promise<SessionView[]> => service.listSessions(current(req)));

    app.delete<{ Params: { id: string } }>('/sessions/:id', sessionOnly, async (req, reply) => {
      const { id } = validate(SessionParams, req.params, 'params');
      const me = current(req);
      if (id === me.publicId) {
        service.logout(cookieOf(req));
        return clearSessionCookie(reply).code(204).send();
      }
      // 다른 세션을 끝내는 것은 고위험 작업이다 (0002 5.3)
      if (!service.isRecent(me)) throw new ApiError('reauth_required', '보안을 위해 패스키로 한 번 더 확인해야 합니다.');
      if (!service.revokeSession(id)) throw new ApiError('not_found', '세션을 찾을 수 없습니다.');
      return reply.code(204).send();
    });
  };

  return { requireSession, requireRecentAuth, sessionIdOf: (req) => resolve(req)?.publicId ?? null, routes };
}
