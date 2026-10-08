/**
 * Claude Code 어댑터 (설계 12.3, 12.7).
 * - 서버 항목: user scope `~/.claude.json`의 `mcpServers`. Claude Code 자신이 쓰는 파일이라 직접 편집하지 않고
 *   `claude mcp remove` / `claude mcp add-json --scope user` 로 바꾼다. 읽기는 diff 계산과 적용 뒤 확인(D4)에만 쓴다.
 * - 자동 승인: `~/.claude/settings.json` → `permissions.allow`의 `mcp__omni-<id>`. 주석을 보존하며 부분 편집한다.
 */
import path from 'node:path';
import type { DesiredAgentConfig, DesiredEntry, SyncResult } from '@omnicode/shared';
import { AgentdError } from '../errors.js';
import { readTextIfExists, writeFileAtomic } from '../fsutil.js';
import { detectFormat, JsoncParseError, parseJsonc, removeValue, setValue } from '../jsonc-edit.js';
import type { CommandRunner } from '../runner.js';
import { classify, isHubEntryName, isRecord, type Adapter, type SyncPlan } from './types.js';

/** 설계 8.2: Claude Code headersHelper 실행 파일 (절대 경로로 등록한다) */
export const CLAUDE_HEADERS_HELPER = '/usr/local/bin/omnicode-hub-headers';
const PERMISSION_PREFIX = 'mcp__';
const NOT_FOUND_RE = /not found|no mcp server|does not exist|doesn't exist/i;

export interface ClaudeAdapterOptions {
  home: string;
  runner: CommandRunner;
  /** 기본 `claude` (PATH) */
  claudeBin?: string;
  headersHelper?: string;
  /** CLI 호출 하나의 제한 시간. 기본 30초 */
  cliTimeoutMs?: number;
}

export function claudeConfigPath(home: string): string {
  return path.join(home, '.claude.json');
}
export function claudeSettingsPath(home: string): string {
  return path.join(home, '.claude', 'settings.json');
}
export function permissionName(entryName: string): string {
  return PERMISSION_PREFIX + entryName;
}

interface ServerEntry {
  type?: unknown;
  url?: unknown;
  headersHelper?: unknown;
  timeout?: unknown;
}

interface SettingsState {
  text: string | undefined;
  /** `permissions.allow` 배열. 없으면 undefined */
  allow: string[] | undefined;
}

interface ClaudePlan {
  plan: SyncPlan;
  /** CLI로 다시 등록할 항목 */
  cliWrites: DesiredEntry[];
  /** CLI로 지울 항목 */
  cliRemoves: string[];
  /** 그 이름이 현재 ~/.claude.json 에 있는지 (remove 실패를 무시할지 판단) */
  present: Set<string>;
  allowAdd: string[];
  allowRemove: string[];
  settings: SettingsState;
}

