/**
 * Fastify 앱 조립. main.ts만 실제 Hub를 넣고, 테스트는 가짜 Hub를 넣는다.
 */
import { existsSync } from 'node:fs';
import fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type { Logger } from 'pino';
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
  logger?: Logger;
};

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const { hub, auth, publicUrl, staticDir, logger } = opts;
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
  app.register(mcpRoutes, { hub, auth, prefix: '/api/mcp' });
  if (staticDir && existsSync(staticDir)) app.register(spaRoutes, { staticDir });

  return app;
}
