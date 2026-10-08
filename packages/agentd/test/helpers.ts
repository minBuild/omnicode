import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DesiredEntry } from '@omnicode/shared';
import type { CommandRunner, RunResult } from '../src/runner.js';

/** 테스트마다 임시 HOME. 소켓 경로 길이 제한(macOS ~104자) 때문에 접두사를 짧게 둔다. */
export async function makeHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'oa-'));
}

export async function removeHome(home: string): Promise<void> {
  await fs.rm(home, { recursive: true, force: true });
}

export function entry(id: string, over: Partial<DesiredEntry> = {}): DesiredEntry {
  return { name: `omni-${id}`, serverId: id, url: `http://127.0.0.1:7410/mcp/${id}`, timeoutMs: 600_000, autoApprove: true, ...over };
}

export async function mode(file: string): Promise<number> {
  return (await fs.stat(file)).mode & 0o777;
}

export async function readOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

export async function writeFixture(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

export interface Call {
  cmd: string;
  args: string[];
}

export interface FakeClaudeOptions {
  /** add-json 을 실패시킨다 */
  failAddJson?: boolean;
  /** remove 결과를 덮어쓴다 (이름별) */
  removeResult?: (name: string, present: boolean) => RunResult | undefined;
  /** `<cli> --version` 응답 */
  versions?: Record<string, RunResult>;
}

/**
 * `claude mcp remove|add-json --scope user` 를 흉내 내는 러너.
 * 실제 CLI 처럼 `<home>/.claude.json` 의 최상위 mcpServers 를 고친다 (멱등성 테스트용).
 */
export function fakeClaudeRunner(home: string, opts: FakeClaudeOptions = {}): { runner: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const file = path.join(home, '.claude.json');
  const runner: CommandRunner = {
    async run(cmd, args) {
      calls.push({ cmd, args: [...args] });
      if (args[0] === '--version') {
        return opts.versions?.[cmd] ?? { code: null, stdout: '', stderr: 'ENOENT' };
      }
      if (cmd !== 'claude' || args[0] !== 'mcp') return { code: 127, stdout: '', stderr: `unknown command ${cmd} ${args.join(' ')}` };
      const raw = await readOrUndefined(file);
      const cfg = (raw ? JSON.parse(raw) : {}) as { mcpServers?: Record<string, unknown> };
      cfg.mcpServers ??= {};
      const name = args[2] ?? '';
      if (args[1] === 'remove') {
        if (args[3] !== '--scope' || args[4] !== 'user') return { code: 2, stdout: '', stderr: 'expected --scope user' };
        const present = name in cfg.mcpServers;
        const override = opts.removeResult?.(name, present);
        if (override) return override;
        if (!present) return { code: 1, stdout: '', stderr: `No MCP server found with name: "${name}" in user config` };
        delete cfg.mcpServers[name];
      } else if (args[1] === 'add-json') {
        if (args[4] !== '--scope' || args[5] !== 'user') return { code: 2, stdout: '', stderr: 'expected --scope user' };
        if (opts.failAddJson) return { code: 1, stdout: '', stderr: 'Error: boom' };
        if (name in cfg.mcpServers) return { code: 1, stdout: '', stderr: `MCP server ${name} already exists in user config` };
        cfg.mcpServers[name] = JSON.parse(args[3] ?? '{}');
      } else {
        return { code: 2, stdout: '', stderr: `unknown subcommand ${args[1]}` };
      }
      await fs.writeFile(file, JSON.stringify(cfg, null, 2) + '\n');
      return { code: 0, stdout: `ok ${args[1]} ${name}`, stderr: '' };
    },
  };
  return { runner, calls };
}
