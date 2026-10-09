/**
 * 가짜 2026-07-28("modern") 업스트림 — node:http 위에 손으로 쓴 서버.
 * 설계문서 18장: 무상태·MRTR·listen·필수 헤더. 필수 헤더가 틀리면 400 + -32020 HeaderMismatch.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { closeServer, flattenHeaders, listen, readRequestBody } from './upstream-legacy.js';

export interface ModernRecordedRequest {
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  rpcMethod: string | undefined;
  /** 받은 Mcp-Param-* 헤더 (소문자 키) */
  mcpParams: Record<string, string>;
}

export interface ModernFixtureOptions {
  /** tools/list 페이지 크기 (없으면 한 페이지) */
  pageSize?: number;
  /** listen 스트림 keepalive 주석 간격 (기본 100ms) */
  keepaliveMs?: number;
  supportedVersions?: string[];
  ttlMs?: number;
  serverName?: string;
}

export interface RejectRule {
  status: number;
  code: number;
  message: string;
  data?: unknown;
  /** true면 JSON-RPC 본문 없이 text/plain으로 거절 (5xx 장애 흉내) */
  plain?: boolean;
}

export interface ModernFixture {
  readonly url: string;
  readonly requests: ModernRecordedRequest[];
  count(rpcMethod?: string): number;
  /** null이면 해제. 설정 중에는 모든 요청에 status(기본 401) + WWW-Authenticate */
  setUnauthorized(wwwAuthenticate: string | null, status?: number): void;
  readonly unauthorizedHits: number;
  setSupportedVersions(versions: string[]): void;
  /** 다음 요청 1개를 이 JSON-RPC 오류로 거절한다 */
  rejectNextWith(rule: RejectRule | null): void;
  emitListChanged(kind: 'tools' | 'prompts' | 'resources'): void;
  /** resourceSubscriptions 에 uri 가 있는 listen 스트림에만 resources/updated (C3) */
  emitResourceUpdated(uri: string): void;
  /** 열린 리소스 구독 스트림들의 URI 목록 */
  resourceListenerUris(): string[][];
  listenerCount(): number;
  /** 열린 listen 스트림을 서버 쪽에서 끊는다 (응답 없이 종료) */
  dropListeners(): void;
  /** subscriptions/listen 요청의 params */
  readonly listenRequests: Array<Record<string, unknown>>;
  readonly cancelledCalls: number;
  /** ask 도구가 받은 { inputResponses, requestState } */
  readonly inputResponsesSeen: unknown[];
  /** 'log' 도구가 받은 _meta logLevel (없으면 undefined) */
  readonly logLevelsSeen: unknown[];
  close(): Promise<void>;
}

export const MODERN_TOOLS = [
  { name: 'echo', description: 'echoes text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  {
    name: 'slow',
    description: 'SSE response with progress',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' }, everyMs: { type: 'number' }, progress: { type: 'boolean' } } },
  },
  { name: 'resume', description: 'input_required without inputRequests', inputSchema: { type: 'object', properties: { steps: { type: 'number' } } } },
  { name: 'ask', description: 'input_required with inputRequests', inputSchema: { type: 'object', properties: {} } },
  { name: 'big', description: 'large result', inputSchema: { type: 'object', properties: { bytes: { type: 'number' }, stream: { type: 'boolean' } } } },
  { name: 'fail', description: 'always fails', inputSchema: { type: 'object', properties: {} } },
  { name: '한글 도구', description: 'non-ascii name', inputSchema: { type: 'object', properties: {} } },
];

