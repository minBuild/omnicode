import { describe, expect, it } from 'vitest';
import { CreateServerBodySchema, DesiredEntrySchema, PresetSchema } from '../src/schemas.js';
import { AgentdRequestSchema } from '../src/agentd-protocol.js';
import { HUB_ERRORS, hubError } from '../src/errors.js';
import { generateAgentToken } from '../src/util.js';
import { AGENT_TOKEN_RE } from '../src/constants.js';

describe('schemas', () => {
  it('requires url for source=url', () => {
    expect(CreateServerBodySchema.safeParse({ source: 'url' }).success).toBe(false);
    expect(CreateServerBodySchema.safeParse({ source: 'url', url: 'https://x.example/mcp' }).success).toBe(true);
  });
  it('rejects non-https preset urls', () => {
    const p = { id: 'a', displayName: 'A', transport: 'streamable_http', url: 'http://a.example/mcp', auth: { type: 'none' } };
    expect(PresetSchema.safeParse(p).success).toBe(false);
    expect(PresetSchema.safeParse({ ...p, url: 'https://a.example/mcp' }).success).toBe(true);
  });
  it('desired entry must point to loopback hub', () => {
    expect(DesiredEntrySchema.safeParse({ name: 'omni-a', serverId: 'a', url: 'http://10.0.0.1:7410/mcp/a', timeoutMs: 60000, autoApprove: true }).success).toBe(false);
    expect(DesiredEntrySchema.safeParse({ name: 'omni-a', serverId: 'a', url: 'http://127.0.0.1:7410/mcp/a', timeoutMs: 60000, autoApprove: true }).success).toBe(true);
  });
  it('agentd request union', () => {
    expect(AgentdRequestSchema.safeParse({ id: '1', op: 'status' }).success).toBe(true);
    expect(AgentdRequestSchema.safeParse({ id: '1', op: 'tokens.write', agent: 'claude', token: 'bad' }).success).toBe(false);
    expect(AgentdRequestSchema.safeParse({ id: '1', op: 'tokens.write', agent: 'claude', token: generateAgentToken() }).success).toBe(true);
  });
});

describe('errors', () => {
  it('fills templates and keeps codes in the implementation-defined range', () => {
    const e = hubError('upstream_auth_required', { server: 'Fish Audio' });
    expect(e.code).toBe(-32012);
    expect(e.message).toContain('Fish Audio');
    expect(e.data?.action).toBe('relogin');
    for (const [name, def] of Object.entries(HUB_ERRORS)) {
      if (name === 'header_mismatch') continue;
      expect(def.code).toBeGreaterThanOrEqual(-32019);
      expect(def.code).toBeLessThanOrEqual(-32010);
    }
  });
  it('agent tokens match the regex', () => {
    expect(AGENT_TOKEN_RE.test(generateAgentToken())).toBe(true);
  });
});
