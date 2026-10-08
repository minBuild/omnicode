import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_HEADERS_HELPER, claudeConfigPath, claudeSettingsPath, createClaudeAdapter } from '../src/adapters/claude.js';
import { AgentdError } from '../src/errors.js';
import { entry, fakeClaudeRunner, makeHome, mode, readOrUndefined, removeHome, writeFixture, type Call } from './helpers.js';

const helper = CLAUDE_HEADERS_HELPER;

const CLAUDE_JSON = JSON.stringify(
  {
    numStartups: 3,
    mcpServers: {
      mine: { type: 'stdio', command: 'node', args: ['x.js'] },
      'omni-old': { type: 'http', url: 'http://127.0.0.1:7410/mcp/old', headersHelper: helper, timeout: 600000 },
      'omni-keep': { type: 'http', url: 'http://127.0.0.1:7410/mcp/keep', headersHelper: helper, timeout: 600000 },
      'omni-changed': { type: 'http', url: 'http://127.0.0.1:7410/mcp/changed', headersHelper: helper, timeout: 60000 },
    },
  },
  null,
  2,
);

const SETTINGS = `{
  // Claude Code settings — hand edited
  "permissions": {
    "allow": [
      "Bash(git:*)",
      // hub servers
      "mcp__omni-old",
      "mcp__omni-keep"
    ],
    "deny": ["Bash(rm:*)"]
  },
  "model": "opus"
}
`;

const SETTINGS_AFTER = `{
  // Claude Code settings — hand edited
  "permissions": {
    "allow": [
      "Bash(git:*)",
      // hub servers
      "mcp__omni-keep",
      "mcp__omni-changed",
      "mcp__omni-new"
    ],
    "deny": ["Bash(rm:*)"]
  },
  "model": "opus"
}
`;

const desired = {
  entries: [entry('keep'), entry('changed', { timeoutMs: 120_000 }), entry('new'), entry('noauto', { autoApprove: false })],
};

function argsOf(calls: Call[]): string[][] {
  return calls.map((c) => [c.cmd, ...c.args]);
}

