#!/usr/bin/env node
/**
 * `omnicode-agentd` 실행 진입점 (설계 17.1 `omnicode-agentd.service`).
 * 환경변수: OMNICODE_AGENTD_SOCKET (기본 /run/omnicode/agentd.sock), OMNICODE_AGENTD_GROUP (기본 omnicode), HOME.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { DEFAULTS } from '@omnicode/shared';
import { createConsoleLogger, startAgentd } from './server.js';

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  const logger = createConsoleLogger();
  const socketPath = process.env['OMNICODE_AGENTD_SOCKET'] || DEFAULTS.agentdSocket;
  const home = process.env['HOME'] || os.homedir();
  const handle = await startAgentd({ socketPath, home, version: packageVersion(), logger });

  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    handle.close().then(
      () => process.exit(0),
      (e: unknown) => {
        logger.error({ err: e instanceof Error ? e.message : String(e) }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e: unknown) => {
  process.stderr.write(`omnicode-agentd: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
