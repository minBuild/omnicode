import { describe, expect, it } from 'vitest';
import { createMasker, type Agent, type AgentdStatus, type DesiredAgentConfig, type SyncResult } from '@omnicode/shared';
import type { AgentdClient, AgentTokenRecord, HubConfig, Registry, SecretStore, SecretValue } from '../../src/contracts.js';
import { createTokenManager } from '../../src/services/tokens.js';

function fakes() {
  const secrets = new Map<string, SecretValue>();
  const store: SecretStore = {
    get: async <T extends SecretValue>(ref: string) => secrets.get(ref) as T | undefined,
    put: async (ref, v) => void secrets.set(ref, v),
    delete: async (ref) => void secrets.delete(ref),
  };
  const rows = new Map<Agent, AgentTokenRecord>();
  const events: unknown[] = [];
  const registry = {
    agentTokens: {
      get: (a: Agent) => rows.get(a),
      all: () => [...rows.values()],
      set: (agent: Agent, h: string, prev: { sha256: string; validUntil: string } | null = null, rotatedAt = 'now') =>
        void rows.set(agent, { agent, token_sha256: h, prev_sha256: prev?.sha256 ?? null, prev_valid_until: prev?.validUntil ?? null, rotated_at: rotatedAt }),
    },
    events: { add: (e: unknown) => void events.push(e) },
  } as unknown as Registry;
  const written: Array<[Agent, string]> = [];
  let agentdDown = false;
  const agentd: AgentdClient = {
    syncPlan: async (_a: Agent, _d: DesiredAgentConfig): Promise<SyncResult> => ({ added: [], updated: [], removed: [], unchanged: [] }),
    syncApply: async (_a: Agent, _d: DesiredAgentConfig): Promise<SyncResult> => ({ added: [], updated: [], removed: [], unchanged: [] }),
    writeToken: async (a: Agent, t: string) => {
      if (agentdDown) throw new Error('down');
      written.push([a, t]);
    },
    status: async (): Promise<AgentdStatus> => ({ version: '0', home: '', cli: { claude: null, codex: null, gemini: null }, lastSync: { claude: null, codex: null, gemini: null } }),
  };
  const config = { secretsPrefix: 'omnicode', agentTokenGraceMs: 1000 } as HubConfig;
  const masker = createMasker();
  const logger = { warn() {}, info() {}, error() {}, debug() {} } as unknown as import('pino').Logger;
  let t = Date.parse('2026-10-07T00:00:00Z');
  const now = () => new Date(t);
  const mgr = createTokenManager({ config, registry, secrets: store, agentd, masker, logger, now });
  return { mgr, secrets, rows, written, masker, setDown: (d: boolean) => (agentdDown = d), advance: (ms: number) => (t += ms) };
}

describe('token manager', () => {
  it('creates tokens on first init, writes files, masks them, and authenticates', async () => {
    const f = fakes();
    await f.mgr.init();
    const secret = f.secrets.get('omnicode/hub-tokens') as Record<string, string>;
    expect(secret.claude).toMatch(/^omh_/);
    expect(f.written.map(([a]) => a).sort()).toEqual(['claude', 'codex', 'gemini']);
    expect(f.mgr.authenticate(secret.claude)).toBe('claude');
    expect(f.mgr.authenticate(secret.codex)).toBe('codex');
    expect(f.mgr.authenticate('omh_nope')).toBeNull();
    expect(f.masker.mask(`x ${secret.gemini} y`)).toBe('x *** y');
  });

  it('rotation keeps the old token valid during the grace period only', async () => {
    const f = fakes();
    await f.mgr.init();
    const old = (f.secrets.get('omnicode/hub-tokens') as Record<string, string>).claude;
    const r = await f.mgr.rotate(['claude']);
    const fresh = (f.secrets.get('omnicode/hub-tokens') as Record<string, string>).claude;
    expect(fresh).not.toBe(old);
    expect(f.mgr.authenticate(old)).toBe('claude');
    expect(f.mgr.authenticate(fresh)).toBe('claude');
    expect(f.mgr.graceUntil('claude')).toBe(r.graceUntil);
    f.advance(1500);
    expect(f.mgr.authenticate(old)).toBeNull();
    expect(f.mgr.authenticate(fresh)).toBe('claude');
    expect(f.rows.get('claude')?.prev_sha256).not.toBeNull();
  });

  it('defers file writes while agentd is down and retries with ensureFiles', async () => {
    const f = fakes();
    f.setDown(true);
    await f.mgr.init();
    expect(f.written).toEqual([]);
    expect(await f.mgr.ensureFiles()).toBe(false);
    f.setDown(false);
    expect(await f.mgr.ensureFiles()).toBe(true);
    expect(f.written.length).toBe(3);
  });
});
