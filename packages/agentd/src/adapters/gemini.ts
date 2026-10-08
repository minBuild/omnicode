/**
 * Gemini CLI 어댑터 (설계 12.5).
 * `~/.gemini/settings.json`의 `mcpServers["omni-<id>"]`만 주석·형식을 보존하며 부분 편집한다.
 * 토큰은 `${OMNICODE_HUB_TOKEN_GEMINI}` 로 두어 평문을 파일에 쓰지 않는다.
 */
import path from 'node:path';
import type { DesiredAgentConfig, DesiredEntry, SyncResult } from '@omnicode/shared';
import { AgentdError } from '../errors.js';
import { readTextIfExists, writeFileAtomic } from '../fsutil.js';
import { detectFormat, JsoncParseError, parseJsonc, removeValue, setValue } from '../jsonc-edit.js';
import { classify, isHubEntryName, isRecord, type Adapter, type SyncPlan } from './types.js';

export const GEMINI_AUTHORIZATION = 'Bearer ${OMNICODE_HUB_TOKEN_GEMINI}';
export const GEMINI_JOB_HEADER = 'X-OmniCode-Job';
export const GEMINI_JOB_VALUE = '${OMNICODE_JOB_ID:-}';

export interface GeminiAdapterOptions {
  home: string;
}

export function geminiSettingsPath(home: string): string {
  return path.join(home, '.gemini', 'settings.json');
}

export interface GeminiServerEntry {
  httpUrl: string;
  headers: { Authorization: string; 'X-OmniCode-Job': string };
  timeout: number;
  trust: boolean;
}

export function renderGeminiEntry(entry: DesiredEntry): GeminiServerEntry {
  return {
    httpUrl: entry.url,
    headers: { Authorization: GEMINI_AUTHORIZATION, [GEMINI_JOB_HEADER]: GEMINI_JOB_VALUE },
    timeout: entry.timeoutMs,
    trust: entry.autoApprove,
  };
}

function sameEntry(entry: DesiredEntry, cur: Record<string, unknown>): boolean {
  const headers = cur['headers'];
  return (
    cur['httpUrl'] === entry.url &&
    isRecord(headers) &&
    headers['Authorization'] === GEMINI_AUTHORIZATION &&
    headers[GEMINI_JOB_HEADER] === GEMINI_JOB_VALUE &&
    cur['timeout'] === entry.timeoutMs &&
    cur['trust'] === entry.autoApprove
  );
}

interface GeminiPlan {
  plan: SyncPlan;
  next: string | undefined;
}

export function createGeminiAdapter(opts: GeminiAdapterOptions): Adapter {
  const settingsPath = geminiSettingsPath(opts.home);

  function readServers(text: string | undefined): Map<string, Record<string, unknown>> {
    const servers = new Map<string, Record<string, unknown>>();
    if (text === undefined || text.trim() === '') return servers;
    let parsed: unknown;
    try {
      parsed = parseJsonc(text);
    } catch (e) {
      const detail = e instanceof JsoncParseError ? e.message : String(e);
      throw new AgentdError('adapter_error', `${settingsPath}: ${detail}`);
    }
    if (!isRecord(parsed)) throw new AgentdError('adapter_error', `${settingsPath}: root is not an object`);
    const mcpServers = parsed['mcpServers'];
    if (mcpServers === undefined) return servers;
    if (!isRecord(mcpServers)) throw new AgentdError('adapter_error', `${settingsPath}: mcpServers is not an object`);
    for (const [name, value] of Object.entries(mcpServers)) {
      if (isHubEntryName(name)) servers.set(name, isRecord(value) ? value : {});
    }
    return servers;
  }

  async function computePlan(desired: DesiredAgentConfig): Promise<GeminiPlan> {
    const text = await readTextIfExists(settingsPath);
    const current = readServers(text);
    const c = classify(desired, current, sameEntry);
    if (c.toWrite.length === 0 && c.toRemove.length === 0) return { plan: c.plan, next: undefined };

    let next = text ?? '';
    const fmt = detectFormat(next);
    for (const name of c.toRemove) next = removeValue(next, ['mcpServers', name]);
    for (const entry of c.toWrite) next = setValue(next, ['mcpServers', entry.name], renderGeminiEntry(entry), fmt);

    // 자기 검증: 결과를 다시 읽어 원하는 항목이 모두 있는지 확인한다
    const check = readServers(next);
    for (const entry of desired.entries) {
      const cur = check.get(entry.name);
      if (!cur || !sameEntry(entry, cur)) {
        throw new AgentdError('adapter_error', `${settingsPath}: ${entry.name} would not round-trip, not writing`);
      }
    }
    return { plan: c.plan, next };
  }

  return {
    agent: 'gemini',
    async plan(desired) {
      return (await computePlan(desired)).plan;
    },
    async apply(desired): Promise<SyncResult> {
      const p = await computePlan(desired);
      if (p.next !== undefined) await writeFileAtomic(settingsPath, p.next);
      return p.plan;
    },
  };
}
