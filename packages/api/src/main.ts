#!/usr/bin/env node
/**
 * `omnicode-server` 진입점. 얇게 유지한다 — 테스트는 buildApp만 쓰고 이 파일을 import하지 않는다.
 */
import { pino } from 'pino';
import { createHub, loadHubConfig } from '@omnicode/hub';
import { buildApp } from './app.js';
import { createDevAuthHooks } from './auth.js';
import { loadApiConfig } from './config.js';

async function main(): Promise<void> {
  const logger = pino({ level: process.env.OMNICODE_LOG_LEVEL ?? 'info' });
  const api = loadApiConfig(process.env);
  const authConfig = api.auth;
  if (authConfig.mode === 'unconfigured') {
    logger.fatal(
      '인증 구현이 없어 시작하지 않습니다. 운영 인증 훅(설계 8.3)이 연결되기 전까지는 ' +
        'OMNICODE_DEV_TOKEN(개발 전용)을 설정하거나 OMNICODE_AUTH_MODE=dev 로 실행해야 합니다.',
    );
    process.exitCode = 1;
    return;
  }
  logger.warn('DEV 전용 인증 훅으로 실행합니다. 운영 환경에서 쓰지 마세요.');
  if (authConfig.generated) {
    logger.warn({ devToken: authConfig.token }, 'OMNICODE_DEV_TOKEN이 없어 임의 토큰을 만들었습니다 (이 프로세스에서만 유효)');
  }
  const auth = createDevAuthHooks({ token: authConfig.token });

  const hub = await createHub({ config: loadHubConfig(process.env) });
  await hub.start();
  const app = buildApp({
    hub,
    auth,
    publicUrl: hub.config.publicUrl ?? api.publicUrl,
    staticDir: api.webDir,
    logger,
  });

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    void (async () => {
      try {
        await app.close();
        await hub.stop();
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      }
    })();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await app.listen({ host: api.host, port: api.port });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
