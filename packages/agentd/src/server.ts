/**
 * agentd 소켓 서버 (설계 12.2, 17.1).
 * `omniagent` 사용자로 실행되어 Unix 소켓에서 줄 단위 JSON 요청을 받는다. 인증은 소켓 권한뿐이다
 * (`omniagent:omnicode` 0660). 모든 입력은 zod 로 검증하고, 에이전트 홈 안의 허용된 파일만 건드린다.
 */
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { AgentdRequestSchema, type Agent, type AgentdRequest, type AgentdResponse } from '@omnicode/shared';
import { createAdapters, type Adapter } from './adapters/index.js';
import { DEFAULT_SOCKET_GROUP, MAX_LINE_BYTES } from './constants.js';
import { AgentdError, errorMessage, isAgentdError, type AgentdErrorCode } from './errors.js';
import { createExecFileRunner, type CommandRunner } from './runner.js';
import { StatusTracker } from './status.js';
import { writeToken } from './tokens.js';


export interface AgentdLogger {
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
}

export interface StartAgentdOptions {
  socketPath: string;
  home: string;
  version: string;
  runner?: CommandRunner;
  logger?: AgentdLogger;
  /** 소켓 파일의 그룹. 기본 `OMNICODE_AGENTD_GROUP` 또는 `omnicode`. null 이면 chown 생략 */
  group?: string | null;
  /** 어댑터 덮어쓰기 (테스트용) */
  adapters?: Partial<Record<Agent, Adapter>>;
}

export interface AgentdHandle {
  readonly socketPath: string;
  close(): Promise<void>;
}

/** JSON 한 줄씩 stdout 에 쓰는 기본 로거 (journald 용) */
export function createConsoleLogger(stream: { write(s: string): unknown } = process.stdout): AgentdLogger {
  const log = (level: string) => (obj: Record<string, unknown> | string, msg?: string): void => {
    const data = typeof obj === 'string' ? { msg: obj } : { ...obj, msg };
    stream.write(JSON.stringify({ level, time: new Date().toISOString(), ...data }) + '\n');
  };
  return { info: log('info'), warn: log('warn'), error: log('error') };
}

const silentLogger: AgentdLogger = { info() {}, warn() {}, error() {} };

