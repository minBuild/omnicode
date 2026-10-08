import { describe, expect, it } from 'vitest';
import type { BindingRecord, ServerRecord } from '@omnicode/shared';
import { desiredFor, desiredForAll } from '../../src/sync/planner.js';

const srv = (id: string, status: ServerRecord['status'], auto = 1): ServerRecord =>
  ({ id, display_name: id, status, call_timeout_ms: 120000, cli_auto_approve: auto, transport: 'streamable_http', auth_type: 'none', source: 'url' }) as ServerRecord;
const bind = (server_id: string, agent: BindingRecord['agent'], enabled = 1): BindingRecord => ({ server_id, agent, enabled, sync_status: null, synced_at: null, last_error: null });

describe('planner', () => {
  const servers = [srv('b', 'active'), srv('a', 'disabled', 0), srv('c', 'pending_approval'), srv('d', 'deleting'), srv('e', 'needs_auth')];
  const bindings = [bind('b', 'claude'), bind('a', 'claude'), bind('c', 'claude'), bind('d', 'claude'), bind('e', 'claude'), bind('b', 'codex', 0)];
  it('includes active/disabled/needs_auth, excludes pending/deleting and disabled bindings, sorted by id', () => {
    const d = desiredFor('claude', servers, bindings, 7410);
    expect(d.entries.map((e) => e.name)).toEqual(['omni-a', 'omni-b', 'omni-e']);
    expect(d.entries[0]).toEqual({ name: 'omni-a', serverId: 'a', url: 'http://127.0.0.1:7410/mcp/a', timeoutMs: 120000, autoApprove: false });
    expect(desiredFor('codex', servers, bindings, 7410).entries).toEqual([]);
    expect(desiredFor('gemini', servers, bindings, 7410).entries).toEqual([]);
  });
  it('desiredForAll covers all agents', () => {
    expect(Object.keys(desiredForAll(servers, bindings, 7410)).sort()).toEqual(['claude', 'codex', 'gemini']);
  });
});
