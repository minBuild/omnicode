/**
 * 11.8 상태별 tools/list · tools/call 정책. 순수 함수 — I/O 없음.
 * 다운스트림 서버는 요청마다 이 함수로 결정을 받는다.
 */
import { HubError, type Agent, type BindingRecord, type ServerRecord, type ToolRecord } from '@omnicode/shared';

export interface PolicyInput {
  server: ServerRecord;
  binding: BindingRecord | undefined;
  tools: ToolRecord[];
  agent: Agent;
}

/** 승인 해시가 현재 해시와 같고 켜져 있는 도구 */
export function approvedTools(tools: ToolRecord[]): ToolRecord[] {
  return tools.filter((t) => t.enabled === 1 && t.approved_hash !== null && t.approved_hash === t.schema_hash);
}

/** tools/list 에 노출할 도구 목록 (11.8 표) */
export function visibleTools(input: PolicyInput): ToolRecord[] {
  const { server, binding } = input;
  if (!binding || binding.enabled !== 1) return [];
  switch (server.status) {
    case 'active':
    case 'changed':
    case 'needs_auth':
    case 'error':
      return approvedTools(input.tools);
    case 'disabled':
    case 'pending_approval':
    case 'draft':
    case 'deleting':
      return [];
    default:
      return [];
  }
}

/**
 * tools/call 허용 여부. 허용되면 도구 레코드를, 아니면 HubError를 던진다.
 * `error` 상태는 호출자가 재연결을 1회 시도한 뒤 실패하면 upstream_unavailable 로 바꿔야 하므로
 * 여기서는 통과시킨다 (11.8: "재연결 1회 시도 후 실패하면 -32013").
 */
export function authorizeCall(input: PolicyInput, toolName: string): ToolRecord {
  const { server, binding, agent } = input;
  const label = server.display_name || server.id;
  if (server.status === 'deleting') throw new HubError('server_deleting');
  if (server.status === 'disabled') throw new HubError('server_disabled');
  if (!binding || binding.enabled !== 1) throw new HubError('binding_disabled', { agent });
  if (server.status === 'needs_auth') throw new HubError('upstream_auth_required', { server: label });
  if (server.status === 'pending_approval' || server.status === 'draft') {
    throw new HubError('tool_not_approved', { server: label });
  }
  const tool = input.tools.find((t) => t.name === toolName);
  if (!tool || tool.enabled !== 1 || tool.approved_hash === null || tool.approved_hash !== tool.schema_hash) {
    throw new HubError('tool_not_approved', { server: label });
  }
  return tool;
}

/** 서버 상태 요약 배지 (화면용). 순서는 중요도 순. */
export function statusBadges(server: ServerRecord, tools: ToolRecord[]): string[] {
  const badges: string[] = [];
  if (server.status === 'needs_auth' && server.requested_scope && server.granted_scope && server.requested_scope !== server.granted_scope) {
    badges.push('scope_upgrade');
  }
  const changed = tools.filter((t) => t.approved_hash !== null && t.approved_hash !== t.schema_hash).length;
  const pending = tools.filter((t) => t.approved_hash === null).length;
  if (changed > 0) badges.push('tools_changed');
  if (pending > 0 && server.status !== 'pending_approval') badges.push('new_tools');
  if (server.transport === 'sse') badges.push('deprecated_transport');
  return badges;
}
