/**
 * 8.5 설정 로더. /etc/omnicode/omnicode.env 가 systemd 를 거쳐 환경변수로 들어온다. 비밀값은 여기 없다.
 * 잘못된 값은 모아서 HubConfigError 하나로 던진다 (문제 목록 포함).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DEFAULTS } from '@omnicode/shared';
import type { HubConfig } from './contracts.js';
import { parseAllowEntries } from './net/ipRanges.js';

/** 설정 키 ↔ 환경변수 이름 */
export const ENV = {
  publicUrl: 'OMNICODE_PUBLIC_URL',
  hubPort: 'OMNICODE_HUB_PORT',
  dataDir: 'OMNICODE_DATA_DIR',
  agentdSocket: 'OMNICODE_AGENTD_SOCKET',
  secretsPrefix: 'OMNICODE_SECRETS_PREFIX',
  secretsBackend: 'OMNICODE_SECRETS_BACKEND',
  fileSecretsDir: 'OMNICODE_FILE_SECRETS_DIR',
  callTimeoutMs: 'OMNICODE_MCP_CALL_TIMEOUT_MS',
  idleTimeoutMs: 'OMNICODE_MCP_IDLE_TIMEOUT_MS',
  allowPrivateHosts: 'OMNICODE_MCP_ALLOW_PRIVATE_HOSTS',
  allowHttpLoopback: 'OMNICODE_MCP_ALLOW_HTTP_LOOPBACK',
  auditRetentionDays: 'OMNICODE_AUDIT_RETENTION_DAYS',
  eventRetentionDays: 'OMNICODE_EVENT_RETENTION_DAYS',
  agentTokenGraceMs: 'OMNICODE_AGENT_TOKEN_GRACE_MS',
  healthIntervalMs: 'OMNICODE_HEALTH_INTERVAL_MS',
  presetsDir: 'OMNICODE_PRESETS_DIR',
} as const;

export class HubConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid hub configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'HubConfigError';
  }
}

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url)); // src/ 와 dist/ 모두 packages/hub 바로 아래
const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off', '']);

export function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function defaultPresetsDir(): string {
  return path.resolve(PACKAGE_DIR, '..', '..', 'presets');
}

function readStr(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

function readInt(env: NodeJS.ProcessEnv, key: string, problems: string[]): number | undefined {
  const v = readStr(env, key);
  if (v === undefined) return undefined;
  if (!/^\d{1,15}$/.test(v)) {
    problems.push(`${key}: expected a non-negative integer, got ${JSON.stringify(v)}`);
    return undefined;
  }
  return Number(v);
}

function readBool(env: NodeJS.ProcessEnv, key: string, problems: string[]): boolean | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(v)) return true;
  if (FALSE_WORDS.has(v)) return false;
  problems.push(`${key}: expected 1/0 (true/false), got ${JSON.stringify(raw)}`);
  return undefined;
}

function readList(env: NodeJS.ProcessEnv, key: string): string[] {
  const v = readStr(env, key);
  if (v === undefined) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const absolutePath = (what: string) => z.string().min(1).refine((p) => path.isAbsolute(p), { message: `${what} must be an absolute path` });

const HubConfigSchema = z.object({
  publicUrl: z.string().nullable(),
  hubHost: z.literal('127.0.0.1'),
  hubPort: z.number().int().min(1).max(65535),
  dataDir: absolutePath('data dir'),
  agentdSocket: absolutePath('agentd socket'),
  secretsPrefix: z.string().regex(/^[A-Za-z0-9_+=.@-]+(\/[A-Za-z0-9_+=.@-]+)*$/, 'secrets prefix may contain letters, digits, /_+=.@- and no leading/trailing slash'),
  secretsBackend: z.enum(['aws', 'file', 'memory']),
  fileSecretsDir: absolutePath('file secrets dir'),
  callTimeoutMs: z.number().int().min(5_000).max(24 * 60 * 60 * 1000),
  idleTimeoutMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1000),
  allowPrivateHosts: z.array(z.string().min(1)),
  allowHttpLoopback: z.boolean(),
  auditRetentionDays: z.number().int().min(1).max(3650),
  eventRetentionDays: z.number().int().min(1).max(3650),
  agentTokenGraceMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
  healthIntervalMs: z.number().int().min(5_000).max(24 * 60 * 60 * 1000),
  presetsDir: absolutePath('presets dir'),
  version: z.string().min(1),
});

