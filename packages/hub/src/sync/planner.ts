/**
 * 12.2 동기화 플래너 — 레지스트리에서 에이전트별 "원하는 상태"를 계산한다. 순수 함수.
 * 포함: enabled 바인딩 + 서버 상태 active|changed|needs_auth|error|disabled
 * 제외: deleting|draft|pending_approval
 */
import { AGENTS, hubEntryName, hubServerUrl, type Agent, type BindingRecord, type DesiredAgentConfig, type ServerRecord, type ServerStatus } from '@omnicode/shared';

const INCLUDED: ReadonlySet<ServerStatus> = new Set(['active', 'changed', 'needs_auth', 'error', 'disabled']);

export function isDesiredStatus(status: ServerStatus): boolean {
  return INCLUDED.has(status);
}

export function desiredFor(agent: Agent, servers: ServerRecord[], bindings: BindingRecord[], hubPort: number): DesiredAgentConfig {
  const byId = new Map(servers.map((s) => [s.id, s]));
  const entries = bindings
    .filter((b) => b.agent === agent && b.enabled === 1)
    .map((b) => byId.get(b.server_id))
    .filter((s): s is ServerRecord => !!s && INCLUDED.has(s.status))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => ({
      name: hubEntryName(s.id),
      serverId: s.id,
      url: hubServerUrl(hubPort, s.id),
      timeoutMs: s.call_timeout_ms,
      autoApprove: s.cli_auto_approve === 1,
    }));
  return { entries };
}

export function desiredForAll(servers: ServerRecord[], bindings: BindingRecord[], hubPort: number): Record<Agent, DesiredAgentConfig> {
  const out = {} as Record<Agent, DesiredAgentConfig>;
  for (const agent of AGENTS) out[agent] = desiredFor(agent, servers, bindings, hubPort);
  return out;
}
