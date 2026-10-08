/** 운영 인증 (설계 0002) 진입점 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthHooks } from '../auth.js';
import { createAuthService, type AuthLogger, type AuthService } from './service.js';
import { createSessionAuthHooks, type SessionAuthOptions } from './session.js';
import { openAuthStore, type AuthStore } from './store.js';

export * from './service.js';
export * from './session.js';
export * from './store.js';

export interface SessionAuthSetup {
  store: AuthStore;
  service: AuthService;
  hooks: AuthHooks;
  close(): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `<dataDir>/auth.sqlite` 를 열고 서비스·훅을 만든다. publicUrl 의 origin·호스트가 WebAuthn origin·RP ID 다 */
export function createSessionAuth(opts: {
  dataDir: string;
  publicUrl: string;
  idleDays: number;
  maxDays: number;
  logger?: AuthLogger;
  hookOptions?: SessionAuthOptions;
}): SessionAuthSetup {
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  const store = openAuthStore(join(opts.dataDir, 'auth.sqlite'));
  const url = new URL(opts.publicUrl);
  const service = createAuthService({
    store,
    origin: url.origin,
    rpId: url.hostname,
    dataDir: opts.dataDir,
    idleMs: opts.idleDays * DAY_MS,
    maxMs: opts.maxDays * DAY_MS,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  const hooks = createSessionAuthHooks(service, opts.hookOptions);
  return { store, service, hooks, close: () => store.close() };
}