export async function startAgentd(opts: StartAgentdOptions): Promise<AgentdHandle> {
  const logger = opts.logger ?? silentLogger;
  const runner = opts.runner ?? createExecFileRunner();
  const adapters: Record<Agent, Adapter> = { ...createAdapters({ home: opts.home, runner }), ...opts.adapters };
  const tracker = new StatusTracker({ version: opts.version, home: opts.home, runner });
  const group = opts.group === undefined ? process.env['OMNICODE_AGENTD_GROUP'] || DEFAULT_SOCKET_GROUP : opts.group;

  // 파일을 쓰는 작업은 한 번에 하나만 (연결이 여러 개여도)
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  }

  async function handle(req: AgentdRequest): Promise<unknown> {
    switch (req.op) {
      case 'status':
        return tracker.status();
      case 'sync.plan':
        return adapters[req.agent].plan(req.desired);
      case 'sync.apply':
        return serialized(async () => {
          try {
            const result = await adapters[req.agent].apply(req.desired);
            tracker.recordSync(req.agent, { ok: true });
            return result;
          } catch (e) {
            tracker.recordSync(req.agent, { ok: false, error: errorMessage(e) });
            throw e;
          }
        });
      case 'tokens.write':
        return serialized(() => writeToken(opts.home, req.agent, req.token));
    }
  }

  function errResponse(id: string, code: AgentdErrorCode, message: string): AgentdResponse {
    return { id, ok: false, error: { code, message } };
  }

  async function dispatch(line: string): Promise<AgentdResponse> {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return errResponse('', 'invalid_request', 'request is not valid JSON');
    }
    const rawId = (raw as { id?: unknown } | null)?.id;
    const id = typeof rawId === 'string' ? rawId.slice(0, 64) : '';
    const parsed = AgentdRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.length ? i.path.map(String).join('.') : '<root>'}: ${i.message}`)
        .join('; ');
      return errResponse(id, 'invalid_request', detail);
    }
    const req = parsed.data;
    try {
      const result = await handle(req);
      return { id: req.id, ok: true, result };
    } catch (e) {
      const code = isAgentdError(e) ? e.code : 'internal';
      logger.error({ op: req.op, code, err: errorMessage(e) }, 'request failed');
      return errResponse(req.id, code, errorMessage(e));
    }
  }

  const sockets = new Set<net.Socket>();

  function onConnection(socket: net.Socket): void {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', (e) => logger.warn({ err: e.message }, 'socket error'));

    let buf: Buffer = Buffer.alloc(0);
    let queue: Promise<unknown> = Promise.resolve();
    let rejected = false;

    const send = (resp: AgentdResponse): void => {
      if (!socket.destroyed) socket.write(JSON.stringify(resp) + '\n');
    };
    const rejectOversized = (): void => {
      rejected = true;
      buf = Buffer.alloc(0);
      // 앞선 응답을 보낸 뒤 오류를 쓰고 끊는다. 남은 입력은 읽어서 버린다 (상대가 보내던 것을 비울 수 있게).
      queue = queue.then(() => {
        if (socket.destroyed) return;
        socket.end(JSON.stringify(errResponse('', 'invalid_request', `line exceeds ${MAX_LINE_BYTES} bytes`)) + '\n');
      });
    };

    socket.on('data', (chunk: Buffer) => {
      if (rejected) return;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      let nl: number;
      while ((nl = buf.indexOf(0x0a)) !== -1) {
        const lineBuf = buf.subarray(0, nl);
        buf = buf.subarray(nl + 1);
        if (lineBuf.length > MAX_LINE_BYTES) {
          rejectOversized();
          return;
        }
        const line = lineBuf.toString('utf8').replace(/\r$/, '');
        if (line.trim() === '') continue;
        // 한 연결의 요청은 순서대로 처리한다
        queue = queue.then(() => dispatch(line)).then(send);
      }
      if (buf.length > MAX_LINE_BYTES) rejectOversized();
    });
  }

  await removeStaleSocket(opts.socketPath, logger);
  await fs.mkdir(path.dirname(opts.socketPath), { recursive: true, mode: 0o750 }).catch(() => undefined);

  const server = net.createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path: opts.socketPath }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (e) => logger.error({ err: e.message }, 'server error'));
  await applySocketPermissions(opts.socketPath, group, logger);
  logger.info({ socketPath: opts.socketPath, home: opts.home, version: opts.version }, 'agentd listening');

  let closed = false;
  return {
    socketPath: opts.socketPath,
    async close() {
      if (closed) return;
      closed = true;
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(opts.socketPath, { force: true }).catch(() => undefined);
    },
  };
}

/** 이전 인스턴스가 남긴 소켓 파일을 치운다. 누가 듣고 있으면 시작하지 않는다. */
async function removeStaleSocket(socketPath: string, logger: AgentdLogger): Promise<void> {
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    st = await fs.lstat(socketPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (!st.isSocket()) throw new AgentdError('internal', `${socketPath} exists and is not a socket`);
  const alive = await new Promise<boolean>((resolve) => {
    const c = net.connect(socketPath);
    c.once('connect', () => {
      c.destroy();
      resolve(true);
    });
    c.once('error', () => resolve(false));
  });
  if (alive) throw new AgentdError('internal', `another agentd is already listening on ${socketPath}`);
  await fs.rm(socketPath, { force: true });
  logger.warn({ socketPath }, 'removed stale socket');
}

/** 0660 + chgrp (17.1). 그룹을 찾을 수 없거나(macOS·테스트) 권한이 없으면 조용히 넘어간다. */
async function applySocketPermissions(socketPath: string, group: string | null, logger: AgentdLogger): Promise<void> {
  await fs.chmod(socketPath, 0o660);
  if (group === null || group === '') return;
  const gid = await lookupGid(group);
  if (gid === undefined) return;
  try {
    const st = await fs.stat(socketPath);
    if (st.gid !== gid) await fs.chown(socketPath, st.uid, gid);
  } catch (e) {
    logger.warn({ group, gid, err: errorMessage(e) }, 'could not chgrp socket');
  }
}

/** `/etc/group` 을 읽어 그룹 이름 → gid. 숫자면 그대로. */
export async function lookupGid(group: string): Promise<number | undefined> {
  if (/^\d+$/.test(group)) return Number(group);
  let text: string;
  try {
    text = await fs.readFile('/etc/group', 'utf8');
  } catch {
    return undefined;
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const [name, , gid] = line.split(':');
    if (name === group && gid !== undefined && /^\d+$/.test(gid)) return Number(gid);
  }
  return undefined;
}