export function createClaudeAdapter(opts: ClaudeAdapterOptions): Adapter {
  const home = opts.home;
  const runner = opts.runner;
  const bin = opts.claudeBin ?? 'claude';
  const helper = opts.headersHelper ?? CLAUDE_HEADERS_HELPER;
  const cliTimeoutMs = opts.cliTimeoutMs ?? 30_000;
  const configPath = claudeConfigPath(home);
  const settingsPath = claudeSettingsPath(home);

  function serverJson(entry: DesiredEntry): string {
    return JSON.stringify({ type: 'http', url: entry.url, headersHelper: helper, timeout: entry.timeoutMs });
  }

  function sameServer(entry: DesiredEntry, cur: ServerEntry): boolean {
    return cur.type === 'http' && cur.url === entry.url && cur.headersHelper === helper && cur.timeout === entry.timeoutMs;
  }

  async function readServers(): Promise<Map<string, ServerEntry>> {
    const text = await readTextIfExists(configPath);
    const servers = new Map<string, ServerEntry>();
    if (text === undefined || text.trim() === '') return servers;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new AgentdError('adapter_error', `${configPath}: invalid JSON (${(e as Error).message})`);
    }
    if (!isRecord(parsed)) throw new AgentdError('adapter_error', `${configPath}: root is not an object`);
    const mcpServers = parsed['mcpServers'];
    if (mcpServers === undefined) return servers;
    if (!isRecord(mcpServers)) throw new AgentdError('adapter_error', `${configPath}: mcpServers is not an object`);
    for (const [name, value] of Object.entries(mcpServers)) {
      if (isHubEntryName(name)) servers.set(name, isRecord(value) ? (value as ServerEntry) : {});
    }
    return servers;
  }

  async function readSettings(): Promise<SettingsState> {
    const text = await readTextIfExists(settingsPath);
    if (text === undefined || text.trim() === '') return { text, allow: undefined };
    let parsed: unknown;
    try {
      parsed = parseJsonc(text);
    } catch (e) {
      const detail = e instanceof JsoncParseError ? e.message : String(e);
      throw new AgentdError('adapter_error', `${settingsPath}: ${detail}`);
    }
    if (!isRecord(parsed)) throw new AgentdError('adapter_error', `${settingsPath}: root is not an object`);
    const permissions = parsed['permissions'];
    if (permissions === undefined) return { text, allow: undefined };
    if (!isRecord(permissions)) throw new AgentdError('adapter_error', `${settingsPath}: permissions is not an object`);
    const allow = permissions['allow'];
    if (allow === undefined) return { text, allow: undefined };
    if (!Array.isArray(allow)) throw new AgentdError('adapter_error', `${settingsPath}: permissions.allow is not an array`);
    return { text, allow: allow.map((x) => (typeof x === 'string' ? x : '')) };
  }

  async function computePlan(desired: DesiredAgentConfig): Promise<ClaudePlan> {
    const servers = await readServers();
    const settings = await readSettings();
    const allowSet = new Set(settings.allow ?? []);

    const c = classify(desired, servers, sameServer);
    const plan = c.plan;
    const cliWrites = c.toWrite;

    // 권한만 다른 항목도 updated 로 센다 (CLI 호출은 없다)
    const wantAllow = new Set(desired.entries.filter((e) => e.autoApprove).map((e) => permissionName(e.name)));
    const unchanged: string[] = [];
    for (const name of plan.unchanged) {
      const entry = desired.entries.find((e) => e.name === name)!;
      if (allowSet.has(permissionName(name)) === entry.autoApprove) unchanged.push(name);
      else plan.updated.push(name);
    }
    plan.unchanged = unchanged;

    const allowAdd = [...wantAllow].filter((p) => !allowSet.has(p));
    // desired 에 없는 모든 mcp__omni-* 권한은 지운다 (지워진 서버·꺼진 자동 승인·남은 찌꺼기)
    const allowRemove = [...allowSet].filter((p) => p.startsWith(PERMISSION_PREFIX) && isHubEntryName(p.slice(PERMISSION_PREFIX.length)) && !wantAllow.has(p));

    return { plan, cliWrites, cliRemoves: c.toRemove, present: new Set(servers.keys()), allowAdd, allowRemove, settings };
  }

  async function cli(args: string[]): Promise<{ code: number | null; output: string }> {
    const r = await runner.run(bin, args, { env: { ...process.env, HOME: home }, cwd: home, timeoutMs: cliTimeoutMs });
    return { code: r.code, output: [r.stdout, r.stderr].map((s) => s.trim()).filter(Boolean).join('\n') };
  }

  async function cliRemove(name: string, present: boolean): Promise<void> {
    const r = await cli(['mcp', 'remove', name, '--scope', 'user']);
    if (r.code === 0) return;
    if (!present || NOT_FOUND_RE.test(r.output)) return; // 없는 항목을 지우는 실패는 무시
    throw new AgentdError('cli_error', `claude mcp remove ${name} failed (exit ${r.code ?? 'none'}): ${r.output}`);
  }

  async function cliAddJson(entry: DesiredEntry): Promise<void> {
    const r = await cli(['mcp', 'add-json', entry.name, serverJson(entry), '--scope', 'user']);
    if (r.code === 0) return;
    throw new AgentdError('cli_error', `claude mcp add-json ${entry.name} failed (exit ${r.code ?? 'none'}): ${r.output}`);
  }

  /**
   * CLI 가 exit 0 을 돌려줘도 실제로 반영됐는지 ~/.claude.json 을 다시 읽어 확인한다 (D4, 확인[P2]).
   * Claude Code 는 실행 중인 세션이 이 파일을 통째로 다시 쓰기도 하므로 변경이 사라질 수 있다.
   * 추가·수정한 항목은 최상위 mcpServers 에 있고 url 이 같아야 하며, 지운 항목은 없어야 한다.
   */
  async function verifyApplied(writes: DesiredEntry[], removes: string[]): Promise<void> {
    if (writes.length === 0 && removes.length === 0) return;
    const servers = await readServers();
    const problems: string[] = [];
    for (const entry of writes) {
      const cur = servers.get(entry.name);
      if (cur === undefined) problems.push(`${entry.name} is missing from mcpServers after claude mcp add-json`);
      else if (cur.url !== entry.url) problems.push(`${entry.name} has url ${JSON.stringify(cur.url)} after claude mcp add-json (expected ${JSON.stringify(entry.url)})`);
    }
    for (const name of removes) {
      if (servers.has(name)) problems.push(`${name} is still in mcpServers after claude mcp remove`);
    }
    if (problems.length > 0) throw new AgentdError('cli_error', `${configPath} does not reflect the claude mcp changes: ${problems.join('; ')}`);
  }

  async function writeSettings(state: SettingsState, add: string[], remove: string[]): Promise<void> {
    if (add.length === 0 && remove.length === 0) return;
    let text = state.text;
    if (text === undefined || text.trim() === '') {
      if (add.length === 0) return;
      text = JSON.stringify({ permissions: { allow: add } }, null, 2) + '\n';
    } else {
      const fmt = detectFormat(text);
      const allow = state.allow ?? [];
      const removeSet = new Set(remove);
      for (let i = allow.length - 1; i >= 0; i--) {
        if (removeSet.has(allow[i]!)) text = removeValue(text, ['permissions', 'allow', i]);
      }
      if (add.length > 0) {
        if (state.allow === undefined) text = setValue(text, ['permissions', 'allow'], add, fmt);
        else for (const p of add) text = setValue(text, ['permissions', 'allow', -1], p, fmt);
      }
      parseJsonc(text); // 자기 검증: 깨진 파일은 쓰지 않는다
    }
    await writeFileAtomic(settingsPath, text);
  }

  return {
    agent: 'claude',
    async plan(desired) {
      return (await computePlan(desired)).plan;
    },
    async apply(desired): Promise<SyncResult> {
      const p = await computePlan(desired);
      for (const entry of p.cliWrites) {
        await cliRemove(entry.name, p.present.has(entry.name));
        await cliAddJson(entry);
      }
      for (const name of p.cliRemoves) {
        await cliRemove(name, true);
      }
      // 반영이 확인되지 않으면 자동 승인(settings.json)도 쓰지 않는다
      await verifyApplied(p.cliWrites, p.cliRemoves);
      await writeSettings(p.settings, p.allowAdd, p.allowRemove);
      return p.plan;
    },
  };
}
