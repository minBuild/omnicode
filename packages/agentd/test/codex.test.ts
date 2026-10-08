import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexConfigPath, createCodexAdapter, renderCodexBlock } from '../src/adapters/codex.js';
import { AgentdError } from '../src/errors.js';
import { entry, makeHome, mode, readOrUndefined, removeHome, writeFixture } from './helpers.js';

const block = (id: string, timeoutSec: number): string =>
  [
    `[mcp_servers.omni-${id}]`,
    `url = "http://127.0.0.1:7410/mcp/${id}"`,
    `bearer_token_env_var = "OMNICODE_HUB_TOKEN_CODEX"`,
    `env_http_headers = { "X-OmniCode-Job" = "OMNICODE_JOB_ID" }`,
    `startup_timeout_sec = 30`,
    `tool_timeout_sec = ${timeoutSec}`,
    '',
  ].join('\n');

const HEAD = `# Codex config — hand edited
model = "o3"

[mcp_servers.mine]
command = "node"
args = ["server.js"]   # my own server

`;
const TAIL = `# project trust
[projects."/home/omniagent/work"]
trust_level = "trusted"
`;

const CONFIG = HEAD + block('old', 600) + '\n' + block('keep', 600) + '\n' + block('changed', 60) + '\n' + TAIL;
const EXPECTED = HEAD + block('keep', 600) + '\n' + block('changed', 120) + '\n' + TAIL + '\n' + block('new', 600);

const desired = { entries: [entry('keep'), entry('changed', { timeoutMs: 120_000 }), entry('new')] };

