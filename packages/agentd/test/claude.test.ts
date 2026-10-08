import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_HEADERS_HELPER, claudeConfigPath, claudeSettingsPath, createClaudeAdapter } from '../src/adapters/claude.js';
import { AgentdError } from '../src/errors.js';
import type { CommandRunner } from '../src/runner.js';
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

interface Lies {
  /** add-json 이 exit 0 을 돌려주지만 파일에 쓰지 않는다 */
  forgetAdd?: string;
  /** add-json 뒤 항목의 url 을 다른 값으로 바꿔 둔다 */
  wrongUrl?: string;
  /** remove 가 exit 0 을 돌려주지만 지우지 않는다 */
  keepOnRemove?: string;
}

const WRONG_URL = 'http://127.0.0.1:7410/mcp/someone-else';

/** D4: 성공(exit 0)을 보고하면서 ~/.claude.json 을 기대와 다르게 남기는 가짜 CLI. fakeClaudeRunner 를 감싼다. */
function lyingClaudeRunner(home: string, lies: Lies): { runner: CommandRunner; calls: Call[] } {
  const base = fakeClaudeRunner(home);
  const file = claudeConfigPath(home);
  const runner: CommandRunner = {
    async run(cmd, args, opts) {
      const sub = args[1];
      const name = args[2] ?? '';
      if ((sub === 'add-json' && name === lies.forgetAdd) || (sub === 'remove' && name === lies.keepOnRemove)) {
        base.calls.push({ cmd, args: [...args] });
        return { code: 0, stdout: `ok ${sub} ${name}`, stderr: '' };
      }
      const r = await base.runner.run(cmd, args, opts);
      if (sub === 'add-json' && name === lies.wrongUrl && r.code === 0) {
        const cfg = JSON.parse(await fs.readFile(file, 'utf8')) as { mcpServers: Record<string, { url: string }> };
        cfg.mcpServers[name]!.url = WRONG_URL;
        await fs.writeFile(file, JSON.stringify(cfg, null, 2) + '\n');
      }
      return r;
    },
  };
  return { runner, calls: base.calls };
}

async function applyError(home: string, lies: Lies): Promise<AgentdError> {
  const { runner } = lyingClaudeRunner(home, lies);
  const err = await createClaudeAdapter({ home, runner })
    .apply(desired)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AgentdError);
  expect((err as AgentdError).code).toBe('cli_error');
  return err as AgentdError;
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

  describe('verifies ~/.claude.json after the CLI reports success (D4)', () => {
    it('fails with cli_error when add-json exits 0 but the entry never reaches mcpServers', async () => {
      const err = await applyError(home, { forgetAdd: 'omni-new' });
      expect(err.message).toContain(claudeConfigPath(home));
      expect(err.message).toContain('omni-new is missing from mcpServers');
      expect(err.message).not.toContain('omni-noauto');
      // 확인되지 않았으므로 자동 승인도 쓰지 않았다
      expect(await readOrUndefined(claudeSettingsPath(home))).toBe(SETTINGS);

      // 정상 CLI 로 다시 적용하면 빠진 항목만 CLI 로 추가하고, 미뤄 둔 권한(omni-changed)은 updated 로 맞춘다
      const { runner, calls } = fakeClaudeRunner(home);
      const result = await createClaudeAdapter({ home, runner }).apply(desired);
      expect(result).toEqual({ added: ['omni-new'], updated: ['omni-changed'], removed: [], unchanged: ['omni-keep', 'omni-noauto'] });
      expect(argsOf(calls).map((a) => a.slice(0, 4))).toEqual([
        ['claude', 'mcp', 'remove', 'omni-new'],
        ['claude', 'mcp', 'add-json', 'omni-new'],
      ]);
      expect(await readOrUndefined(claudeSettingsPath(home))).toBe(SETTINGS_AFTER);
    });

    it('fails with cli_error when the stored entry has a different url', async () => {
      const err = await applyError(home, { wrongUrl: 'omni-changed' });
      expect(err.message).toContain(`omni-changed has url "${WRONG_URL}"`);
      expect(err.message).toContain(`expected "${entry('changed').url}"`);
      expect(await readOrUndefined(claudeSettingsPath(home))).toBe(SETTINGS);
    });

    it('fails with cli_error when remove exits 0 but the entry is still there', async () => {
      const err = await applyError(home, { keepOnRemove: 'omni-old' });
      expect(err.message).toContain('omni-old is still in mcpServers after claude mcp remove');
      expect(await readOrUndefined(claudeSettingsPath(home))).toBe(SETTINGS);
    });

    it('names every mismatched entry in one error', async () => {
      const err = await applyError(home, { forgetAdd: 'omni-noauto', wrongUrl: 'omni-new', keepOnRemove: 'omni-old' });
      expect(err.message).toContain('omni-noauto is missing');
      expect(err.message).toContain('omni-new has url');
      expect(err.message).toContain('omni-old is still in mcpServers');
      expect(err.message).not.toContain('omni-changed');
    });
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
