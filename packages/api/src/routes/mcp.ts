/**
 * 14.1 화면용 API `/api/mcp/*`. 전부 `requireSession` 뒤에 있다.
 * 본문·쿼리는 zod로 검증하고(400 validation_error), `:id`는 Hub에 닿기 전에 검증한다.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApiError,
  ApproveBodySchema,
  AuditQuerySchema,
  CreateServerBodySchema,
  CredentialsBodySchema,
  OAuthClientBodySchema,
  PatchServerBodySchema,
  RegistrySearchQuerySchema,
  RotateTokensBodySchema,
  ServerIdSchema,
  type DeleteResult,
} from '@omnicode/shared';
import type { Hub } from '@omnicode/hub';
import type { AuthHooks } from '../auth.js';
import { validate } from '../errors.js';

export type McpRoutesOptions = { hub: Hub; auth: AuthHooks };

const IdParamsSchema = z.object({ id: ServerIdSchema });

/** 수명주기 이벤트 필터 — 호출 기록과 같되 `outcome`은 없다 (14.1) */
export const EventsQuerySchema = AuditQuerySchema.omit({ outcome: true });

type IdRequest = FastifyRequest<{ Params: { id: string } }>;
type IdRoute = { Params: { id: string } };

const idOf = (req: IdRequest): string => validate(IdParamsSchema, req.params, 'params').id;

/** 9.4: 절차가 끝났으면 200, 진행 중(또는 중단)이면 202 */
const sendDeleteResult = (reply: FastifyReply, result: DeleteResult) =>
  reply.code(result.status === 'deleted' ? 200 : 202).send(result);

export const mcpRoutes: FastifyPluginAsync<McpRoutesOptions> = async (api, { hub, auth }) => {
  // onRequest: 본문 파싱보다 먼저 인증한다 (0002 10장)
  api.addHook('onRequest', auth.requireSession);
  const recentAuth = { onRequest: auth.requireRecentAuth };

  // --- 서버 -------------------------------------------------------------
  api.get('/servers', async () => hub.servers.list());

  api.post('/servers', async (req, reply) => {
    const body = validate(CreateServerBodySchema, req.body, 'body');
    const detail = await hub.servers.create(body);
    return reply.code(201).send(detail);
  });

  api.get<IdRoute>('/servers/:id', async (req) => {
    const id = idOf(req);
    const detail = await hub.servers.get(id);
    if (!detail) throw new ApiError('not_found', `서버를 찾을 수 없습니다: ${id}`, { id });
    return detail;
  });

  api.patch<IdRoute>('/servers/:id', async (req) => {
    const id = idOf(req);
    const body = validate(PatchServerBodySchema, req.body, 'body');
    return hub.servers.patch(id, body);
  });

  api.delete<IdRoute>('/servers/:id', async (req, reply) => {
    const id = idOf(req);
    return sendDeleteResult(reply, await hub.servers.delete(id));
  });

  api.post<IdRoute>('/servers/:id/delete/force', recentAuth, async (req, reply) => {
    const id = idOf(req);
    return sendDeleteResult(reply, await hub.servers.delete(id, { force: true }));
  });

  // --- 인증 -------------------------------------------------------------
  api.put<IdRoute>('/servers/:id/credentials', async (req, reply) => {
    const id = idOf(req);
    const body = validate(CredentialsBodySchema, req.body, 'body');
    await hub.servers.setCredentials(id, body.headerName, body.value);
    return reply.code(204).send(); // 쓰기 전용: 값은 어떤 응답에도 싣지 않는다
  });

  api.post<IdRoute>('/servers/:id/oauth/client', async (req) => {
    const id = idOf(req);
    const body = validate(OAuthClientBodySchema, req.body, 'body');
    await hub.oauth.setPreregisteredClient(id, body.clientId, body.clientSecret);
    const detail = await hub.servers.get(id);
    if (!detail) throw new ApiError('not_found', `서버를 찾을 수 없습니다: ${id}`, { id });
    return detail;
  });

  api.post<IdRoute>('/servers/:id/oauth/start', async (req) => {
    const id = idOf(req);
    return hub.oauth.start(id, { sessionId: auth.sessionIdOf(req) });
  });

  // --- 승인·탐지·테스트 ----------------------------------------------------
  api.post<IdRoute>('/servers/:id/approve', async (req) => {
    const id = idOf(req);
    const body = validate(ApproveBodySchema, req.body, 'body');
    return hub.servers.approve(id, body);
  });

  api.post<IdRoute>('/servers/:id/probe', async (req) => hub.servers.probe(idOf(req)));

  api.post<IdRoute>('/servers/:id/test', async (req) => hub.servers.test(idOf(req)));

  // --- 동기화 ------------------------------------------------------------
  api.post('/sync', async () => hub.sync.all());
  api.get('/sync/plan', async () => hub.sync.plan());

  // --- 기록 --------------------------------------------------------------
  api.get('/audit', async (req) => hub.audit(validate(AuditQuerySchema, req.query, 'query')));
  api.get('/events', async (req) => hub.events(validate(EventsQuerySchema, req.query, 'query')));

  // --- Hub ---------------------------------------------------------------
  api.get('/hub/status', async () => hub.status());

  api.post('/hub/tokens/rotate', recentAuth, async (req) => {
    const body = validate(RotateTokensBodySchema, req.body, 'body');
    return hub.tokens.rotate(body.agents);
  });

  // --- 프리셋·레지스트리 ------------------------------------------------------
  api.get('/presets', async () => hub.presets());

  // 레지스트리 검색 (Phase 3): OMNICODE_MCP_REGISTRY_URL 이 없으면 { enabled: false }
  api.get('/registry/search', async (req) => {
    const q = validate(RegistrySearchQuerySchema, req.query, 'query');
    return hub.catalog.search(q.q, q.cursor);
  });
};
