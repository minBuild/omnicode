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
  /** 인증 구현이 없다 — main.ts는 시작을 거부한다 */
  | { mode: 'unconfigured' };

export type ApiConfig = {
  host: string;
  port: number;
  publicUrl: string | null;
  auth: AuthConfig;
  webDir: string;
};

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

function loadAuth(env: Record<string, string | undefined>): AuthConfig {
  const token = str(env.OMNICODE_DEV_TOKEN);
  if (token !== undefined) {
    if (token.length < MIN_DEV_TOKEN_LENGTH) {
      throw new ApiConfigError(`OMNICODE_DEV_TOKEN은 ${MIN_DEV_TOKEN_LENGTH}자 이상이어야 합니다`);
    }
    return { mode: 'dev', token, generated: false };
  }
  if (str(env.OMNICODE_AUTH_MODE) === 'dev') {
    return { mode: 'dev', token: randomBytes(24).toString('base64url'), generated: true };
  }
  return { mode: 'unconfigured' };
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
    auth: loadAuth(env),
    webDir: str(env.OMNICODE_WEB_DIR) ?? defaultWebDir(),
  };
}
