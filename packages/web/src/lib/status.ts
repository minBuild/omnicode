/** 상태 → 배지 문구·색 매핑 (15장). DOM에 의존하지 않는 순수 함수만 둔다. */
import type { Agent, ServerDetail, ServerStatus, ServerSummary, SyncStatus, ToolAnnotations } from '@omnicode/shared';
import { badgeLabels, scopeStepUpLabel, statusLabels, syncLabels, syncNoneLabel } from '../i18n/ko';

export type BadgeTone = 'ok' | 'warn' | 'danger' | 'muted' | 'info';

export const STATUS_TONES: Record<ServerStatus, BadgeTone> = {
  draft: 'info',
  needs_auth: 'warn',
  pending_approval: 'info',
  active: 'ok',
  changed: 'warn',
  error: 'danger',
  disabled: 'muted',
  deleting: 'danger',
};

export function statusLabel(status: ServerStatus, opts: { scopeStepUp?: boolean } = {}): string {
  if (status === 'needs_auth' && opts.scopeStepUp) return scopeStepUpLabel;
  return statusLabels[status];
}

export function statusTone(status: ServerStatus): BadgeTone {
  return STATUS_TONES[status];
}

/** 10.3 scope step-up: 허용된 scope가 있는데 요청 scope가 더 넓으면 "추가 권한 필요". */
export function needsMoreScope(auth: Pick<ServerDetail['auth'], 'requestedScope' | 'grantedScope'>, status: ServerStatus): boolean {
  if (status !== 'needs_auth') return false;
  const requested = scopeSet(auth.requestedScope);
  const granted = scopeSet(auth.grantedScope);
  if (granted.size === 0 || requested.size === 0) return false;
  for (const s of requested) if (!granted.has(s)) return true;
  return false;
}

function scopeSet(s: string | null): Set<string> {
  return new Set((s ?? '').split(/\s+/).filter(Boolean));
}

const SCOPE_BADGES = new Set(['scope_stepup', 'insufficient_scope', 'needs_scope']);

/** 목록 카드의 배지 문구. 요약 DTO에는 scope 정보가 없으므로 badges[]로 판단한다. */
export function summaryStatusLabel(s: Pick<ServerSummary, 'status' | 'badges'>): string {
  const scopeStepUp = s.status === 'needs_auth' && s.badges.some((b) => SCOPE_BADGES.has(b));
  return statusLabel(s.status, { scopeStepUp });
}

/** 상태 배지와 겹치는 값을 뺀 나머지 배지 문구 (모르는 값은 원문 그대로). */
export function extraBadgeLabels(badges: string[]): string[] {
  const out: string[] = [];
  for (const b of badges) {
    if (SCOPE_BADGES.has(b)) continue;
    if ((Object.keys(statusLabels) as string[]).includes(b)) continue;
    const label = badgeLabels[b] ?? b;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

export function syncLabel(status: SyncStatus | null): string {
  return status ? syncLabels[status] : syncNoneLabel;
}

export function syncTone(status: SyncStatus | null, enabled: boolean): BadgeTone {
  if (!enabled) return 'muted';
  if (status === 'synced') return 'ok';
  if (status === 'failed') return 'danger';
  if (status === 'pending') return 'warn';
  return 'muted';
}

export function isDestructive(annotations: ToolAnnotations | null | undefined): boolean {
  return annotations?.destructiveHint === true;
}

/** 승인 화면의 기본 선택: 파괴적 도구는 꺼짐, 나머지는 켜짐 (15장 2번). */
export function defaultToolSelection(tools: ReadonlyArray<{ name: string; annotations: ToolAnnotations | null }>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const t of tools) out[t.name] = !isDestructive(t.annotations);
  return out;
}

export const ALL_AGENTS: readonly Agent[] = ['claude', 'codex', 'gemini'];

/** 에이전트 선택 기본값: 프리셋 defaultAgents → 서버 바인딩 → 전체. */
export function defaultAgentSelection(
  presetAgents: readonly Agent[] | undefined,
  bindings: Partial<Record<Agent, { enabled: boolean }>> | undefined,
): Record<Agent, boolean> {
  const sel: Record<Agent, boolean> = { claude: false, codex: false, gemini: false };
  if (presetAgents && presetAgents.length > 0) {
    for (const a of presetAgents) sel[a] = true;
    return sel;
  }
  if (bindings && ALL_AGENTS.some((a) => bindings[a]?.enabled)) {
    for (const a of ALL_AGENTS) sel[a] = bindings[a]?.enabled === true;
    return sel;
  }
  for (const a of ALL_AGENTS) sel[a] = true;
  return sel;
}

/** 16.3: 인가 URL은 https만. 화면은 받은 URL의 스킴을 다시 확인한 뒤에만 이동한다. */
export function isHttpsUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.hostname.length > 0;
}

export const SERVER_ID_RE = /^[a-z0-9-]{1,40}$/;

export function isValidServerId(id: string): boolean {
  return SERVER_ID_RE.test(id);
}
