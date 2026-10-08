/**
 * 가짜 HTTP+SSE(2024-11-05) 업스트림 — SDK `SSEServerTransport`. 11.1 (3) 폴백 검증용.
 * GET /sse → endpoint 이벤트, POST /messages?sessionId=… → 메시지, POST /sse → 405.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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

export interface LegacySseFixture {
  /** 커넥터에 넘길 URL (…/sse) */
  readonly url: string;
  readonly requests: RecordedRequest[];
  count(rpcMethod?: string): number;
  close(): Promise<void>;
}

export async function startLegacySseFixture(): Promise<LegacySseFixture> {
  const requests: RecordedRequest[] = [];
  const sessions = new Map<string, SSEServerTransport>();
  const state: LegacyToolState = { cancelledCalls: 0 };

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
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: flattenHeaders(req), body, rpcMethod: rpcMethodOf(body), sessionId: undefined });

    if (u.pathname === '/sse' && req.method === 'GET') {
      const transport = new SSEServerTransport('/messages', res);
      transport.onclose = () => sessions.delete(transport.sessionId);
      sessions.set(transport.sessionId, transport);
      const mcp = buildLegacyMcpServer(state, { serverName: 'legacy-sse-fixture' });
      await mcp.connect(transport); // start()가 SSE 헤더와 endpoint 이벤트를 쓴다
      return;
    }
    if (u.pathname === '/messages' && req.method === 'POST') {
      const sid = u.searchParams.get('sessionId');
      const transport = sid ? sessions.get(sid) : undefined;
      if (!transport) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no such session');
        return;
      }
      await transport.handlePostMessage(req, res, body);
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
    async close() {
      for (const t of sessions.values()) await t.close().catch(() => undefined);
      sessions.clear();
      await closeServer(server);
    },
  };
}
