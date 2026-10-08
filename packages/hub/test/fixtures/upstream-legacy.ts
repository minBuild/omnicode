/**
 * 가짜 legacy 업스트림 — 진짜 SDK `McpServer` + `StreamableHTTPServerTransport`(세션 모드)를 node:http 임시 포트에 올린다.
 * 설계문서 18장: 세션·initialize·GET 스트림·서버 발신 요청.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListRootsResultSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  rpcMethod: string | undefined;
  sessionId: string | undefined;
}

export interface LegacyFixtureOptions {
  /** 요청 스트림에 로그를 보내는 'log' 도구와 logging capability 를 더한다 (D1 테스트) */
  withLogTool?: boolean;
  /** tools/list 페이지 크기 (없으면 한 페이지) */
  pageSize?: number;
  /** SSE 대신 JSON 응답 (progress 알림은 실리지 않는다) */
  enableJsonResponse?: boolean;
  serverName?: string;
}

export interface LegacyFixture {
  readonly url: string;
  readonly requests: RecordedRequest[];
  count(rpcMethod?: string): number;
  /** null이면 해제. 설정 중에는 모든 요청에 status(기본 401) + WWW-Authenticate */
  setUnauthorized(wwwAuthenticate: string | null, status?: number): void;
  readonly unauthorizedHits: number;
  emitListChanged(kind: 'tools' | 'prompts' | 'resources'): Promise<void>;
  /** 요청과 무관한 세션 스트림 로그 (withLogTool 일 때만) */
  emitSessionLog(level: 'info' | 'error', data: unknown): Promise<void>;
  /** 모든 세션을 버린다 → 옛 세션 ID로 오는 요청은 404 */
  dropSessions(): Promise<void>;
  sessionIds(): string[];
  /** 열린 GET(standalone SSE) 스트림 요청 수 */
  streamCount(): number;
  /** 서버 발신 요청(roots/list)을 첫 세션의 GET 스트림으로 보낸다. 클라이언트의 응답(오류 포함)을 돌려준다 */
  requestRoots(): Promise<unknown>;
  readonly cancelledCalls: number;
  close(): Promise<void>;
}

export const LEGACY_TOOL_DEFS: Tool[] = [
  { name: 'echo', description: 'echoes text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  {
    name: 'slow',
    description: 'takes ms milliseconds, emitting progress every everyMs',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'number' }, everyMs: { type: 'number' }, progress: { type: 'boolean' } },
      required: ['ms'],
    },
  },
  { name: 'fail', description: 'always fails', inputSchema: { type: 'object', properties: {} } },
];

export interface LegacyToolState {
  cancelledCalls: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 도구 3개를 가진 McpServer. upstream-legacy-sse 픽스처도 같이 쓴다. */
export function buildLegacyMcpServer(state: LegacyToolState, opts: { pageSize?: number; serverName?: string; withLogTool?: boolean } = {}): McpServer {
  const mcp = new McpServer(
    { name: opts.serverName ?? 'legacy-fixture', version: '1.0.0' },
    {
      capabilities: { prompts: { listChanged: true }, resources: { listChanged: true }, ...(opts.withLogTool ? { logging: {} } : {}) },
      instructions: 'legacy fixture',
    },
  );
  if (opts.withLogTool) {
    // 요청 스트림에 notifications/message 를 보낸다 (D1). gapMs 로 동시 호출이 섞이게 할 수 있다
    mcp.registerTool(
      'log',
      {
        description: 'emits log messages on the request stream',
        inputSchema: { messages: z.array(z.object({ level: z.string(), data: z.unknown() })), gapMs: z.number().optional() },
      },
      async ({ messages, gapMs }, extra) => {
        for (const m of messages) {
          await extra.sendNotification({
            method: 'notifications/message',
            params: { level: m.level as 'info', logger: 'fixture', data: m.data },
          });
          if (gapMs) await sleep(gapMs);
        }
        return { content: [{ type: 'text', text: `logged ${messages.length}` }] };
      },
    );
  }
  mcp.registerTool('echo', { description: 'echoes text', inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text: `echo:${text}` }],
  }));
  mcp.registerTool(
    'slow',
    {
      description: 'takes ms milliseconds, emitting progress every everyMs',
      inputSchema: { ms: z.number(), everyMs: z.number().optional(), progress: z.boolean().optional() },
    },
    async ({ ms, everyMs, progress }, extra) => {
      const token = extra._meta?.progressToken;
      const every = Math.max(10, everyMs ?? 200);
      const total = Math.ceil(ms / every);
      const started = Date.now();
      for (let i = 1; Date.now() - started < ms; i++) {
        await sleep(Math.min(every, Math.max(0, ms - (Date.now() - started))));
        if (extra.signal.aborted) {
          state.cancelledCalls++;
          return { content: [{ type: 'text', text: 'cancelled' }] };
        }
        if (progress !== false && token !== undefined) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken: token, progress: i, total, message: `tick ${i}` },
          });
        }
      }
      return { content: [{ type: 'text', text: 'done' }] };
    },
  );
  mcp.registerTool('fail', { description: 'always fails' }, async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }));
  if (opts.pageSize) {
    const pageSize = opts.pageSize;
    mcp.server.setRequestHandler(ListToolsRequestSchema, async (req) => {
      const start = req.params?.cursor ? Number(req.params.cursor) : 0;
      const next = start + pageSize;
      return { tools: LEGACY_TOOL_DEFS.slice(start, next), ...(next < LEGACY_TOOL_DEFS.length ? { nextCursor: String(next) } : {}) };
    });
  }
  return mcp;
}

