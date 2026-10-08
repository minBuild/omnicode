/**
 * packages/web/dist 정적 서빙 + SPA 폴백. 화면 경로(`/mcp*`, `/login`, `/setup`, `/settings*`)는 index.html.
 * HTML 응답의 CSP는 app.ts의 onSend 훅이 붙인다.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';

export type SpaRoutesOptions = {
  staticDir: string;
  /** true 면 요청 시점에 디스크에서 파일을 찾는다 (개발용, D5). false 면 등록 시점 파일만 라우트로 만든다 */
  live?: boolean;
};

/** SPA 가 클라이언트에서 라우팅하는 경로 (packages/web/src/App.tsx 와 맞춘다) */
export const SPA_PATHS = ['/mcp', '/mcp/*', '/login', '/setup', '/settings', '/settings/*'] as const;

export const spaRoutes: FastifyPluginAsync<SpaRoutesOptions> = async (app, { staticDir, live = false }) => {
  await app.register(fastifyStatic, {
    root: staticDir,
    prefix: '/',
    // false: 등록 시점의 파일만 라우트로 만든다 — 라우터에 catch-all을 두지 않는다 (운영 기본)
    wildcard: live,
    index: ['index.html'],
    serveDotFiles: false,
    cacheControl: true,
    maxAge: 0,
  });
  const index = async (_req: FastifyRequest, reply: FastifyReply) => reply.sendFile('index.html');
  for (const path of SPA_PATHS) app.get(path, index);
};
