/**
 * packages/web/dist 정적 서빙 + SPA 폴백. `/mcp/*`는 모두 index.html을 돌려준다.
 * HTML 응답의 CSP는 app.ts의 onSend 훅이 붙인다.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';

export type SpaRoutesOptions = { staticDir: string };

export const spaRoutes: FastifyPluginAsync<SpaRoutesOptions> = async (app, { staticDir }) => {
  await app.register(fastifyStatic, {
    root: staticDir,
    prefix: '/',
    wildcard: false, // 등록 시점의 파일만 라우트로 만든다 — 라우터에 catch-all을 두지 않는다
    index: ['index.html'],
    serveDotFiles: false,
    cacheControl: true,
    maxAge: 0,
  });
  const index = async (_req: FastifyRequest, reply: FastifyReply) => reply.sendFile('index.html');
  app.get('/mcp', index);
  app.get('/mcp/*', index);
};
