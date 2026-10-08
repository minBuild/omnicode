/**
 * API 프로세스 설정 (환경변수). Hub 설정(8.5)은 @omnicode/hub의 loadHubConfig가 따로 읽는다.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MIN_DEV_TOKEN_LENGTH } from './auth.js';
import { normalizePublicUrl } from './cimd.js';

export const DEFAULT_API_HOST = '127.0.0.1';
export const DEFAULT_API_PORT = 8080;

export type AuthConfig =
  /** DEV ONLY. `generated`면 OMNICODE_AUTH_MODE=dev 로 시작하면서 토큰을 즉석에서 만든 것 */
  | { mode: 'dev'; token: string; generated: boolean }
  /** 운영 기본값: 패스키 + 세션 쿠키 (설계 0002). OMNICODE_PUBLIC_URL 이 필요하다 */
  | { mode: 'session'; idleDays: number; maxDays: number };

export type ApiConfig = {
  host: string;
  port: number;
  publicUrl: string | null;
  auth: AuthConfig;
  webDir: string;
  /** OMNICODE_WEB_LIVE=1: 정적 파일을 요청 시점에 찾는다 (개발용) */
  webLive: boolean;
};

export const DEFAULT_SESSION_IDLE_DAYS = 7;
export const DEFAULT_SESSION_MAX_DAYS = 30;

export class ApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiConfigError';
  }
}

/** `<repo>/packages/web/dist` — 이 파일이 src/ 또는 dist/ 어디서 실행돼도 같은 곳을 가리킨다 */
export function defaultWebDir(): string {
  return fileURLToPath(new URL('../../web/dist', import.meta.url));
}

const str = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_API_PORT;
  const n = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ApiConfigError(`OMNICODE_API_PORT가 올바르지 않습니다: ${raw}`);
  return n;
}

function parseDays(name: string, raw: string | undefined, def: number, max: number): number {
  if (raw === undefined) return def;
  const n = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ApiConfigError(`${name}는 1~${max} 사이 정수여야 합니다: ${raw}`);
  return n;
}

function parseBool(raw: string | undefined): boolean {
  return raw !== undefined && ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function loadAuth(env: Record<string, string | undefined>, publicUrl: string | null): AuthConfig {
  const mode = str(env.OMNICODE_AUTH_MODE);
  if (mode !== undefined && mode !== 'session' && mode !== 'dev') {
    throw new ApiConfigError(`OMNICODE_AUTH_MODE는 session 또는 dev 여야 합니다: ${mode}`);
  }
  const token = str(env.OMNICODE_DEV_TOKEN);
  if (mode === 'dev' || (mode === undefined && token !== undefined)) {
    if (token !== undefined) {
      if (token.length < MIN_DEV_TOKEN_LENGTH) {
        throw new ApiConfigError(`OMNICODE_DEV_TOKEN은 ${MIN_DEV_TOKEN_LENGTH}자 이상이어야 합니다`);
      }
      return { mode: 'dev', token, generated: false };
    }
    return { mode: 'dev', token: randomBytes(24).toString('base64url'), generated: true };
  }
  // session (기본값)
  if (publicUrl === null) {
    throw new ApiConfigError(
      'session 인증 모드에는 OMNICODE_PUBLIC_URL 이 필요합니다 (패스키 RP ID·origin, 설계 0002 7장). 개발 중이면 OMNICODE_AUTH_MODE=dev 를 쓰세요.',
    );
  }
  const idleDays = parseDays('OMNICODE_SESSION_IDLE_DAYS', str(env.OMNICODE_SESSION_IDLE_DAYS), DEFAULT_SESSION_IDLE_DAYS, 90);
  const maxDays = parseDays('OMNICODE_SESSION_MAX_DAYS', str(env.OMNICODE_SESSION_MAX_DAYS), DEFAULT_SESSION_MAX_DAYS, 365);
  if (maxDays < idleDays) throw new ApiConfigError('OMNICODE_SESSION_MAX_DAYS는 OMNICODE_SESSION_IDLE_DAYS 이상이어야 합니다');
  return { mode: 'session', idleDays, maxDays };
}

export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const publicUrlRaw = str(env.OMNICODE_PUBLIC_URL);
  let publicUrl: string | null = null;
  if (publicUrlRaw !== undefined) {
    try {
      publicUrl = normalizePublicUrl(publicUrlRaw);
    } catch (err) {
      throw new ApiConfigError(err instanceof Error ? err.message : String(err));
    }
  }
  return {
    host: str(env.OMNICODE_API_HOST) ?? DEFAULT_API_HOST,
    port: parsePort(str(env.OMNICODE_API_PORT)),
    publicUrl,
    auth: loadAuth(env, publicUrl),
    webDir: str(env.OMNICODE_WEB_DIR) ?? defaultWebDir(),
    webLive: parseBool(str(env.OMNICODE_WEB_LIVE)),
  };
}