describe('codex adapter', () => {
  let home: string;
  let file: string;
  beforeEach(async () => {
    home = await makeHome();
    file = codexConfigPath(home);
  });
  afterEach(async () => {
    await removeHome(home);
  });

  it('renders the block from design 12.4', () => {
    expect(renderCodexBlock(entry('fish-audio'))).toBe(
      '[mcp_servers.omni-fish-audio]\n' +
        'url = "http://127.0.0.1:7410/mcp/fish-audio"\n' +
        'bearer_token_env_var = "OMNICODE_HUB_TOKEN_CODEX"\n' +
        'env_http_headers = { "X-OmniCode-Job" = "OMNICODE_JOB_ID" }\n' +
        'startup_timeout_sec = 30\n' +
        'tool_timeout_sec = 600\n',
    );
    expect(renderCodexBlock(entry('x', { timeoutMs: 90_500 }))).toContain('tool_timeout_sec = 91\n');
  });

  it('updates only omni blocks, appends new ones, removes stale ones and keeps everything else byte-for-byte', async () => {
    await writeFixture(file, CONFIG);
    const adapter = createCodexAdapter({ home });
    const result = await adapter.apply(desired);
    expect(result).toEqual({ added: ['omni-new'], updated: ['omni-changed'], removed: ['omni-old'], unchanged: ['omni-keep'] });
    const out = await readOrUndefined(file);
    expect(out).toBe(EXPECTED);
    const parsed = parseToml(out ?? '') as { mcp_servers: Record<string, Record<string, unknown>> };
    expect(Object.keys(parsed.mcp_servers).sort()).toEqual(['mine', 'omni-changed', 'omni-keep', 'omni-new']);
    expect(parsed.mcp_servers['omni-changed']?.['tool_timeout_sec']).toBe(120);
    expect(await mode(file)).toBe(0o600);
    const names = await fs.readdir(path.join(home, '.codex'));
    expect(names.filter((n) => n.startsWith('config.toml.omnicode-bak.'))).toHaveLength(1);
    expect(names.filter((n) => n.endsWith('.omnicode-tmp'))).toHaveLength(0);
  });

  it('plan returns the diff without writing', async () => {
    await writeFixture(file, CONFIG);
    const adapter = createCodexAdapter({ home });
    expect(await adapter.plan(desired)).toEqual({ added: ['omni-new'], updated: ['omni-changed'], removed: ['omni-old'], unchanged: ['omni-keep'] });
    expect(await readOrUndefined(file)).toBe(CONFIG);
    expect(await fs.readdir(path.join(home, '.codex'))).toEqual(['config.toml']);
  });

  it('is idempotent', async () => {
    await writeFixture(file, CONFIG);
    const adapter = createCodexAdapter({ home });
    await adapter.apply(desired);
    const after = await readOrUndefined(file);
    const second = await adapter.apply(desired);
    expect(second).toEqual({ added: [], updated: [], removed: [], unchanged: ['omni-keep', 'omni-changed', 'omni-new'] });
    expect(await readOrUndefined(file)).toBe(after);
    const names = await fs.readdir(path.join(home, '.codex'));
    expect(names.filter((n) => n.startsWith('config.toml.omnicode-bak.'))).toHaveLength(1);
  });

  it('creates the file and directory when missing, without a leading blank line', async () => {
    const adapter = createCodexAdapter({ home });
    await adapter.apply({ entries: [entry('a'), entry('b', { timeoutMs: 5_000 })] });
    expect(await readOrUndefined(file)).toBe(block('a', 600) + '\n' + block('b', 5));
    expect(await mode(file)).toBe(0o600);
    expect(await mode(path.join(home, '.codex'))).toBe(0o700);
  });

  it('separates an appended block from a file that lacks a trailing newline', async () => {
    await writeFixture(file, 'model = "o3"');
    const adapter = createCodexAdapter({ home });
    await adapter.apply({ entries: [entry('a')] });
    expect(await readOrUndefined(file)).toBe('model = "o3"\n\n' + block('a', 600));
  });

  it('removes everything managed when desired is empty, keeping user blocks', async () => {
    await writeFixture(file, CONFIG);
    const adapter = createCodexAdapter({ home });
    const result = await adapter.apply({ entries: [] });
    expect(result).toEqual({ added: [], updated: [], removed: ['omni-old', 'omni-keep', 'omni-changed'], unchanged: [] });
    expect(await readOrUndefined(file)).toBe(HEAD + TAIL);
  });

  it('refuses to write when the result is not valid TOML (inline omni entry conflicts with the block)', async () => {
    const broken = '[mcp_servers]\nomni-new = { url = "http://127.0.0.1:7410/mcp/new" }\n';
    await writeFixture(file, broken);
    const adapter = createCodexAdapter({ home });
    const err = await adapter.apply({ entries: [entry('new')] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentdError);
    expect((err as AgentdError).code).toBe('adapter_error');
    expect((err as AgentdError).message).toContain('not valid TOML');
    expect(await readOrUndefined(file)).toBe(broken);
    expect(await fs.readdir(path.join(home, '.codex'))).toEqual(['config.toml']);
  });

  it('refuses to write when the existing file is already broken', async () => {
    await writeFixture(file, 'model = \n');
    const adapter = createCodexAdapter({ home });
    const err = await adapter.plan({ entries: [entry('new')] }).catch((e: unknown) => e);
    expect((err as AgentdError).code).toBe('adapter_error');
    expect(await readOrUndefined(file)).toBe('model = \n');
  });

  it('treats a block with a user-edited field as updated and rewrites it', async () => {
    await writeFixture(file, block('a', 600).replace('startup_timeout_sec = 30', 'startup_timeout_sec = 5'));
    const adapter = createCodexAdapter({ home });
    expect((await adapter.plan({ entries: [entry('a')] })).updated).toEqual(['omni-a']);
    await adapter.apply({ entries: [entry('a')] });
    expect(await readOrUndefined(file)).toBe(block('a', 600));
  });

  it('handles quoted headers and sub-tables of a managed entry', async () => {
    const text = '[mcp_servers."omni-a"]\nurl = "http://127.0.0.1:7410/mcp/a"\n\n[mcp_servers.omni-a.env_http_headers]\n"X-Other" = "X"\n\n[other]\nk = 1\n';
    await writeFixture(file, text);
    const adapter = createCodexAdapter({ home });
    const result = await adapter.apply({ entries: [entry('a')] });
    expect(result.updated).toEqual(['omni-a']);
    expect(await readOrUndefined(file)).toBe(block('a', 600) + '\n[other]\nk = 1\n');
  });

  it('keeps CRLF line endings', async () => {
    const crlf = ('model = "o3"\n\n' + block('a', 60)).replace(/\n/g, '\r\n');
    await writeFixture(file, crlf);
    const adapter = createCodexAdapter({ home });
    await adapter.apply({ entries: [entry('a'), entry('b')] });
    const out = await readOrUndefined(file);
    expect(out).toBe(('model = "o3"\n\n' + block('a', 600) + '\n' + block('b', 600)).replace(/\n/g, '\r\n'));
  });

  it('keeps only the three newest backups', async () => {
    const adapter = createCodexAdapter({ home });
    for (const t of [60_000, 120_000, 180_000, 240_000, 300_000]) {
      await adapter.apply({ entries: [entry('a', { timeoutMs: t })] });
    }
    const names = (await fs.readdir(path.join(home, '.codex'))).filter((n) => n.startsWith('config.toml.omnicode-bak.'));
    expect(names).toHaveLength(3);
    const contents = await Promise.all(names.map((n) => fs.readFile(path.join(home, '.codex', n), 'utf8')));
    const timeouts = contents.map((c) => /tool_timeout_sec = (\d+)/.exec(c)?.[1]).sort();
    expect(timeouts).toEqual(['120', '180', '240']);
    for (const n of names) expect(await mode(path.join(home, '.codex', n))).toBe(0o600);
  });
});