export function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(', ');
  }
  return out;
}

export async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

export function rpcMethodOf(body: unknown): string | undefined {
  if (body && typeof body === 'object' && !Array.isArray(body) && typeof (body as { method?: unknown }).method === 'string') {
    return (body as { method: string }).method;
  }
  return undefined;
}

export function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

interface Session {
  mcp: McpServer;
  transport: StreamableHTTPServerTransport;
}

export async function startLegacyFixture(opts: LegacyFixtureOptions = {}): Promise<LegacyFixture> {
  const requests: RecordedRequest[] = [];
  const sessions = new Map<string, Session>();
  const state: LegacyToolState = { cancelledCalls: 0 };
  let unauthorized: { www: string | null; status: number } | null = null;
  let unauthorizedHits = 0;

  async function createSession(): Promise<Session> {
    const holder: { s?: Session } = {};
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: opts.enableJsonResponse ?? false,
      onsessioninitialized: (id) => {
        if (holder.s) sessions.set(id, holder.s);
      },
      keepAliveMs: 1_000,
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const mcp = buildLegacyMcpServer(state, opts);
    await mcp.connect(transport);
    holder.s = { mcp, transport };
    return holder.s;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readRequestBody(req);
    let body: unknown;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const headers = flattenHeaders(req);
    const sessionId = headers['mcp-session-id'];
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers, body, rpcMethod: rpcMethodOf(body), sessionId });

    if (unauthorized) {
      unauthorizedHits++;
      res.writeHead(unauthorized.status, {
        'content-type': 'text/plain',
        ...(unauthorized.www ? { 'www-authenticate': unauthorized.www } : {}),
      });
      res.end('unauthorized');
      return;
    }
    if (sessionId !== undefined) {
      const s = sessions.get(sessionId);
      if (!s) {
        writeJson(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        return;
      }
      await s.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method === 'POST' && rpcMethodOf(body) === 'initialize') {
      const s = await createSession();
      await s.transport.handleRequest(req, res, body);
      return;
    }
    writeJson(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' }, id: null });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(e));
    });
  });
  const url = await listen(server);

  return {
    url,
    requests,
    count: (rpcMethod) => requests.filter((r) => (rpcMethod === undefined ? true : r.rpcMethod === rpcMethod)).length,
    setUnauthorized(www, status = 401) {
      unauthorized = www === null && status === 401 ? null : { www, status };
    },
    get unauthorizedHits() {
      return unauthorizedHits;
    },
    async emitListChanged(kind) {
      for (const s of sessions.values()) {
        if (kind === 'tools') await s.mcp.server.sendToolListChanged();
        else if (kind === 'prompts') await s.mcp.server.sendPromptListChanged();
        else await s.mcp.server.sendResourceListChanged();
      }
    },
    async emitSessionLog(level, data) {
      for (const s of sessions.values()) await s.mcp.server.sendLoggingMessage({ level, logger: 'session', data });
    },
    async dropSessions() {
      const all = [...sessions.values()];
      sessions.clear();
      for (const s of all) await s.transport.close();
    },
    sessionIds: () => [...sessions.keys()],
    streamCount: () => requests.filter((r) => r.method === 'GET' && (r.headers.accept ?? '').includes('text/event-stream')).length,
    async requestRoots() {
      const s = sessions.values().next().value;
      if (!s) throw new Error('no session');
      return s.mcp.server.request({ method: 'roots/list' }, ListRootsResultSchema, { timeout: 5_000 });
    },
    get cancelledCalls() {
      return state.cancelledCalls;
    },
    async close() {
      for (const s of sessions.values()) {
        await s.transport.close().catch(() => undefined);
        await s.mcp.close().catch(() => undefined);
      }
      sessions.clear();
      await closeServer(server);
    },
  };
}