/** OMNICODE_PUBLIC_URL 정규화: https 만 (allowHttpLoopback 이면 루프백 http 허용), 끝 슬래시 제거 */
function normalizePublicUrl(raw: string | undefined, allowHttpLoopback: boolean, problems: string[]): string | null {
  if (raw === undefined) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    problems.push(`${ENV.publicUrl}: not a valid URL (${JSON.stringify(raw)})`);
    return null;
  }
  const loopback = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(allowHttpLoopback && loopback)) {
    problems.push(`${ENV.publicUrl}: must be an https URL`);
    return null;
  }
  if (u.search || u.hash || u.username || u.password) {
    problems.push(`${ENV.publicUrl}: must not contain query, fragment or credentials`);
    return null;
  }
  return u.origin + u.pathname.replace(/\/+$/, '');
}

export function loadHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const problems: string[] = [];

  const dataDir = readStr(env, ENV.dataDir) ?? DEFAULTS.dataDir;
  const allowHttpLoopback = readBool(env, ENV.allowHttpLoopback, problems) ?? false;
  const allowPrivateHosts = readList(env, ENV.allowPrivateHosts);
  try {
    parseAllowEntries(allowPrivateHosts);
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  const secretsBackendRaw = readStr(env, ENV.secretsBackend) ?? 'aws';

  const candidate = {
    publicUrl: normalizePublicUrl(readStr(env, ENV.publicUrl), allowHttpLoopback, problems),
    hubHost: DEFAULTS.hubHost,
    hubPort: readInt(env, ENV.hubPort, problems) ?? DEFAULTS.hubPort,
    dataDir,
    agentdSocket: readStr(env, ENV.agentdSocket) ?? DEFAULTS.agentdSocket,
    secretsPrefix: readStr(env, ENV.secretsPrefix) ?? DEFAULTS.secretsPrefix,
    secretsBackend: secretsBackendRaw.toLowerCase(),
    fileSecretsDir: readStr(env, ENV.fileSecretsDir) ?? path.join(dataDir, 'secrets'),
    callTimeoutMs: readInt(env, ENV.callTimeoutMs, problems) ?? DEFAULTS.callTimeoutMs,
    idleTimeoutMs: readInt(env, ENV.idleTimeoutMs, problems) ?? DEFAULTS.idleTimeoutMs,
    allowPrivateHosts,
    allowHttpLoopback,
    auditRetentionDays: readInt(env, ENV.auditRetentionDays, problems) ?? DEFAULTS.auditRetentionDays,
    eventRetentionDays: readInt(env, ENV.eventRetentionDays, problems) ?? DEFAULTS.eventRetentionDays,
    agentTokenGraceMs: readInt(env, ENV.agentTokenGraceMs, problems) ?? DEFAULTS.agentTokenGraceMs,
    healthIntervalMs: readInt(env, ENV.healthIntervalMs, problems) ?? DEFAULTS.healthIntervalMs,
    presetsDir: readStr(env, ENV.presetsDir) ?? defaultPresetsDir(),
    version: readPackageVersion(),
  };

  const parsed = HubConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path.map(String).join('.');
      const envName = (ENV as Record<string, string>)[key];
      problems.push(`${envName ?? key}: ${issue.message}`);
    }
  }
  if (problems.length) throw new HubConfigError(problems);
  // safeParse 가 성공했으므로 parsed.data 가 있다
  const data = (parsed as { data: z.infer<typeof HubConfigSchema> }).data;
  return { ...data, hubHost: '127.0.0.1' };
}