describe('claude adapter', () => {
  let home: string;
  beforeEach(async () => {
    home = await makeHome();
    await writeFixture(claudeConfigPath(home), CLAUDE_JSON);
    await writeFixture(claudeSettingsPath(home), SETTINGS);
  });
  afterEach(async () => {
    await removeHome(home);
  });

  it('runs the CLI commands in order and edits settings.json preserving comments', async () => {
    const { runner, calls } = fakeClaudeRunner(home);
    const adapter = createClaudeAdapter({ home, runner });
    const result = await adapter.apply(desired);

    expect(result).toEqual({ added: ['omni-new', 'omni-noauto'], updated: ['omni-changed'], removed: ['omni-old'], unchanged: ['omni-keep'] });

    const json = (e: ReturnType<typeof entry>): string => JSON.stringify({ type: 'http', url: e.url, headersHelper: helper, timeout: e.timeoutMs });
    expect(argsOf(calls)).toEqual([
      ['claude', 'mcp', 'remove', 'omni-changed', '--scope', 'user'],
      ['claude', 'mcp', 'add-json', 'omni-changed', json(entry('changed', { timeoutMs: 120_000 })), '--scope', 'user'],
      ['claude', 'mcp', 'remove', 'omni-new', '--scope', 'user'],
      ['claude', 'mcp', 'add-json', 'omni-new', json(entry('new')), '--scope', 'user'],
      ['claude', 'mcp', 'remove', 'omni-noauto', '--scope', 'user'],
      ['claude', 'mcp', 'add-json', 'omni-noauto', json(entry('noauto')), '--scope', 'user'],
      ['claude', 'mcp', 'remove', 'omni-old', '--scope', 'user'],
    ]);

    // ~/.claude.json 은 CLI(가짜)만 고쳤다: 다른 서버는 그대로
    const cfg = JSON.parse((await readOrUndefined(claudeConfigPath(home))) ?? '{}') as { numStartups: number; mcpServers: Record<string, unknown> };
    expect(cfg.numStartups).toBe(3);
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['mine', 'omni-changed', 'omni-keep', 'omni-new', 'omni-noauto']);
    expect(cfg.mcpServers['mine']).toEqual({ type: 'stdio', command: 'node', args: ['x.js'] });

    expect(await readOrUndefined(claudeSettingsPath(home))).toBe(SETTINGS_AFTER);
    expect(await mode(claudeSettingsPath(home))).toBe(0o600);
    // 백업이 남는다
    const dir = await fs.readdir(path.join(home, '.claude'));
    expect(dir.filter((n) => n.startsWith('settings.json.omnicode-bak.'))).toHaveLength(1);
    expect(dir.filter((n) => n.endsWith('.omnicode-tmp'))).toHaveLength(0);
  });

  it('plan reports the same diff but runs nothing and writes nothing', async () => {
    const { runner, calls } = fakeClaudeRunner(home);
    const adapter = createClaudeAdapter({ home, runner });
    const plan = await adapter.plan(desired);
    expect(plan).toEqual({ added: ['omni-new', 'omni-noauto'], updated: ['omni-changed'], removed: ['omni-old'], unchanged: ['omni-keep'] });
    expect(calls).toHaveLength(0);
    expect(await readOrUndefined(claudeConfigPath(home))).toBe(CLAUDE_JSON);
    expect(await readOrUndefined(claudeSettingsPath(home))).toBe(SETTINGS);
  });

  it('is idempotent: a second apply changes nothing', async () => {
    const { runner, calls } = fakeClaudeRunner(home);
    const adapter = createClaudeAdapter({ home, runner });
    await adapter.apply(desired);
    calls.length = 0;
    const before = await readOrUndefined(claudeSettingsPath(home));
    const second = await adapter.apply(desired);
    expect(second).toEqual({ added: [], updated: [], removed: [], unchanged: ['omni-keep', 'omni-changed', 'omni-new', 'omni-noauto'] });
    expect(calls).toHaveLength(0);
    expect(await readOrUndefined(claudeSettingsPath(home))).toBe(before);
  });

  it('counts a permission-only difference as updated without calling the CLI', async () => {
    const { runner, calls } = fakeClaudeRunner(home);
    const adapter = createClaudeAdapter({ home, runner });
    const result = await adapter.apply({ entries: [entry('keep', { autoApprove: false }), entry('old'), entry('changed', { timeoutMs: 60_000 })] });
    expect(result).toEqual({ added: [], updated: ['omni-keep', 'omni-changed'], removed: [], unchanged: ['omni-old'] });
    expect(calls).toHaveLength(0);
    const text = (await readOrUndefined(claudeSettingsPath(home))) ?? '';
    expect(text).toContain('"mcp__omni-old"');
    expect(text).toContain('"mcp__omni-changed"');
    expect(text).not.toContain('"mcp__omni-keep"');
    expect(text).toContain('// hub servers');
  });

  it('creates settings.json and the .claude directory when missing', async () => {
    await fs.rm(path.join(home, '.claude'), { recursive: true, force: true });
    await fs.rm(claudeConfigPath(home), { force: true });
    const { runner } = fakeClaudeRunner(home);
    const adapter = createClaudeAdapter({ home, runner });
    const result = await adapter.apply({ entries: [entry('new'), entry('noauto', { autoApprove: false })] });
    expect(result.added).toEqual(['omni-new', 'omni-noauto']);
    expect(await readOrUndefined(claudeSettingsPath(home))).toBe('{\n  "permissions": {\n    "allow": [\n      "mcp__omni-new"\n    ]\n  }\n}\n');
    expect(await mode(claudeSettingsPath(home))).toBe(0o600);
    expect(await mode(path.join(home, '.claude'))).toBe(0o700);
  });

  it('does not create settings.json when nothing needs auto-approval', async () => {
    await fs.rm(claudeSettingsPath(home), { force: true });
    const { runner } = fakeClaudeRunner(home);
    const adapter = createClaudeAdapter({ home, runner });
    await adapter.apply({ entries: [entry('x', { autoApprove: false })] });
    expect(await readOrUndefined(claudeSettingsPath(home))).toBeUndefined();
  });

  it('reports cli_error when add-json fails', async () => {
    const { runner } = fakeClaudeRunner(home, { failAddJson: true });
    const adapter = createClaudeAdapter({ home, runner });
    const err = await adapter.apply(desired).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentdError);
    expect((err as AgentdError).code).toBe('cli_error');
    expect((err as AgentdError).message).toContain('add-json omni-changed');
    // 설정 파일은 건드리지 않았다
    expect(await readOrUndefined(claudeSettingsPath(home))).toBe(SETTINGS);
  });

  it('ignores "not found" on remove but fails on other remove errors for existing entries', async () => {
    const { runner } = fakeClaudeRunner(home, {
      removeResult: (name, present) => (name === 'omni-old' && present ? { code: 1, stdout: '', stderr: 'permission denied' } : undefined),
    });
    const adapter = createClaudeAdapter({ home, runner });
    const err = await adapter.apply(desired).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentdError);
    expect((err as AgentdError).code).toBe('cli_error');
    expect((err as AgentdError).message).toContain('remove omni-old');
  });

  it('refuses to touch a broken settings.json', async () => {
    await writeFixture(claudeSettingsPath(home), '{ "permissions": { "allow": [ ');
    const { runner, calls } = fakeClaudeRunner(home);
    const adapter = createClaudeAdapter({ home, runner });
    const err = await adapter.plan(desired).catch((e: unknown) => e);
    expect((err as AgentdError).code).toBe('adapter_error');
    expect(calls).toHaveLength(0);
  });
});
