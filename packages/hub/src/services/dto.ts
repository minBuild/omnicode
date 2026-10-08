/** 레지스트리 레코드 → API DTO (14장). 비밀값은 어디에도 넣지 않는다. */
import type { Agent, BindingRecord, BindingsView, EventRecord, ServerDetail, ServerRecord, ServerSummary, ToolRecord, ToolView } from '@omnicode/shared';
import { AGENTS } from '@omnicode/shared';
import { statusBadges } from '../downstream/policy.js';

export function bindingsView(bindings: BindingRecord[]): BindingsView {
  const out = {} as BindingsView;
  for (const agent of AGENTS) {
    const b = bindings.find((x) => x.agent === agent);
    out[agent] = { enabled: !!b && b.enabled === 1, syncStatus: b?.sync_status ?? null, syncedAt: b?.synced_at ?? null, lastError: b?.last_error ?? null };
  }
  return out;
}

export function toolView(t: ToolRecord): ToolView {
  const def = JSON.parse(t.definition_json) as Record<string, unknown>;
  const approved = t.approved_definition_json ? (JSON.parse(t.approved_definition_json) as Record<string, unknown>) : null;
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    annotations: t.annotations_json ? (JSON.parse(t.annotations_json) as ToolView['annotations']) : null,
    enabled: t.enabled === 1,
    schemaHash: t.schema_hash,
    approvedHash: t.approved_hash,
    changed: t.approved_hash !== null && t.approved_hash !== t.schema_hash,
    pendingApproval: t.approved_hash === null,
    inputSchema: (def.inputSchema as Record<string, unknown>) ?? { type: 'object' },
    outputSchema: (def.outputSchema as Record<string, unknown> | undefined) ?? null,
    approvedDefinition: approved,
  };
}

export function serverSummary(rec: ServerRecord, tools: ToolRecord[], bindings: BindingRecord[]): ServerSummary {
  return {
    id: rec.id,
    displayName: rec.display_name,
    status: rec.status,
    transport: rec.transport,
    authType: rec.auth_type,
    toolCount: tools.length,
    approvedToolCount: tools.filter((t) => t.approved_hash !== null && t.approved_hash === t.schema_hash).length,
    changedToolCount: tools.filter((t) => t.approved_hash !== null && t.approved_hash !== t.schema_hash).length,
    bindings: bindingsView(bindings),
    lastError: rec.last_error,
    updatedAt: rec.updated_at,
    badges: statusBadges(rec, tools),
  };
}

export function serverDetail(
  rec: ServerRecord,
  tools: ToolRecord[],
  bindings: BindingRecord[],
  extra: { expiresAt: string | null; needsClientInput: boolean; recentEvents: EventRecord[]; warnings: string[] },
): ServerDetail {
  const parse = (s: string | null) => (s ? (JSON.parse(s) as Record<string, unknown>) : null);
  return {
    ...serverSummary(rec, tools, bindings),
    source: rec.source,
    presetId: rec.preset_id,
    url: rec.url,
    canonicalUrl: rec.canonical_url,
    protocol: { era: rec.protocol_era, version: rec.protocol_version },
    serverInfo: parse(rec.server_info_json),
    capabilities: parse(rec.capabilities_json),
    auth: {
      type: rec.auth_type,
      headerName: rec.header_name,
      issuer: rec.oauth_issuer,
      clientMode: rec.oauth_client_mode,
      requestedScope: rec.requested_scope,
      grantedScope: rec.granted_scope,
      expiresAt: extra.expiresAt,
      needsClientInput: extra.needsClientInput,
    },
    callTimeoutMs: rec.call_timeout_ms,
    cliAutoApprove: rec.cli_auto_approve === 1,
    tools: tools.map(toolView),
    lastProbeAt: rec.last_probe_at,
    toolsSyncedAt: rec.tools_synced_at,
    createdAt: rec.created_at,
    recentEvents: extra.recentEvents,
    warnings: extra.warnings,
  };
}

export function agentsFromBindings(b: Partial<Record<Agent, boolean>> | undefined, fallback: Agent[]): Agent[] {
  if (!b) return fallback;
  return AGENTS.filter((a) => b[a] === true);
}
