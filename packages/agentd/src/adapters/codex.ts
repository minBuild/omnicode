/**
 * Codex CLI 어댑터 (설계 12.4).
 * `~/.codex/config.toml`의 `[mcp_servers.omni-*]` 블록만 텍스트 수준에서 치환·추가·삭제한다.
 * 블록 = 헤더 줄부터 다음 `[` 테이블 헤더 직전 줄까지. 다른 바이트는 그대로 두고,
 * 결과를 smol-toml 로 파싱해 통과할 때만 쓴다 (P11).
 */
import path from 'node:path';
import { parse as parseToml, TomlError } from 'smol-toml';
import type { DesiredAgentConfig, DesiredEntry, SyncResult } from '@omnicode/shared';
import { AgentdError } from '../errors.js';
import { readTextIfExists, writeFileAtomic } from '../fsutil.js';
import { classify, isRecord, type Adapter, type SyncPlan } from './types.js';

export const CODEX_BEARER_TOKEN_ENV = 'OMNICODE_HUB_TOKEN_CODEX';
export const CODEX_JOB_HEADER = 'X-OmniCode-Job';
export const CODEX_JOB_ENV = 'OMNICODE_JOB_ID';
export const CODEX_STARTUP_TIMEOUT_SEC = 30;

export interface CodexAdapterOptions {
  home: string;
}

export function codexConfigPath(home: string): string {
  return path.join(home, '.codex', 'config.toml');
}

export function toolTimeoutSec(timeoutMs: number): number {
  return Math.ceil(timeoutMs / 1000);
}

