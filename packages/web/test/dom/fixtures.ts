import type { BindingsView, ServerDetail, ToolView } from '@omnicode/shared';

export function tool(name: string, over: Partial<ToolView> = {}): ToolView {
  return {
    name,
    title: null,
    description: `${name} 도구`,
    annotations: null,
    enabled: true,
    schemaHash: `hash-${name}`,
    approvedHash: null,
    changed: false,
    pendingApproval: true,
    inputSchema: { type: 'object' },
    outputSchema: null,
    approvedDefinition: null,
    ...over,
  };
}

const bindings = (on: boolean): BindingsView => ({
  claude: { enabled: on, syncStatus: on ? 'synced' : null, syncedAt: null, lastError: null },
  codex: { enabled: on, syncStatus: on ? 'synced' : null, syncedAt: null, lastError: null },
  gemini: { enabled: false, syncStatus: null, syncedAt: null, lastError: null },
});

export function detail(over: Partial<ServerDetail> = {}): ServerDetail {
  const tools = over.tools ?? [tool('tts')];
  return {
    id: 'fish',
    displayName: 'Fish Audio',
    status: 'active',
    transport: 'streamable_http',
    authType: 'none',
    toolCount: tools.length,
    approvedToolCount: tools.filter((t) => t.approvedHash).length,
    changedToolCount: tools.filter((t) => t.changed).length,
    bindings: bindings(true),
    lastError: null,
    updatedAt: '2026-10-08T00:00:00.000Z',
    badges: [],
    source: 'url',
    presetId: null,
    url: 'https://api.fish.example/mcp',
    canonicalUrl: 'https://api.fish.example/mcp',
    protocol: { era: 'legacy', version: '2025-06-18' },
    serverInfo: { name: 'fish', version: '1.0.0' },
    capabilities: { tools: {} },
    auth: { type: 'none', headerName: null, issuer: null, clientMode: null, requestedScope: null, grantedScope: null, expiresAt: null, needsClientInput: false },
    callTimeoutMs: 600000,
    cliAutoApprove: true,
    tools,
    lastProbeAt: null,
    toolsSyncedAt: null,
    createdAt: '2026-10-08T00:00:00.000Z',
    recentEvents: [],
    warnings: [],
    ...over,
  };
}
