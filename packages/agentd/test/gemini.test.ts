import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGeminiAdapter, geminiSettingsPath, renderGeminiEntry } from '../src/adapters/gemini.js';
import { AgentdError } from '../src/errors.js';
import { parseJsonc } from '../src/jsonc-edit.js';
import { entry, makeHome, mode, readOrUndefined, removeHome, writeFixture } from './helpers.js';

const AUTH = 'Bearer ${OMNICODE_HUB_TOKEN_GEMINI}';
const JOB = '${OMNICODE_JOB_ID:-}';

const entryText = (id: string, indent: string): string =>
  [
    '{',
    `${indent}  "httpUrl": "http://127.0.0.1:7410/mcp/${id}",`,
    `${indent}  "headers": {`,
    `${indent}    "Authorization": "${AUTH}",`,
    `${indent}    "X-OmniCode-Job": "${JOB}"`,
    `${indent}  },`,
    `${indent}  "timeout": 600000,`,
    `${indent}  "trust": true`,
    `${indent}}`,
  ].join('\n');

const SETTINGS = `{
  // Gemini settings — hand edited
  "theme": "dark",
  "mcpServers": {
    "mine": { "command": "node", "args": ["x.js"] }, // my own
    "omni-old": ${entryText('old', '    ')},
    "omni-keep": ${entryText('keep', '    ')},
    "omni-changed": { "httpUrl": "http://127.0.0.1:7410/mcp/changed", "headers": {}, "timeout": 1, "trust": false }
  },
  "telemetry": { "enabled": false }
}
`;

const EXPECTED = `{
  // Gemini settings — hand edited
  "theme": "dark",
  "mcpServers": {
    "mine": { "command": "node", "args": ["x.js"] }, // my own
    "omni-keep": ${entryText('keep', '    ')},
    "omni-changed": ${entryText('changed', '    ')},
    "omni-new": ${entryText('new', '    ')}
  },
  "telemetry": { "enabled": false }
}
`;

const desired = { entries: [entry('keep'), entry('changed'), entry('new')] };

describe('gemini adapter', () => {
  let home: string;
  let file: string;
  beforeEach(async () => {
    home = await makeHome();
    file = geminiSettingsPath(home);
  });
  afterEach(async () => {
    await removeHome(home);
  });

  it('renders the entry from design 12.5', () => {
    expect(renderGeminiEntry(entry('fish-audio', { autoApprove: false, timeoutMs: 1234 }))).toEqual({
      httpUrl: 'http://127.0.0.1:7410/mcp/fish-audio',
      headers: { Authorization: AUTH, 'X-OmniCode-Job': JOB },
      timeout: 1234,
      trust: false,
    });
  });

  it('preserves comments and other servers while adding, updating and removing omni entries', async () => {
    await writeFixture(file, SETTINGS);
    const adapter = createGeminiAdapter({ home });
    const result = await adapter.apply(desired);
    expect(result).toEqual({ added: ['omni-new'], updated: ['omni-changed'], removed: ['omni-old'], unchanged: ['omni-keep'] });
    expect(await readOrUndefined(file)).toBe(EXPECTED);
    expect(await mode(file)).toBe(0o600);
    const names = await fs.readdir(path.join(home, '.gemini'));
    expect(names.filter((n) => n.startsWith('settings.json.omnicode-bak.'))).toHaveLength(1);
  });

  it('plan does not write', async () => {
    await writeFixture(file, SETTINGS);
    const adapter = createGeminiAdapter({ home });
    expect(await adapter.plan(desired)).toEqual({ added: ['omni-new'], updated: ['omni-changed'], removed: ['omni-old'], unchanged: ['omni-keep'] });
    expect(await readOrUndefined(file)).toBe(SETTINGS);
    expect(await fs.readdir(path.join(home, '.gemini'))).toEqual(['settings.json']);
  });

  it('is idempotent', async () => {
    await writeFixture(file, SETTINGS);
    const adapter = createGeminiAdapter({ home });
    await adapter.apply(desired);
    const second = await adapter.apply(desired);
    expect(second).toEqual({ added: [], updated: [], removed: [], unchanged: ['omni-keep', 'omni-changed', 'omni-new'] });
    expect(await readOrUndefined(file)).toBe(EXPECTED);
  });

  it('removing the last omni entry keeps the previous server line intact', async () => {
    await writeFixture(file, '{\n  "mcpServers": {\n    "mine": { "command": "node" }, // my own\n    "omni-old": { "httpUrl": "http://127.0.0.1:7410/mcp/old" }\n  }\n}\n');
    const adapter = createGeminiAdapter({ home });
    expect((await adapter.apply({ entries: [] })).removed).toEqual(['omni-old']);
    expect(await readOrUndefined(file)).toBe('{\n  "mcpServers": {\n    "mine": { "command": "node" } // my own\n  }\n}\n');
  });

  it('creates the file when missing', async () => {
    const adapter = createGeminiAdapter({ home });
    await adapter.apply({ entries: [entry('new')] });
    expect(await readOrUndefined(file)).toBe(`{\n  "mcpServers": {\n    "omni-new": ${entryText('new', '    ')}\n  }\n}\n`);
    expect(await mode(file)).toBe(0o600);
    expect(await mode(path.join(home, '.gemini'))).toBe(0o700);
  });

  it('adds mcpServers to a settings file that has none', async () => {
    await writeFixture(file, '{\n  "theme": "dark"\n}\n');
    const adapter = createGeminiAdapter({ home });
    await adapter.apply({ entries: [entry('new')] });
    expect(await readOrUndefined(file)).toBe(`{\n  "theme": "dark",\n  "mcpServers": {\n    "omni-new": ${entryText('new', '    ')}\n  }\n}\n`);
  });

  it('writes trust: false when auto approval is off', async () => {
    const adapter = createGeminiAdapter({ home });
    await adapter.apply({ entries: [entry('x', { autoApprove: false })] });
    const parsed = parseJsonc((await readOrUndefined(file)) ?? '') as { mcpServers: Record<string, { trust: boolean }> };
    expect(parsed.mcpServers['omni-x']?.trust).toBe(false);
    // trust 만 바뀌면 updated
    expect((await adapter.plan({ entries: [entry('x')] })).updated).toEqual(['omni-x']);
  });

  it('refuses to touch a broken file', async () => {
    await writeFixture(file, '{ "mcpServers": { ');
    const adapter = createGeminiAdapter({ home });
    const err = await adapter.apply(desired).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentdError);
    expect((err as AgentdError).code).toBe('adapter_error');
    expect(await readOrUndefined(file)).toBe('{ "mcpServers": { ');
  });
});
