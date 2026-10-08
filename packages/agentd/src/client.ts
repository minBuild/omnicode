/**
 * agentd 소켓 클라이언트 (Hub 쪽에서 쓴다, 설계 12.2).
 * 요청마다 연결을 새로 열고 응답 한 줄을 기다린다. 기본 제한 시간 60초.
 */
import net from 'node:net';
import { randomId, type Agent, type AgentdRequest, type AgentdResponse, type AgentdStatus, type DesiredAgentConfig, type SyncResult, type TokensWriteResult } from '@omnicode/shared';
import { DEFAULT_CLIENT_TIMEOUT_MS, MAX_LINE_BYTES } from './constants.js';

export interface AgentdClient {
  syncPlan(agent: Agent, desired: DesiredAgentConfig): Promise<SyncResult>;
  syncApply(agent: Agent, desired: DesiredAgentConfig): Promise<SyncResult>;
  writeToken(agent: Agent, token: string): Promise<void>;
  status(): Promise<AgentdStatus>;
}

export interface AgentdClientOptions {
  /** 기본 60초 */
  timeoutMs?: number;
}

/** agentd 가 `{ ok: false }` 를 돌려준 경우. `code` 는 invalid_request · adapter_error · cli_error · internal */
export class AgentdRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly op?: string,
  ) {
    super(message);
    this.name = 'AgentdRequestError';
  }
}

/** 소켓에 연결할 수 없거나 응답 전에 끊겼거나 제한 시간을 넘긴 경우. Hub 는 이것을 `agentd_unavailable` 로 감싼다. */
export class AgentdUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentdUnavailableError';
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RequestBody = DistributiveOmit<AgentdRequest, 'id'>;

export function createAgentdClient(socketPath: string, opts: AgentdClientOptions = {}): AgentdClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;

  function request<R>(body: RequestBody): Promise<R> {
    const id = randomId(12);
    const payload = JSON.stringify({ id, ...body }) + '\n';
    if (Buffer.byteLength(payload) > MAX_LINE_BYTES) {
      return Promise.reject(new AgentdRequestError('invalid_request', `request exceeds ${MAX_LINE_BYTES} bytes`, body.op));
    }
    return new Promise<R>((resolve, reject) => {
      const socket = net.connect(socketPath);
      let settled = false;
      let buf = '';
      const finish = (err: Error | undefined, value?: R): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value as R);
      };
      const timer = setTimeout(() => finish(new AgentdUnavailableError(`agentd ${body.op} timed out after ${timeoutMs}ms`)), timeoutMs);

      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write(payload));
      socket.on('error', (e) => finish(new AgentdUnavailableError(`agentd unavailable at ${socketPath}: ${e.message}`)));
      socket.on('close', () => finish(new AgentdUnavailableError(`agentd closed the connection before answering ${body.op}`)));
      socket.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim() === '') continue;
          let resp: AgentdResponse<R>;
          try {
            resp = JSON.parse(line) as AgentdResponse<R>;
          } catch {
            finish(new AgentdRequestError('internal', 'malformed response from agentd', body.op));
            return;
          }
          // id '' 는 agentd 가 요청의 id 를 읽지 못한 경우 (연결당 요청 하나이므로 우리 것)
          if (resp.id !== id && resp.id !== '') continue;
          if (resp.ok) finish(undefined, resp.result);
          else finish(new AgentdRequestError(resp.error?.code ?? 'internal', resp.error?.message ?? 'unknown error', body.op));
          return;
        }
      });
    });
  }

  return {
    syncPlan: (agent, desired) => request<SyncResult>({ op: 'sync.plan', agent, desired }),
    syncApply: (agent, desired) => request<SyncResult>({ op: 'sync.apply', agent, desired }),
    writeToken: async (agent, token) => {
      await request<TokensWriteResult>({ op: 'tokens.write', agent, token });
    },
    status: () => request<AgentdStatus>({ op: 'status' }),
  };
}
