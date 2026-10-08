import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from '@omnicode/shared';
import { buildApp, type AuthHooks, type BuildAppOptions } from '../src/index.js';
import { FakeHub } from './fakeHub.js';

export const SESSION_HEADER = 'x-test-session';
export const RECENT_HEADER = 'x-test-recent';

/** 테스트용 훅: `x-test-session` 헤더가 세션 ID, `x-test-recent: 1`이 최근 재인증 */
export function testAuthHooks(): AuthHooks {
  const sessionIdOf = (req: FastifyRequest): string | null => {
    const v = req.headers[SESSION_HEADER];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  return {
    sessionIdOf,
    requireSession: async (req) => {
      if (sessionIdOf(req) === null) throw new ApiError('unauthenticated', '로그인이 필요합니다.');
    },
    requireRecentAuth: async (req) => {
      if (req.headers[RECENT_HEADER] !== '1') throw new ApiError('reauth_required', '재인증이 필요합니다.');
    },
  };
}

export const authed = { [SESSION_HEADER]: 'sess-1' };
export const recent = { ...authed, [RECENT_HEADER]: '1' };

export interface TestApp {
  app: FastifyInstance;
  hub: FakeHub;
}

export function makeApp(over: Partial<Omit<BuildAppOptions, 'hub'>> & { hub?: FakeHub } = {}): TestApp {
  const hub = over.hub ?? new FakeHub();
  const app = buildApp({ auth: testAuthHooks(), publicUrl: 'https://omni.example', ...over, hub });
  return { app, hub };
}

export function json<T = unknown>(res: { body: string }): T {
  return JSON.parse(res.body) as T;
}

export interface ErrorResponse {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
