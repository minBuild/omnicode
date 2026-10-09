import { z } from 'zod';
import { AGENT_TOKEN_RE, SERVER_ID_RE } from './constants.js';

const httpsUrl = (allowHttpLoopback = false) =>
  z.string().refine(
    (s) => {
      try {
        const u = new URL(s);
        if (u.protocol === 'https:') return true;
        return allowHttpLoopback && u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
      } catch {
        return false;
      }
    },
    { message: 'https URL이어야 합니다' },
  );

export const AgentSchema = z.enum(['claude', 'codex', 'gemini']);
export const ServerIdSchema = z.string().regex(SERVER_ID_RE, 'id는 [a-z0-9-]{1,40} 이어야 합니다');
export const AgentTokenSchema = z.string().regex(AGENT_TOKEN_RE);
export const BindingsPatchSchema = z.object({
  claude: z.boolean().optional(),
  codex: z.boolean().optional(),
  gemini: z.boolean().optional(),
});

export const CreateServerBodySchema = z
  .object({
    source: z.enum(['url', 'preset', 'json']),
    url: z.string().max(2048).optional(),
    presetId: z.string().max(80).optional(),
    json: z.string().max(64 * 1024).optional(),
    /** json 에 서버가 여러 개일 때 추가할 항목 이름 (C2) */
    entry: z.string().min(1).max(100).optional(),
    id: ServerIdSchema.optional(),
    displayName: z.string().min(1).max(80).optional(),
  })
  .refine((b) => b.source !== 'url' || !!b.url, { message: 'url이 필요합니다', path: ['url'] })
  .refine((b) => b.source !== 'preset' || !!b.presetId, { message: 'presetId가 필요합니다', path: ['presetId'] })
  .refine((b) => b.source !== 'json' || !!b.json, { message: 'json이 필요합니다', path: ['json'] });
export type CreateServerBody = z.infer<typeof CreateServerBodySchema>;

export const PatchServerBodySchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  bindings: BindingsPatchSchema.optional(),
  tools: z.array(z.object({ name: z.string().min(1).max(256), enabled: z.boolean() })).max(500).optional(),
  callTimeoutMs: z.number().int().min(5_000).max(3_600_000).optional(),
  cliAutoApprove: z.boolean().optional(),
});
export type PatchServerBody = z.infer<typeof PatchServerBodySchema>;

export const ApproveBodySchema = z.object({
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(256),
        schemaHash: z.string().regex(/^[0-9a-f]{64}$/),
        enabled: z.boolean().optional(),
      }),
    )
    .max(500),
  bindings: BindingsPatchSchema.optional(),
});
export type ApproveBody = z.infer<typeof ApproveBodySchema>;

export const CredentialsBodySchema = z.object({
  headerName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  value: z.string().min(1).max(8192),
});
export type CredentialsBody = z.infer<typeof CredentialsBodySchema>;

export const OAuthClientBodySchema = z.object({
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(4096).optional(),
});
export type OAuthClientBody = z.infer<typeof OAuthClientBodySchema>;

export const RotateTokensBodySchema = z.object({
  agents: z.array(AgentSchema).min(1).max(3),
});

export const AuditQuerySchema = z.object({
  serverId: ServerIdSchema.optional(),
  agent: AgentSchema.optional(),
  outcome: z.enum(['ok', 'error', 'blocked']).optional(),
  since: z.string().datetime().optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

export const PresetSchema = z.object({
  id: ServerIdSchema,
  displayName: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  transport: z.enum(['streamable_http', 'sse']),
  url: httpsUrl(),
  auth: z.object({
    type: z.enum(['none', 'header', 'oauth']),
    headerName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
    scopes: z.array(z.string().min(1).max(100)).max(50).optional(),
  }),
  docs: httpsUrl().optional(),
  defaultAgents: z.array(AgentSchema).max(3).optional(),
});

export const ToolDefinitionSchema = z.object({
  name: z.string().min(1).max(256),
  title: z.string().max(256).optional(),
  description: z.string().max(20_000).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
});

export const DesiredEntrySchema = z.object({
  name: z.string().regex(/^omni-[a-z0-9-]{1,40}$/),
  serverId: ServerIdSchema,
  url: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{2,5}\/mcp\/[a-z0-9-]{1,40}$/),
  timeoutMs: z.number().int().min(5_000).max(3_600_000),
  autoApprove: z.boolean(),
});
export const DesiredAgentConfigSchema = z.object({
  entries: z.array(DesiredEntrySchema).max(200),
});

/** README의 mcpServers 블록 (Phase 2 입력). */
export const McpServersJsonSchema = z.object({
  mcpServers: z.record(
    z.string(),
    z.object({
      type: z.enum(['http', 'sse', 'stdio', 'streamable_http']).optional(),
      url: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
  ),
});
