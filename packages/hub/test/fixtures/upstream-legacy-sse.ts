/**
 * 가짜 HTTP+SSE(2024-11-05) 업스트림 — SDK `SSEServerTransport`. 11.1 (3) 폴백과 SSE 경로의 도구 호출 검증용.
 * GET /sse → endpoint 이벤트, POST /messages?sessionId=… → 메시지(202, 응답·progress·알림은 GET 스트림으로), POST /sse → 405.
 * 도구는 upstream-legacy 와 같은 echo / slow(progress) / fail (buildLegacyMcpServer).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  buildLegacyMcpServer,
  closeServer,
  flattenHeaders,
  listen,
  readRequestBody,
  rpcMethodOf,
  type LegacyToolState,
  type RecordedRequest,
} from './upstream-legacy.js';

export interface LegacySseFixtureOptions {
  /** tools/list 페이지 크기 (없으면 한 페이지) */
  pageSize?: number;
}

export interface LegacySseFixture {
  /** 커넥터에 넘길 URL (…/sse) */
  readonly url: string;
  readonly requests: RecordedRequest[];
  count(rpcMethod?: string): number;
  /**
   * null이면 해제. 설정 중에는 요청에 status(기본 401) + WWW-Authenticate.
   * where='stream'이면 GET /sse 만 거절한다 (POST /sse 는 그대로 405 — 라우트별 인증 서버 흉내).
   */
  setUnauthorized(wwwAuthenticate: string | null, status?: number, where?: 'all' | 'stream'): void;
  readonly unauthorizedHits: number;
  /** 켜 두면 GET /sse 가 SSE 헤더만 보내고 endpoint 이벤트 없이 연결을 붙잡는다 (세션을 만들지 않는다) */
  setStallStreams(on: boolean): void;
  /** 붙잡고 있는(아직 클라이언트가 닫지 않은) 멈춘 스트림 수 */
  stalledStreams(): number;
  emitListChanged(kind: 'tools' | 'prompts' | 'resources'): Promise<void>;
  /** 모든 세션을 버리고 SSE 스트림을 닫는다 → 옛 sessionId 로 오는 POST 는 404 */
  dropSessions(): Promise<void>;
  sessionIds(): string[];
  /** 받은 GET /sse (스트림 연결) 요청 수. 거절된 것도 센다 */
  streamCount(): number;
  /** slow 도구가 취소(notifications/cancelled)를 보고 멈춘 횟수 */
  readonly cancelledCalls: number;
  close(): Promise<void>;
}

interface SseSession {
  mcp: McpServer;
  transport: SSEServerTransport;
}

export async function startLegacySseFixture(opts: LegacySseFixtureOptions = {}): Promise<LegacySseFixture> {
  const requests: RecordedRequest[] = [];
  const sessions = new Map<string, SseSession>();
  const state: LegacyToolState = { cancelledCalls: 0 };
  let unauthorized: { www: string | null; status: number; streamOnly: boolean } | null = null;
  let unauthorizedHits = 0;
  let stall = false;
  const stalled = new Set<ServerResponse>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const raw = req.method === 'POST' ? await readRequestBody(req) : '';
    let body: unknown;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    requests.push({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: flattenHeaders(req),
      body,
      rpcMethod: rpcMethodOf(body),
      sessionId: u.searchParams.get('sessionId') ?? undefined,
    });

    const isStream = u.pathname === '/sse' && req.method === 'GET';
    if (unauthorized && (!unauthorized.streamOnly || isStream)) {
      unauthorizedHits++;
      res.writeHead(unauthorized.status, {
        'content-type': 'text/plain',
        ...(unauthorized.www ? { 'www-authenticate': unauthorized.www } : {}),
      });
      res.end('unauthorized');
      return;
    }
    if (isStream && stall) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': stalled\n\n');
      stalled.add(res);
      res.on('close', () => stalled.delete(res));
      return;
    }
    if (isStream) {
      const transport = new SSEServerTransport('/messages', res);
      transport.onclose = () => sessions.delete(transport.sessionId);
      const mcp = buildLegacyMcpServer(state, { serverName: 'legacy-sse-fixture', pageSize: opts.pageSize });
      sessions.set(transport.sessionId, { mcp, transport });
      await mcp.connect(transport); // start()가 SSE 헤더와 endpoint 이벤트를 쓴다
      return;
    }
    if (u.pathname === '/messages' && req.method === 'POST') {
      const sid = u.searchParams.get('sessionId');
      const s = sid ? sessions.get(sid) : undefined;
      if (!s) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no such session');
        return;
      }
      await s.transport.handlePostMessage(req, res, body);
      return;
    }
    if (u.pathname === '/sse') {
      res.writeHead(405, { allow: 'GET' });
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(e));
    });
  });
  const base = await listen(server);

  return {
    url: `${base}/sse`,
    requests,
    count: (rpcMethod) => requests.filter((r) => (rpcMethod === undefined ? true : r.rpcMethod === rpcMethod)).length,
    setUnauthorized(www, status = 401, where = 'all') {
      unauthorized = www === null && status === 401 ? null : { www, status, streamOnly: where === 'stream' };
    },
    get unauthorizedHits() {
      return unauthorizedHits;
    },
    setStallStreams(on) {
      stall = on;
    },
    stalledStreams: () => stalled.size,
    async emitListChanged(kind) {
      for (const s of sessions.values()) {
        if (kind === 'tools') await s.mcp.server.sendToolListChanged();
        else if (kind === 'prompts') await s.mcp.server.sendPromptListChanged();
        else await s.mcp.server.sendResourceListChanged();
      }
    },
    async dropSessions() {
      const all = [...sessions.values()];
      sessions.clear();
      for (const s of all) await s.transport.close();
    },
    sessionIds: () => [...sessions.keys()],
    streamCount: () => requests.filter((r) => r.method === 'GET' && new URL(r.url, 'http://localhost').pathname === '/sse').length,
    get cancelledCalls() {
      return state.cancelledCalls;
    },
    async close() {
      for (const s of sessions.values()) {
        await s.transport.close().catch(() => undefined);
        await s.mcp.close().catch(() => undefined);
      }
      sessions.clear();
      for (const res of stalled) res.end();
      stalled.clear();
      await closeServer(server);
    },
  };
}
