#!/usr/bin/env node
/**
 * `omnicode-server` 진입점. 얇게 유지한다 — 테스트는 buildApp·createSessionAuth 만 쓰고 이 파일을 import 하지 않는다.
 *
 *   omnicode-server                    서버 실행 (기본)
 *   omnicode-server auth setup-token   패스키가 없을 때 새 설치 토큰을 만들어 출력 (설계 0002 5.5)
 *   omnicode-server auth reset         모든 패스키·세션을 지우고 새 설치 토큰 (복구용)
 */
import { pino } from 'pino';
import { createHub, loadHubConfig } from '@omnicode/hub';
import { buildApp } from './app.js';
import { createDevAuthHooks, type AuthHooks } from './auth.js';
import { createSessionAuth } from './auth/index.js';
import { loadApiConfig } from './config.js';

async function authCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub !== 'reset' && sub !== 'setup-token') {
    console.error('사용법: omnicode-server auth <setup-token|reset>');
    return 2;
  }
  const hubConfig = loadHubConfig(process.env);
  const api = loadApiConfig({ ...process.env, OMNICODE_AUTH_MODE: 'session' });
  if (api.auth.mode !== 'session' || api.publicUrl === null) {
    console.error('OMNICODE_PUBLIC_URL 이 필요합니다.');
    return 1;
  }
  const auth = createSessionAuth({ dataDir: hubConfig.dataDir, publicUrl: api.publicUrl, idleDays: api.auth.idleDays, maxDays: api.auth.maxDays });
  try {
    if (sub === 'reset') {
      const r = auth.service.resetAll();
      console.log(`패스키 ${r.passkeys}개, 세션 ${r.sessions}개를 지웠습니다.`);
      console.log(`새 설치 토큰: ${r.token}`);
    } else {
      const token = auth.service.regenerateSetupToken();
      console.log(`새 설치 토큰: ${token}`);
    }
    console.log(`${api.publicUrl}/setup 에서 이 토큰으로 첫 패스키를 등록하세요 (24시간 유효).`);
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    auth.close();
  }
}

async function serve(): Promise<void> {
  const logger = pino({ level: process.env.OMNICODE_LOG_LEVEL ?? 'info' });
  const api = loadApiConfig(process.env);
  const hubConfig = loadHubConfig(process.env);

  let auth: AuthHooks;
  let closeAuth = () => {};
  if (api.auth.mode === 'dev') {
    logger.warn('DEV 전용 인증 훅으로 실행합니다. 운영 환경에서 쓰지 마세요.');
    if (api.auth.generated) {
      logger.warn({ devToken: api.auth.token }, 'OMNICODE_DEV_TOKEN이 없어 임의 토큰을 만들었습니다 (이 프로세스에서만 유효)');
    }
    auth = createDevAuthHooks({ token: api.auth.token });
  } else {
    const publicUrl = api.publicUrl as string; // loadApiConfig 가 session 모드에서 보장한다
    const session = createSessionAuth({
      dataDir: hubConfig.dataDir,
      publicUrl,
      idleDays: api.auth.idleDays,
      maxDays: api.auth.maxDays,
      logger: { info: (o, m) => logger.info(o, m), warn: (o, m) => logger.warn(o, m) },
    });
    const setup = session.service.ensureSetupToken();
    if (setup.required) {
      logger.warn({ path: setup.path, url: `${publicUrl}/setup` }, '등록된 패스키가 없습니다. 설치 토큰 파일을 읽어 /setup 에서 첫 패스키를 등록하세요');
    }
    auth = session.hooks;
    closeAuth = () => session.close();
  }

  const hub = await createHub({ config: hubConfig });
  await hub.start();
  const app = buildApp({
    hub,
    auth,
    publicUrl: hub.config.publicUrl ?? api.publicUrl,
    staticDir: api.webDir,
    staticLive: api.webLive,
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
        closeAuth();
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

const args = process.argv.slice(2);
if (args[0] === 'auth') {
  authCommand(args.slice(1)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
} else {
  serve().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