/** 어떤 테이블 헤더든 (`[x]`, `[[x]]`) — 블록 경계 */
const ANY_HEADER_RE = /^\s*\[\[?[^\]]*\]\]?\s*(#.*)?$/;
/** `[mcp_servers.omni-<id>]` 와 그 하위 테이블 `[mcp_servers.omni-<id>.<sub>]` */
const OMNI_HEADER_RE = /^\s*\[\s*mcp_servers\s*\.\s*(?:"(omni-[^"\\]+)"|'(omni-[^']+)'|(omni-[A-Za-z0-9_-]+))\s*(\.[^\]]*)?\]\s*(#.*)?$/;
const BLANK_OR_COMMENT_RE = /^\s*(#.*)?$/;

interface Block {
  /** 줄 인덱스 [start, end) */
  start: number;
  end: number;
  /** 헤더+본문 끝 (마지막 키/값 줄 다음). 그 뒤는 꼬리(빈 줄·주석) */
  bodyEnd: number;
  /** 본문 뒤 빈 줄들의 끝. [gapEnd, end) 는 다음 테이블의 것일 수 있는 주석 — 보존한다 */
  gapEnd: number;
  /** omni-* 항목 이름 (관리 대상일 때만) */
  name?: string;
  /** 하위 테이블 헤더(`[mcp_servers.omni-x.sub]`)이면 true */
  sub?: boolean;
}

interface CurrentEntry {
  /** 첫 (대표) 블록 */
  primary: Block;
  /** 같은 이름의 다른 블록 (중복·하위 테이블) — 갱신·삭제 시 함께 지운다 */
  extras: Block[];
  parsed: Record<string, unknown> | undefined;
}

/** 줄 끝 문자를 유지한 채 줄로 나눈다. 다시 이어 붙이면 원문과 같다. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
function stripEol(line: string): string {
  return line.replace(/\r?\n$/, '');
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name);
}

export function renderCodexBlock(entry: DesiredEntry, eol = '\n'): string {
  return (
    [
      `[mcp_servers.${tomlKey(entry.name)}]`,
      `url = ${tomlString(entry.url)}`,
      `bearer_token_env_var = ${tomlString(CODEX_BEARER_TOKEN_ENV)}`,
      `env_http_headers = { ${tomlString(CODEX_JOB_HEADER)} = ${tomlString(CODEX_JOB_ENV)} }`,
      `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SEC}`,
      `tool_timeout_sec = ${toolTimeoutSec(entry.timeoutMs)}`,
    ].join(eol) + eol
  );
}

function findBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  const starts: Array<{ start: number; headed: boolean; name?: string; sub?: boolean }> = [];
  lines.forEach((raw, i) => {
    const line = stripEol(raw);
    if (ANY_HEADER_RE.test(line)) {
      const m = OMNI_HEADER_RE.exec(line);
      const name = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
      starts.push({ start: i, headed: true, name, sub: m ? m[4] !== undefined : undefined });
    } else if (starts.length === 0) {
      starts.push({ start: i, headed: false }); // 헤더 앞 루트 키·주석
    }
  });
  starts.forEach((s, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1]!.start : lines.length;
    // 본문 끝 = 마지막 키/값 줄 다음. 헤더만 있으면 헤더 다음
    let bodyEnd = s.headed ? s.start + 1 : s.start;
    for (let i = end - 1; i >= bodyEnd; i--) {
      if (!BLANK_OR_COMMENT_RE.test(stripEol(lines[i]!))) {
        bodyEnd = i + 1;
        break;
      }
    }
    let gapEnd = bodyEnd;
    while (gapEnd < end && stripEol(lines[gapEnd]!).trim() === '') gapEnd++;
    blocks.push({ start: s.start, end, bodyEnd, gapEnd, name: s.name, sub: s.sub });
  });
  return blocks;
}

function parseBlock(lines: string[], block: Block, name: string): Record<string, unknown> | undefined {
  try {
    const parsed = parseToml(lines.slice(block.start, block.bodyEnd).join(''));
    const servers = parsed['mcp_servers'];
    if (!isRecord(servers)) return undefined;
    const entry = servers[name];
    return isRecord(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

function collectCurrent(lines: string[], blocks: Block[]): Map<string, CurrentEntry> {
  const current = new Map<string, CurrentEntry>();
  for (const b of blocks) {
    if (b.name === undefined) continue;
    const existing = current.get(b.name);
    if (existing) {
      existing.extras.push(b);
    } else if (b.sub) {
      // 대표 블록 없이 하위 테이블만 있는 경우: 항목은 있다고 보되 내용은 모른다
      current.set(b.name, { primary: b, extras: [], parsed: undefined });
    } else {
      current.set(b.name, { primary: b, extras: [], parsed: parseBlock(lines, b, b.name) });
    }
  }
  return current;
}

function sameEntry(entry: DesiredEntry, cur: CurrentEntry): boolean {
  if (cur.extras.length > 0 || cur.primary.sub || !cur.parsed) return false;
  const p = cur.parsed;
  const headers = p['env_http_headers'];
  return (
    p['url'] === entry.url &&
    p['bearer_token_env_var'] === CODEX_BEARER_TOKEN_ENV &&
    isRecord(headers) &&
    headers[CODEX_JOB_HEADER] === CODEX_JOB_ENV &&
    p['startup_timeout_sec'] === CODEX_STARTUP_TIMEOUT_SEC &&
    p['tool_timeout_sec'] === toolTimeoutSec(entry.timeoutMs)
  );
}

interface CodexPlan {
  plan: SyncPlan;
  /** 바뀐 전체 텍스트. 바뀌는 것이 없으면 undefined */
  next: string | undefined;
}

export function createCodexAdapter(opts: CodexAdapterOptions): Adapter {
  const configPath = codexConfigPath(opts.home);

  async function computePlan(desired: DesiredAgentConfig): Promise<CodexPlan> {
    const text = (await readTextIfExists(configPath)) ?? '';
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = splitLines(text);
    const blocks = findBlocks(lines);
    const current = collectCurrent(lines, blocks);
    const c = classify(desired, current, sameEntry);
    if (c.toWrite.length === 0 && c.toRemove.length === 0) return { plan: c.plan, next: undefined };

    const replace = new Map<string, DesiredEntry>();
    const append: DesiredEntry[] = [];
    for (const entry of c.toWrite) {
      if (current.has(entry.name)) replace.set(entry.name, entry);
      else append.push(entry);
    }
    const remove = new Set(c.toRemove);

    const out: string[] = [];
    for (const b of blocks) {
      const name = b.name;
      if (name === undefined || (!replace.has(name) && !remove.has(name))) {
        out.push(...lines.slice(b.start, b.end));
        continue;
      }
      const entry = replace.get(name);
      const isPrimary = current.get(name)?.primary === b;
      if (entry && isPrimary && !b.sub) {
        out.push(renderCodexBlock(entry, eol), ...lines.slice(b.bodyEnd, b.end));
      } else {
        // 삭제 (또는 중복·하위 블록): 헤더+본문+빈 줄은 지우고 뒤따르는 주석은 남긴다
        out.push(...lines.slice(b.gapEnd, b.end));
      }
      if (entry && isPrimary && b.sub) {
        // 대표가 하위 테이블뿐이었다면 본문 블록을 새로 붙인다
        append.push(entry);
      }
    }
    let next = out.join('');
    for (const entry of append) {
      if (next.length > 0) {
        if (!next.endsWith('\n')) next += eol;
        if (!next.endsWith(eol + eol) && !next.endsWith('\n\n')) next += eol;
      }
      next += renderCodexBlock(entry, eol);
    }
    validate(next, desired);
    return { plan: c.plan, next: next === text ? undefined : next };
  }

  function validate(next: string, desired: DesiredAgentConfig): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = parseToml(next);
    } catch (e) {
      const detail = e instanceof TomlError ? e.message.split('\n')[0] : String(e);
      throw new AgentdError('adapter_error', `${configPath}: result is not valid TOML, not writing (${detail})`);
    }
    const servers = parsed['mcp_servers'];
    for (const entry of desired.entries) {
      const s = isRecord(servers) ? servers[entry.name] : undefined;
      if (!isRecord(s) || s['url'] !== entry.url) {
        throw new AgentdError('adapter_error', `${configPath}: ${entry.name} would not round-trip, not writing`);
      }
    }
  }

  return {
    agent: 'codex',
    async plan(desired) {
      return (await computePlan(desired)).plan;
    },
    async apply(desired): Promise<SyncResult> {
      const p = await computePlan(desired);
      if (p.next !== undefined) await writeFileAtomic(configPath, p.next);
      return p.plan;
    },
  };
}
