/**
 * audit — 감사 로그·이벤트 기록 보조. 저장 직전에 16.6 마스킹을 적용한다.
 * - AuditWriter.record: error 를 마스킹하고 LIMITS.auditErrorBytes(4 KiB) 로 자른다. 인자·결과 본문은 받지 않는다.
 * - EventWriter.emit: details 를 maskJson 으로 직렬화·마스킹한다.
 * - RetentionPurger: 17.4 보존 기간 지난 행 삭제.
 */
import { LIMITS, maskJson, type Agent, type AuditEntry, type EventKind, type EventRecord, type Masker } from '@omnicode/shared';
import type { Registry } from '../contracts.js';

export type AuditInput = Omit<AuditEntry, 'id' | 'ts'> & { ts?: string };

export interface AuditWriter {
  record(entry: AuditInput): void;
}

export interface EventInput {
  serverId?: string | null;
  agent?: Agent | null;
  actor: EventRecord['actor'];
  details?: unknown;
  ts?: string;
}

export interface EventWriter {
  emit(kind: EventKind, input: EventInput): void;
}

/** UTF-8 바이트 기준으로 자른다 (멀티바이트 문자 중간에서 끊지 않는다). */
export function truncateBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const marker = '…';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  let out = Buffer.from(s, 'utf8').subarray(0, budget).toString('utf8');
  // 잘린 멀티바이트 꼬리(U+FFFD) 제거
  out = out.replace(/�+$/u, '');
  return out + marker;
}

export function createAuditWriter(registry: Registry, masker: Masker): AuditWriter {
  return {
    record(entry) {
      const error = entry.error === null || entry.error === undefined ? null : truncateBytes(masker.mask(String(entry.error)), LIMITS.auditErrorBytes);
      registry.audit.add({
        ts: entry.ts ?? new Date().toISOString(),
        agent: entry.agent,
        job_id: entry.job_id ?? null,
        server_id: entry.server_id,
        method: entry.method,
        tool: entry.tool ?? null,
        outcome: entry.outcome,
        error_code: entry.error_code ?? null,
        duration_ms: entry.duration_ms ?? null,
        req_bytes: entry.req_bytes ?? null,
        res_bytes: entry.res_bytes ?? null,
        args_sha256: entry.args_sha256 ?? null,
        protocol_version: entry.protocol_version ?? null,
        error,
      });
    },
  };
}

export function createEventWriter(registry: Registry, masker: Masker): EventWriter {
  return {
    emit(kind, input) {
      registry.events.add({
        kind,
        server_id: input.serverId ?? null,
        agent: input.agent ?? null,
        actor: input.actor,
        details: input.details === undefined ? null : maskJson(masker, input.details),
        ts: input.ts,
      });
    },
  };
}

export interface RetentionOptions {
  auditRetentionDays: number;
  eventRetentionDays: number;
}

export interface RetentionPurger {
  purge(now?: Date): { audit: number; events: number; oauthStates: number };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createRetentionPurger(registry: Registry, opts: RetentionOptions): RetentionPurger {
  return {
    purge(now = new Date()) {
      const auditCutoff = new Date(now.getTime() - opts.auditRetentionDays * DAY_MS).toISOString();
      const eventCutoff = new Date(now.getTime() - opts.eventRetentionDays * DAY_MS).toISOString();
      return registry.transaction(() => ({
        audit: registry.audit.purgeOlderThan(auditCutoff),
        events: registry.events.purgeOlderThan(eventCutoff),
        oauthStates: registry.oauthStates.purgeExpired(now.toISOString()),
      }));
    },
  };
}
