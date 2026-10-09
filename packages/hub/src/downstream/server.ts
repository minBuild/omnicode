/**
 * 다운스트림 HTTP 서버 (에이전트 → Hub). 127.0.0.1 에만 바인딩한다.
 * 경로: GET /healthz, {POST,GET,DELETE} /mcp/<serverId>
 * 세션: legacy 클라이언트마다 SDK StreamableHTTPServerTransport + Server 한 쌍 (11.2)
 */
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { DEFAULTS, LEGACY_PROTOCOL_VERSIONS, LIMITS, SERVER_ID_RE, isModernProtocolVersion, type Agent } from '@omnicode/shared';
import type { DownstreamDeps } from './deps.js';
import { createLimiter, type Limiter } from './limiter.js';
import { createSessionServer, mirrorCapabilities } from './session.js';

interface SessionEntry {
  id: string | null;
  agent: Agent;
  serverId: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastSeen: number;
  /** 이 세션이 구독한 리소스 URI (C3) */
  uris: Set<string>;
}

export interface DownstreamServer {
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  notifyListChanged(serverId: string, kind: 'tools' | 'prompts' | 'resources'): Promise<void>;
  /** 구독한 세션에만 notifications/resources/updated (C3) */
  notifyResourceUpdated(serverId: string, uri: string): Promise<void>;
  closeSessionsFor(serverId: string): Promise<void>;
  sessionCounts(): { legacy: number; modern: number };
  readonly port: number | null;
}

export interface DownstreamOptions {
  limiter?: Limiter;
  port?: number; // 테스트용 (0 = 임의 포트)
  idleSweepMs?: number;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { ...JSON_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, code: number, message: string, data?: unknown, headers: Record<string, string> = {}) {
  sendJson(res, status, { jsonrpc: '2.0', id: null, error: { code, message, ...(data !== undefined ? { data } : {}) } }, headers);
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks).toString('utf8') : null));
    req.on('error', reject);
  });
}