const NAME_HEADER_PARAM: Record<string, 'name' | 'uri'> = { 'tools/call': 'name', 'resources/read': 'uri', 'prompts/get': 'name' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `=?base64?…?=` 센티널 디코딩 (구현과 독립적으로 다시 쓴다) */
export function decodeSentinel(value: string): string {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(value);
  return m ? Buffer.from(m[1] ?? '', 'base64').toString('utf8') : value;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string, data?: unknown): void {
  json(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

function sseStart(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders();
}

function sseEvent(res: ServerResponse, message: unknown): void {
  res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

export async function startModernFixture(opts: ModernFixtureOptions = {}): Promise<ModernFixture> {
  const requests: ModernRecordedRequest[] = [];
  const listenRequests: Array<Record<string, unknown>> = [];
  const inputResponsesSeen: unknown[] = [];
  const logLevelsSeen: unknown[] = [];
  /** 열린 listen 스트림과 그 필터 (스펙: 요청하지 않은 종류는 보내지 않는다) */
  const listeners = new Set<{ res: ServerResponse; keepalive: ReturnType<typeof setInterval>; id: unknown; filter: Record<string, unknown> }>();
  let supportedVersions = opts.supportedVersions ?? ['2026-07-28'];
  let unauthorized: { www: string | null; status: number } | null = null;
  let unauthorizedHits = 0;
  let rejectNext: RejectRule | null = null;
  let cancelledCalls = 0;
  const keepaliveMs = opts.keepaliveMs ?? 100;
  const ttlMs = opts.ttlMs ?? 60_000;
  const serverName = opts.serverName ?? 'modern-fixture';

  function complete(res: ServerResponse, id: unknown, result: Record<string, unknown>): void {
    json(res, 200, { jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } });
  }

  function slow(res: ServerResponse, id: unknown, args: Record<string, unknown>, meta: Record<string, unknown>): void {
    const ms = Number(args.ms ?? 1000);
    const every = Math.min(Math.max(10, Number(args.everyMs ?? 200)), ms);
    const progress = args.progress !== false;
    const token = meta.progressToken;
    sseStart(res);
    sseEvent(res, { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'starting' } });
    const started = Date.now();
    let i = 0;
    let finished = false;
    const timer = setInterval(() => {
      if (Date.now() - started >= ms) {
        finished = true;
        clearInterval(timer);
        sseEvent(res, { jsonrpc: '2.0', id, result: { resultType: 'complete', content: [{ type: 'text', text: 'done' }] } });
        res.end();
        return;
      }
      i++;
      if (progress && token !== undefined) {
        sseEvent(res, {
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken: token, progress: i, total: Math.ceil(ms / every), message: `tick ${i}` },
        });
      }
    }, every);
    res.on('close', () => {
      clearInterval(timer);
      if (!finished) cancelledCalls++;
    });
  }

  function callTool(res: ServerResponse, id: unknown, params: Record<string, unknown>, meta: Record<string, unknown>): void {
    const name = params.name;
    const args = isRecord(params.arguments) ? params.arguments : {};
    switch (name) {
      case 'echo':
        complete(res, id, { content: [{ type: 'text', text: `echo:${String(args.text ?? '')}` }] });
        return;
      case '한글 도구':
        complete(res, id, { content: [{ type: 'text', text: 'ok' }] });
        return;
      case 'fail':
        complete(res, id, { isError: true, content: [{ type: 'text', text: 'boom' }] });
        return;
      case 'slow':
        slow(res, id, args, meta);
        return;
      case 'resume': {
        const steps = Number(args.steps ?? 1);
        const seen = typeof params.requestState === 'string' ? Number(params.requestState.replace('step-', '')) : 0;
        if (seen >= steps) complete(res, id, { content: [{ type: 'text', text: `resumed after ${seen}` }] });
        else json(res, 200, { jsonrpc: '2.0', id, result: { resultType: 'input_required', requestState: `step-${seen + 1}` } });
        return;
      }
      case 'ask': {
        if (params.inputResponses !== undefined) {
          inputResponsesSeen.push({ inputResponses: params.inputResponses, requestState: params.requestState });
          complete(res, id, { content: [{ type: 'text', text: 'answered' }] });
          return;
        }
        json(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'input_required',
            requestState: 'ask-1',
            inputRequests: [
              { id: 'q1', type: 'elicitation', message: 'Your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } },
            ],
          },
        });
        return;
      }
      case 'log': {
        // 2026-07-28: 요청 _meta 에 logLevel 이 있을 때만 그 수준 이상의 로그를 보낸다 (D1)
        const level = meta['io.modelcontextprotocol/logLevel'];
        logLevelsSeen.push(level);
        const order = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
        const messages = Array.isArray(args.messages) ? (args.messages as Array<{ level: string; data: unknown }>) : [];
        sseStart(res);
        if (typeof level === 'string') {
          for (const m of messages) {
            if (order.indexOf(m.level) >= order.indexOf(level)) {
              sseEvent(res, { jsonrpc: '2.0', method: 'notifications/message', params: { level: m.level, logger: 'fixture', data: m.data } });
            }
          }
        }
        sseEvent(res, { jsonrpc: '2.0', id, result: { resultType: 'complete', content: [{ type: 'text', text: `logged` }] } });
        res.end();
        return;
      }
      case 'big': {
        const text = 'x'.repeat(Number(args.bytes ?? 1024));
        const result = { resultType: 'complete', content: [{ type: 'text', text }] };
        if (args.stream) {
          sseStart(res);
          sseEvent(res, { jsonrpc: '2.0', id, result });
          res.end();
        } else {
          json(res, 200, { jsonrpc: '2.0', id, result });
        }
        return;
      }
      default:
        rpcError(res, 200, id, -32602, `Unknown tool: ${String(name)}`);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end();
      return;
    }
    const raw = await readRequestBody(req);
    let body: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) body = parsed;
    } catch {
      body = undefined;
    }
    const headers = flattenHeaders(req);
    const mcpParams = Object.fromEntries(Object.entries(headers).filter(([k]) => k.startsWith('mcp-param-')));
    requests.push({ headers, body, rpcMethod: typeof body?.method === 'string' ? body.method : undefined, mcpParams });

    if (unauthorized) {
      unauthorizedHits++;
      res.writeHead(unauthorized.status, unauthorized.www ? { 'www-authenticate': unauthorized.www } : {});
      res.end();
      return;
    }
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      rpcError(res, 400, null, -32700, 'Parse error');
      return;
    }
    const id = typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null;
    const method = body.method;
    const params = isRecord(body.params) ? body.params : {};
    const meta = isRecord(params._meta) ? params._meta : {};

    if (rejectNext) {
      const rule = rejectNext;
      rejectNext = null;
      if (rule.plain) {
        res.writeHead(rule.status, { 'content-type': 'text/plain' });
        res.end(rule.message);
        return;
      }
      rpcError(res, rule.status, id, rule.code, rule.message, rule.data);
      return;
    }

    // 필수 헤더 검사 (11.1 표, 11.6)
    const version = headers['mcp-protocol-version'];
    if (!version || !supportedVersions.includes(version)) {
      rpcError(res, 400, id, -32600, `Unsupported protocol version: ${version ?? '(none)'}`, { supported: supportedVersions });
      return;
    }
    if (headers['mcp-method'] !== method) {
      rpcError(res, 400, id, -32020, 'Mcp-Method header does not match the request body', {
        header: 'Mcp-Method',
        expected: method,
        actual: headers['mcp-method'] ?? null,
      });
      return;
    }
    const nameParam = NAME_HEADER_PARAM[method];
    if (nameParam) {
      const expected = params[nameParam];
      const actual = headers['mcp-name'];
      if (typeof expected !== 'string' || actual === undefined || decodeSentinel(actual) !== expected) {
        rpcError(res, 400, id, -32020, 'Mcp-Name header does not match the request body', { header: 'Mcp-Name' });
        return;
      }
    }
    if (meta['io.modelcontextprotocol/protocolVersion'] !== version) {
      rpcError(res, 400, id, -32020, '_meta protocolVersion does not match the MCP-Protocol-Version header', { header: 'MCP-Protocol-Version' });
      return;
    }
    if (!isRecord(meta['io.modelcontextprotocol/clientInfo']) || !isRecord(meta['io.modelcontextprotocol/clientCapabilities'])) {
      rpcError(res, 400, id, -32602, '_meta must include clientInfo and clientCapabilities');
      return;
    }

    switch (method) {
      case 'server/discover':
        complete(res, id, {
          serverInfo: { name: serverName, version: '1.0.0' },
          capabilities: { tools: { listChanged: true }, prompts: { listChanged: true }, resources: { listChanged: true } },
          protocolVersions: supportedVersions,
          instructions: 'modern fixture',
        });
        return;
      case 'tools/list': {
        const start = typeof params.cursor === 'string' ? Number(params.cursor) : 0;
        const size = opts.pageSize ?? MODERN_TOOLS.length;
        const next = start + size;
        complete(res, id, {
          tools: MODERN_TOOLS.slice(start, next),
          ...(next < MODERN_TOOLS.length ? { nextCursor: String(next) } : {}),
          ttlMs,
          cacheScope: 'private',
        });
        return;
      }
      case 'tools/call':
        callTool(res, id, params, meta);
        return;
      case 'resources/read':
        complete(res, id, { contents: [{ uri: params.uri, text: `content of ${String(params.uri)}` }] });
        return;
      case 'resources/list':
        complete(res, id, { resources: [], ttlMs, cacheScope: 'private' });
        return;
      case 'prompts/get':
        complete(res, id, { messages: [{ role: 'user', content: { type: 'text', text: `prompt:${String(params.name)}` } }] });
        return;
      case 'prompts/list':
        complete(res, id, { prompts: [], ttlMs, cacheScope: 'private' });
        return;
      case 'subscriptions/listen': {
        listenRequests.push(params);
        const filter = isRecord(params.notifications) ? params.notifications : {};
        sseStart(res);
        // 2026-07-28: 첫 메시지는 받아들인 필터를 담은 acknowledged (subscriptionId = 요청 id)
        sseEvent(res, {
          jsonrpc: '2.0',
          method: 'notifications/subscriptions/acknowledged',
          params: { _meta: { 'io.modelcontextprotocol/subscriptionId': id }, notifications: filter },
        });
        const keepalive = setInterval(() => res.write(': keepalive\n\n'), keepaliveMs);
        const entry = { res, keepalive, id, filter };
        listeners.add(entry);
        res.on('close', () => {
          clearInterval(keepalive);
          listeners.delete(entry);
        });
        return;
      }
      default:
        rpcError(res, 200, id, -32601, 'Method not found');
    }
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
    setSupportedVersions(v) {
      supportedVersions = v;
    },
    rejectNextWith(rule) {
      rejectNext = rule;
    },
    emitListChanged(kind) {
      const key = `${kind}ListChanged`;
      for (const l of listeners) {
        if (l.filter[key] !== true) continue;
        sseEvent(l.res, { jsonrpc: '2.0', method: `notifications/${kind}/list_changed`, params: { _meta: { 'io.modelcontextprotocol/subscriptionId': l.id } } });
      }
    },
    emitResourceUpdated(uri) {
      for (const l of listeners) {
        const subs = l.filter.resourceSubscriptions;
        if (!Array.isArray(subs) || !subs.includes(uri)) continue;
        sseEvent(l.res, { jsonrpc: '2.0', method: 'notifications/resources/updated', params: { _meta: { 'io.modelcontextprotocol/subscriptionId': l.id }, uri } });
      }
    },
    resourceListenerUris: () => [...listeners].flatMap((l) => (Array.isArray(l.filter.resourceSubscriptions) ? [l.filter.resourceSubscriptions as string[]] : [])),
    listenerCount: () => listeners.size,
    dropListeners() {
      for (const l of listeners) {
        clearInterval(l.keepalive);
        l.res.end();
      }
      listeners.clear();
    },
    listenRequests,
    get cancelledCalls() {
      return cancelledCalls;
    },
    inputResponsesSeen,
    logLevelsSeen,
    async close() {
      for (const l of listeners) {
        clearInterval(l.keepalive);
        l.res.end();
      }
      listeners.clear();
      await closeServer(server);
    },
  };
}
