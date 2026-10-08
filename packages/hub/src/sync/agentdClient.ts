/**
 * agentd 소켓 클라이언트 (12.2). 요청마다 새 연결을 열고 한 줄을 주고받는다.
 * 프로토콜은 @omnicode/shared 의 AgentdRequestSchema/AgentdResponse.
 */
import { createConnection } from 'node:net';
import { randomId, type Agent, type AgentdResponse, type AgentdStatus, type DesiredAgentConfig, type SyncResult } from '@omnicode/shared';
import { AgentdUnavailableError, type AgentdClient } from '../contracts.js';

export class AgentdRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentdRequestError';
  }
}

export interface AgentdClientOptions {
  timeoutMs?: number;
  maxLineBytes?: number;
}

export function createAgentdClient(socketPath: string, opts: AgentdClientOptions = {}): AgentdClient {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxLineBytes = opts.maxLineBytes ?? 1024 * 1024;

  function call<R>(payload: Record<string, unknown>): Promise<R> {
    const id = randomId(8);
    const line = JSON.stringify({ id, ...payload }) + '\n';
    return new Promise<R>((resolve, reject) => {
      let settled = false;
      let buf = '';
      const sock = createConnection(socketPath);
      const timer = setTimeout(() => finish(new AgentdUnavailableError(`agentd timeout after ${timeoutMs}ms`)), timeoutMs);
      const finish = (err: Error | null, value?: R) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        if (err) reject(err);
        else resolve(value as R);
      };
      sock.setEncoding('utf8');
      sock.on('connect', () => sock.write(line));
      sock.on('error', (e: NodeJS.ErrnoException) => {
        const unavailable = ['ENOENT', 'ECONNREFUSED', 'EACCES', 'ETIMEDOUT', 'EPIPE'].includes(e.code ?? '');
        finish(unavailable ? new AgentdUnavailableError(`agentd unavailable (${e.code}): ${socketPath}`) : e);
      });
      sock.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.length > maxLineBytes) return finish(new AgentdRequestError('oversized_response', 'agentd response too large'));
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const text = buf.slice(0, nl);
        let res: AgentdResponse<R>;
        try {
          res = JSON.parse(text) as AgentdResponse<R>;
        } catch {
          return finish(new AgentdRequestError('bad_response', 'agentd sent invalid JSON'));
        }
        if (res.id !== id) return finish(new AgentdRequestError('bad_response', 'agentd response id mismatch'));
        if (res.ok) finish(null, res.result);
        else finish(new AgentdRequestError(res.error.code, res.error.message));
      });
      sock.on('close', () => finish(new AgentdUnavailableError('agentd closed the connection without a response')));
    });
  }

  return {
    syncPlan: (agent: Agent, desired: DesiredAgentConfig) => call<SyncResult>({ op: 'sync.plan', agent, desired }),
    syncApply: (agent: Agent, desired: DesiredAgentConfig) => call<SyncResult>({ op: 'sync.apply', agent, desired }),
    writeToken: async (agent: Agent, token: string) => {
      await call<{ path: string }>({ op: 'tokens.write', agent, token });
    },
    status: () => call<AgentdStatus>({ op: 'status' }),
  };
}
