import { describe, expect, it } from 'vitest';
import type { BindingRecord, ServerRecord, ToolRecord } from '@omnicode/shared';
import { authorizeCall, statusBadges, visibleTools } from '../../src/downstream/policy.js';

const server = (status: ServerRecord['status']): ServerRecord =>
  ({
    id: 'fish', display_name: 'Fish Audio', source: 'url', preset_id: null, transport: 'streamable_http',
    url: 'https://x/mcp', canonical_url: null, command: null, args_json: null, env_keys_json: null,
    auth_type: 'oauth', header_name: null, secret_ref: null, oauth_issuer: null, oauth_client_mode: null,
    oauth_prm_url: null, requested_scope: null, granted_scope: null, protocol_era: 'legacy', protocol_version: '2025-06-18',
    server_info_json: null, capabilities_json: null, call_timeout_ms: 600000, cli_auto_approve: 1, status,
    last_error: null, last_probe_at: null, tools_synced_at: null, created_at: 't', updated_at: 't',
  }) as ServerRecord;
const tool = (name: string, approved: boolean, changed = false, enabled = 1): ToolRecord => ({
  server_id: 'fish', name, title: null, description: null, definition_json: '{}', schema_hash: changed ? 'h2' : 'h1',
  approved_hash: approved ? 'h1' : null, approved_definition_json: null, approved_at: null, annotations_json: null,
  enabled, first_seen_at: 't', last_seen_at: 't',
});
const binding = (enabled = 1): BindingRecord => ({ server_id: 'fish', agent: 'claude', enabled, sync_status: null, synced_at: null, last_error: null });
const tools = [tool('tts', true), tool('new', false), tool('changed', true, true), tool('off', true, false, 0)];

describe('visibleTools', () => {
  it('active/changed/needs_auth/error expose approved + unchanged + enabled tools only', () => {
    for (const st of ['active', 'changed', 'needs_auth', 'error'] as const) {
      expect(visibleTools({ server: server(st), binding: binding(), tools, agent: 'claude' }).map((t) => t.name)).toEqual(['tts']);
    }
  });
  it('disabled/pending/draft/deleting expose nothing', () => {
    for (const st of ['disabled', 'pending_approval', 'draft', 'deleting'] as const) {
      expect(visibleTools({ server: server(st), binding: binding(), tools, agent: 'claude' })).toEqual([]);
    }
  });
  it('binding off exposes nothing', () => {
    expect(visibleTools({ server: server('active'), binding: binding(0), tools, agent: 'claude' })).toEqual([]);
    expect(visibleTools({ server: server('active'), binding: undefined, tools, agent: 'claude' })).toEqual([]);
  });
});

describe('authorizeCall', () => {
  const codeOf = (fn: () => unknown) => {
    try { fn(); } catch (e) { return (e as { code: number }).code; }
    return 0;
  };
  it('maps states to 11.9 codes', () => {
    expect(codeOf(() => authorizeCall({ server: server('deleting'), binding: binding(), tools, agent: 'claude' }, 'tts'))).toBe(-32019);
    expect(codeOf(() => authorizeCall({ server: server('disabled'), binding: binding(), tools, agent: 'claude' }, 'tts'))).toBe(-32010);
    expect(codeOf(() => authorizeCall({ server: server('active'), binding: binding(0), tools, agent: 'claude' }, 'tts'))).toBe(-32018);
    expect(codeOf(() => authorizeCall({ server: server('needs_auth'), binding: binding(), tools, agent: 'claude' }, 'tts'))).toBe(-32012);
    expect(codeOf(() => authorizeCall({ server: server('pending_approval'), binding: binding(), tools, agent: 'claude' }, 'tts'))).toBe(-32011);
    expect(codeOf(() => authorizeCall({ server: server('active'), binding: binding(), tools, agent: 'claude' }, 'changed'))).toBe(-32011);
    expect(codeOf(() => authorizeCall({ server: server('active'), binding: binding(), tools, agent: 'claude' }, 'new'))).toBe(-32011);
    expect(codeOf(() => authorizeCall({ server: server('active'), binding: binding(), tools, agent: 'claude' }, 'off'))).toBe(-32011);
    expect(codeOf(() => authorizeCall({ server: server('active'), binding: binding(), tools, agent: 'claude' }, 'nope'))).toBe(-32011);
  });
  it('allows approved tools in active, changed and error states', () => {
    for (const st of ['active', 'changed', 'error'] as const) {
      expect(authorizeCall({ server: server(st), binding: binding(), tools, agent: 'claude' }, 'tts').name).toBe('tts');
    }
  });
  it('message names the server for the agent to relay', () => {
    try {
      authorizeCall({ server: server('needs_auth'), binding: binding(), tools, agent: 'claude' }, 'tts');
    } catch (e) {
      expect((e as Error).message).toContain('Fish Audio');
      expect((e as { rpc: { data: { action: string } } }).rpc.data.action).toBe('relogin');
    }
  });
});

describe('statusBadges', () => {
  it('flags changed and new tools and deprecated transport', () => {
    const s = { ...server('active'), transport: 'sse' as const };
    expect(statusBadges(s, tools)).toEqual(['tools_changed', 'new_tools', 'deprecated_transport']);
  });
});
