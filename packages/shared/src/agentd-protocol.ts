import { z } from 'zod';
import { AgentSchema, AgentTokenSchema, DesiredAgentConfigSchema } from './schemas.js';
import type { Agent, SyncResult } from './types.js';

/** agentd 소켓 프로토콜 (12.2) — 줄 단위 JSON. */
export const AgentdRequestSchema = z.discriminatedUnion('op', [
  z.object({ id: z.string().min(1).max(64), op: z.literal('sync.plan'), agent: AgentSchema, desired: DesiredAgentConfigSchema }),
  z.object({ id: z.string().min(1).max(64), op: z.literal('sync.apply'), agent: AgentSchema, desired: DesiredAgentConfigSchema }),
  z.object({ id: z.string().min(1).max(64), op: z.literal('tokens.write'), agent: AgentSchema, token: AgentTokenSchema }),
  z.object({ id: z.string().min(1).max(64), op: z.literal('status') }),
]);
export type AgentdRequest = z.infer<typeof AgentdRequestSchema>;

export interface AgentdCliVersions {
  claude: string | null;
  codex: string | null;
  gemini: string | null;
}
export interface AgentdStatus {
  version: string;
  home: string;
  cli: AgentdCliVersions;
  lastSync: Record<Agent, { at: string; ok: boolean; error?: string } | null>;
}
export interface TokensWriteResult {
  path: string;
}

export type AgentdResultFor<Op extends AgentdRequest['op']> = Op extends 'sync.plan' | 'sync.apply'
  ? SyncResult
  : Op extends 'tokens.write'
    ? TokensWriteResult
    : AgentdStatus;

export interface AgentdOk<R = unknown> {
  id: string;
  ok: true;
  result: R;
}
export interface AgentdErr {
  id: string;
  ok: false;
  error: { code: string; message: string };
}
export type AgentdResponse<R = unknown> = AgentdOk<R> | AgentdErr;
