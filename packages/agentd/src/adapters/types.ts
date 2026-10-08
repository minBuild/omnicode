import { HUB_ENTRY_PREFIX, type Agent, type DesiredAgentConfig, type DesiredEntry, type SyncResult } from '@omnicode/shared';
import { AgentdError } from '../errors.js';

/** `sync.plan` 결과. `sync.apply`와 같은 모양이다 (12.2). */
export type SyncPlan = SyncResult;

/**
 * 에이전트별 동기화 어댑터 (12.1 원칙).
 * - `omni-` 접두사 항목만 만들고 고치고 지운다. 다른 항목은 바이트 단위로 보존한다.
 * - plan은 파일을 쓰지 않는다. apply는 diff만 반영한다 (멱등).
 */
export interface Adapter {
  readonly agent: Agent;
  plan(desired: DesiredAgentConfig): Promise<SyncPlan>;
  apply(desired: DesiredAgentConfig): Promise<SyncResult>;
}

export function isHubEntryName(name: string): boolean {
  return name.startsWith(HUB_ENTRY_PREFIX);
}

export interface Classification<T> {
  plan: SyncPlan;
  /** 추가·수정이 필요한 항목 (desired 순서) */
  toWrite: DesiredEntry[];
  /** 지울 현재 항목 이름 (현재 파일 순서) */
  toRemove: string[];
  /** 현재 omni-* 항목 */
  current: Map<string, T>;
}

/** 원하는 상태와 현재 상태(omni-* 만)를 비교해 added/updated/removed/unchanged 로 나눈다. */
export function classify<T>(
  desired: DesiredAgentConfig,
  current: Map<string, T>,
  same: (entry: DesiredEntry, cur: T) => boolean,
): Classification<T> {
  const plan: SyncPlan = { added: [], updated: [], removed: [], unchanged: [] };
  const toWrite: DesiredEntry[] = [];
  const seen = new Set<string>();
  for (const entry of desired.entries) {
    if (!isHubEntryName(entry.name)) throw new AgentdError('invalid_request', `entry name must start with ${HUB_ENTRY_PREFIX}: ${entry.name}`);
    if (seen.has(entry.name)) throw new AgentdError('invalid_request', `duplicate entry name: ${entry.name}`);
    seen.add(entry.name);
    const cur = current.get(entry.name);
    if (cur === undefined) {
      plan.added.push(entry.name);
      toWrite.push(entry);
    } else if (!same(entry, cur)) {
      plan.updated.push(entry.name);
      toWrite.push(entry);
    } else {
      plan.unchanged.push(entry.name);
    }
  }
  const toRemove: string[] = [];
  for (const name of current.keys()) {
    if (!isHubEntryName(name) || seen.has(name)) continue;
    plan.removed.push(name);
    toRemove.push(name);
  }
  return { plan, toWrite, toRemove, current };
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
