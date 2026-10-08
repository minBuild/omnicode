/**
 * Fastify 앱 조립. main.ts만 실제 Hub를 넣고, 테스트는 가짜 Hub를 넣는다.
 */
import { existsSync } from 'node:fs';
import fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type { Logger } from 'pino';
import { ApiError } from '@omnicode/shared';
import type { Hub } from '@omnicode/hub';
import type { AuthHooks } from './auth.js';
import { errorBody, errorLogFields, mapError, type ErrorBody } from './errors.js';
import { SPA_CSP } from './pages.js';
import { mcpRoutes } from './routes/mcp.js';
import { publicRoutes } from './routes/public.js';
import { spaRoutes } from './routes/spa.js';

/** 요청 본문 상한 (1 MiB) */
export const BODY_LIMIT_BYTES = 1024 * 1024;

export type BuildAppOptions = {
  hub: Hub;
  auth: AuthHooks;
  /** OMNICODE_PUBLIC_URL. null이면 CIMD 문서를 제공하지 않는다 (Tailscale 전용 배포) */
  publicUrl: string | null;
  /** packages/web/dist. 없거나 존재하지 않으면 정적 서빙을 건너뛴다 */
  staticDir?: string;
  /** 개발용: 정적 파일을 요청 시점에 디스크에서 찾는다 (웹을 다시 빌드해도 재시작 불필요, D5) */
  staticLive?: boolean;
  /**
   * 상태를 바꾸는 `/api/*` 요청의 Origin 이 이 값과 달라야 거부한다 (0002 7장 CSRF).
   * 지정하지 않으면 publicUrl 의 origin. null 이면 Origin 비교를 하지 않는다 (Sec-Fetch-Site 검사는 한다).
   */
  allowedOrigin?: string | null;
  logger?: Logger;
};

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 0002 7장: 교차 사이트에서 온 상태 변경 요청을 막는다. Origin 이 없으면(브라우저가 아닌 클라이언트) 통과 */
export function checkSameOrigin(req: FastifyRequest, allowedOrigin: string | null): void {
  if (!STATE_CHANGING.has(req.method) || !req.url.startsWith('/api/')) return;
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') throw new ApiError('forbidden', '다른 사이트에서 보낸 요청은 받지 않습니다.');
  const origin = req.headers.origin;
  if (allowedOrigin !== null && typeof origin === 'string' && origin !== allowedOrigin) {
    throw new ApiError('forbidden', '허용되지 않은 출처(Origin)입니다.', { origin: origin.slice(0, 200) });
  }
}

function originOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const { hub, auth, publicUrl, staticDir, logger } = opts;
  const allowedOrigin = opts.allowedOrigin === undefined ? originOf(publicUrl) : opts.allowedOrigin;
  // pino Logger를 FastifyBaseLogger로 좁혀 인스턴스 제네릭을 기본값(FastifyInstance)으로 유지한다
  const loggerInstance: FastifyBaseLogger | undefined = logger;
  const app: FastifyInstance = loggerInstance
    ? fastify({ loggerInstance, bodyLimit: BODY_LIMIT_BYTES, trustProxy: false })
    : fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES, trustProxy: false });

  const mask = (s: string) => hub.masker.mask(s);

  /** 14.3 형식의 오류 응답. 직렬화한 뒤 마스킹 사전을 통과시킨다 (16.6: API 오류 응답에 비밀값 0건) */
  const sendError = (reply: FastifyReply, status: number, body: ErrorBody) =>
    reply
      .code(status)
      .header('cache-control', 'no-store')
      .type('application/json; charset=utf-8')
      .send(mask(JSON.stringify(body)));

  app.register(fastifyCookie);

  // 요청 위조 방어는 인증 훅보다 먼저, 본문 파싱보다 먼저 (0002 7장)
  app.addHook('onRequest', async (req) => checkSameOrigin(req, allowedOrigin));

  // 모든 응답에 보안 헤더 (16.3). HTML에는 SPA CSP — 콜백 페이지는 더 엄격한 자체 CSP를 먼저 붙인다.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('referrer-policy')) reply.header('referrer-policy', 'no-referrer');
    const contentType = reply.getHeader('content-type');
    if (
      typeof contentType === 'string' &&
      contentType.toLowerCase().startsWith('text/html') &&
      !reply.hasHeader('content-security-policy')
    ) {
      reply.header('content-security-policy', SPA_CSP);
    }
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    const mapped = mapError(err);
    if (mapped.unexpected) {
      req.log.error({ ...errorLogFields(err, mask), status: mapped.status }, 'request failed');
    } else {
      req.log.info({ code: mapped.body.error.code, status: mapped.status }, 'request rejected');
    }
    return sendError(reply, mapped.status, mapped.body);
  });

  app.setNotFoundHandler((req, reply) =>
    sendError(
      reply,
      404,
      errorBody('not_found', '경로를 찾을 수 없습니다.', { method: req.method, path: req.url.split('?')[0]?.slice(0, 200) }),
    ),
  );

  app.register(publicRoutes, { hub, auth, publicUrl });
  if (auth.routes) app.register(auth.routes, { prefix: '/api/auth' });
  app.register(mcpRoutes, { hub, auth, prefix: '/api/mcp' });
  if (staticDir && existsSync(staticDir)) app.register(spaRoutes, { staticDir, live: opts.staticLive ?? false });

  return app;
}
