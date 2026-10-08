/** 상수 — 설계문서 8.5 기본값, 11.7 타임아웃, 11.10 크기 제한. */

export const HUB_ENTRY_PREFIX = 'omni-';
export const AGENT_TOKEN_PREFIX = 'omh_';
export const SERVER_ID_RE = /^[a-z0-9-]{1,40}$/;
export const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const AGENT_TOKEN_RE = /^omh_[A-Za-z0-9_-]{40,48}$/;

export const MODERN_MIN_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LEGACY_DEFAULT_PROTOCOL_VERSION = '2025-03-26';

export function isModernProtocolVersion(v: string | undefined | null): boolean {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && v >= MODERN_MIN_PROTOCOL_VERSION;
}

export const DEFAULTS = {
  hubHost: '127.0.0.1',
  hubPort: 7410,
  dataDir: '/var/lib/omnicode',
  agentdSocket: '/run/omnicode/agentd.sock',
  secretsPrefix: 'omnicode',
  callTimeoutMs: 600_000,
  idleTimeoutMs: 300_000,
  connectTimeoutMs: 10_000,
  initializeTimeoutMs: 30_000,
  listTimeoutMs: 30_000,
  healthIntervalMs: 600_000,
  auditRetentionDays: 30,
  eventRetentionDays: 180,
  agentTokenGraceMs: 900_000,
  oauthStateTtlMs: 600_000,
  refreshAheadMs: 300_000,
  refreshAtCallAheadMs: 60_000,
  syntheticProgressIntervalMs: 60_000,
  maxConcurrentCallsPerServer: 8,
  queueWaitMs: 30_000,
  rateLimitPerMinute: 120,
  downstreamSessionIdleMs: 24 * 60 * 60 * 1000,
} as const;

export const LIMITS = {
  downstreamBodyBytes: 4 * 1024 * 1024,
  metadataDocBytes: 256 * 1024,
  toolsListBytes: 4 * 1024 * 1024,
  callResultBytes: 32 * 1024 * 1024,
  auditErrorBytes: 4 * 1024,
  maxRedirects: 5,
} as const;