function isInitialize(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => m && typeof m === 'object' && (m as { method?: unknown }).method === 'initialize');
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function createDownstreamServer(deps: DownstreamDeps, opts: DownstreamOptions = {}): DownstreamServer {
  const limiter = opts.limiter ?? createLimiter();
  const sessions = new Map<string, SessionEntry>();
  const now = deps.now ?? (() => new Date());
  const startedAt = now().getTime();
  let http: HttpServer | null = null;
  let port: number | null = null;
  let sweep: NodeJS.Timeout | undefined;

  const allowedHostPorts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);

  async function createSession(agent: Agent, serverId: string): Promise<SessionEntry> {
    const rec = deps.registry.servers.get(serverId);
    // 연결 가능한 상태면 미리 연결해 capabilities 를 미러링한다 (실패해도 세션은 만든다)
    let caps = mirrorCapabilities(deps.connectors.peek(serverId)?.capabilities);
    if (rec && ['active', 'changed', 'error'].includes(rec.status) && !deps.connectors.peek(serverId)) {
      const warm = await Promise.race([
        deps.connectors.get(serverId).then((c) => c.capabilities, () => undefined),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 5_000)),
      ]);
      if (warm !== undefined) caps = mirrorCapabilities(warm);
    }
    const entry: SessionEntry = {
      id: null,
      agent,
      serverId,
      server: null as unknown as McpServer,
      transport: null as unknown as StreamableHTTPServerTransport,
      createdAt: now().getTime(),
      lastSeen: now().getTime(),
      uris: new Set(),
    };
    entry.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      keepAliveMs: 15_000,
      onsessioninitialized: (sid) => {
        entry.id = sid;
        sessions.set(sid, entry);
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
        void releaseSubscriptions(entry);
      },
    });
    const subs = {
      add: async (uri: string) => {
        if (entry.uris.has(uri)) return;
        await deps.connectors.subscribe(serverId, uri);
        entry.uris.add(uri);
      },
      remove: async (uri: string) => {
        if (!entry.uris.delete(uri)) return;
        await deps.connectors.unsubscribe(serverId, uri);
      },
    };
    entry.server = createSessionServer(deps, { agent, serverId }, limiter, caps, subs);
    entry.transport.onclose = () => {
      if (entry.id) sessions.delete(entry.id);
      void releaseSubscriptions(entry);
    };
    await entry.server.connect(entry.transport);
    return entry;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, version: deps.config.version, uptimeSec: Math.round((now().getTime() - startedAt) / 1000), sessions: sessions.size });
    }
    const m = /^\/mcp\/([^/]+)$/.exec(url.pathname);
    if (!m || !SERVER_ID_RE.test(m[1] ?? '')) return sendJson(res, 404, { error: 'not_found' });
    const serverId = m[1] as string;

    // DNS rebinding 방어: Host / Origin (11.6)
    const host = first(req.headers.host);
    if (!host || !allowedHostPorts().has(host)) return sendJson(res, 403, { error: 'invalid_host' });
    const origin = first(req.headers.origin);
    if (origin !== undefined && !allowedOrigins().has(origin)) return sendJson(res, 403, { error: 'invalid_origin' });

    // 에이전트 토큰 (10.5)
    const authz = first(req.headers.authorization) ?? '';
    const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
    const agent = token ? deps.tokens.authenticate(token) : null;
    if (!agent) {
      return sendJson(res, 401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer realm="omnicode-hub", error="invalid_token"' });
    }

    if (!deps.registry.servers.get(serverId)) return sendJson(res, 404, { error: 'unknown_server' });

    // modern 다운스트림은 MVP 미지원 (D17): 지원 버전 목록과 함께 거절한다
    const requested = first(req.headers['mcp-protocol-version']);
    if (isModernProtocolVersion(requested)) {
      return rpcError(res, 400, -32022, 'Unsupported protocol version', { requested, supported: [...LEGACY_PROTOCOL_VERSIONS] });
    }

    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      res.writeHead(405, { allow: 'GET, POST, DELETE' });
      res.end();
      return;
    }

    let parsed: unknown = undefined;
    if (req.method === 'POST') {
      let raw: string | null;
      try {
        raw = await readBody(req, LIMITS.downstreamBodyBytes);
      } catch {
        return sendJson(res, 413, { error: 'body_too_large' });
      }
      try {
        parsed = raw ? JSON.parse(raw) : undefined;
      } catch {
        return rpcError(res, 400, -32700, 'Parse error');
      }
    }

    const sid = first(req.headers['mcp-session-id']);
    let entry: SessionEntry | undefined;
    if (sid) {
      entry = sessions.get(sid);
      if (!entry || entry.serverId !== serverId || entry.agent !== agent) {
        return rpcError(res, 404, -32001, 'Session not found');
      }
    } else if (req.method === 'POST' && isInitialize(parsed)) {
      entry = await createSession(agent, serverId);
    } else {
      return rpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
    }
    entry.lastSeen = now().getTime();
    await entry.transport.handleRequest(req, res, parsed);
  }

  /** 세션이 끝나면 그 세션의 구독을 모두 푼다 (참조 수가 0 이 되면 업스트림 구독도 끊긴다) */
  async function releaseSubscriptions(e: SessionEntry) {
    const uris = [...e.uris];
    e.uris.clear();
    for (const uri of uris) await deps.connectors.unsubscribe(e.serverId, uri).catch(() => undefined);
  }

  async function closeEntry(e: SessionEntry) {
    if (e.id) sessions.delete(e.id);
    await releaseSubscriptions(e);
    try {
      await e.transport.close();
    } catch {
      /* ignore */
    }
  }

  return {
    get port() {
      return port;
    },
    async start() {
      http = createHttpServer((req, res) => {
        handle(req, res).catch((err: unknown) => {
          deps.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'downstream request failed');
          if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
          else res.end();
        });
      });
      http.keepAliveTimeout = 65_000;
      await new Promise<void>((resolve, reject) => {
        http!.once('error', reject);
        http!.listen(opts.port ?? deps.config.hubPort, deps.config.hubHost, () => resolve());
      });
      const addr = http.address();
      port = typeof addr === 'object' && addr ? addr.port : deps.config.hubPort;
      sweep = setInterval(() => {
        const cutoff = now().getTime() - DEFAULTS.downstreamSessionIdleMs;
        for (const e of [...sessions.values()]) if (e.lastSeen < cutoff) void closeEntry(e);
      }, opts.idleSweepMs ?? 600_000);
      sweep.unref();
      deps.logger.info({ host: deps.config.hubHost, port }, 'hub downstream listening');
      return { port };
    },
    async stop() {
      if (sweep) clearInterval(sweep);
      for (const e of [...sessions.values()]) await closeEntry(e);
      sessions.clear();
      if (http) {
        await new Promise<void>((resolve) => http!.close(() => resolve()));
        http.closeAllConnections?.();
        http = null;
      }
    },
    async notifyListChanged(serverId, kind) {
      for (const e of [...sessions.values()]) {
        if (e.serverId !== serverId) continue;
        const binding = deps.registry.bindings.get(serverId, e.agent);
        if (!binding || binding.enabled !== 1) continue;
        try {
          if (kind === 'tools') await e.server.sendToolListChanged();
          else if (kind === 'prompts') await e.server.sendPromptListChanged();
          else await e.server.sendResourceListChanged();
        } catch (err) {
          deps.logger.debug({ serverId, err: String(err) }, 'list_changed notify failed');
        }
      }
    },
    async notifyResourceUpdated(serverId, uri) {
      for (const e of [...sessions.values()]) {
        if (e.serverId !== serverId || !e.uris.has(uri)) continue;
        const binding = deps.registry.bindings.get(serverId, e.agent);
        if (!binding || binding.enabled !== 1) continue;
        try {
          await e.server.sendResourceUpdated({ uri });
        } catch (err) {
          deps.logger.debug({ serverId, err: String(err) }, 'resources/updated notify failed');
        }
      }
    },
    async closeSessionsFor(serverId) {
      for (const e of [...sessions.values()]) if (e.serverId === serverId) await closeEntry(e);
    },
    sessionCounts() {
      return { legacy: sessions.size, modern: 0 };
    },
  };
}
