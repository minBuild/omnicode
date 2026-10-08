import { execFile } from 'node:child_process';

/** 외부 CLI 실행 추상화. 테스트는 가짜 러너를 주입한다. */
export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

export interface RunResult {
  /** 정상 종료 코드. 실행 자체가 실패했거나(ENOENT) 시그널·타임아웃으로 죽었으면 null. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(cmd: string, args: readonly string[], opts?: RunOptions): Promise<RunResult>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** 기본 러너: `node:child_process.execFile` — 셸을 거치지 않는다. 비정상 종료도 reject 하지 않고 결과로 돌려준다. */
export function createExecFileRunner(): CommandRunner {
  return {
    run(cmd, args, opts = {}) {
      return new Promise<RunResult>((resolve) => {
        execFile(
          cmd,
          [...args],
          {
            env: opts.env ?? process.env,
            cwd: opts.cwd,
            timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: MAX_OUTPUT_BYTES,
            windowsHide: true,
            shell: false,
            encoding: 'utf8',
          },
          (error, stdout, stderr) => {
            if (!error) {
              resolve({ code: 0, stdout, stderr });
              return;
            }
            const e = error as Error & { code?: number | string; killed?: boolean; signal?: NodeJS.Signals | null };
            if (typeof e.code === 'number') {
              resolve({ code: e.code, stdout, stderr });
              return;
            }
            // 스폰 실패(ENOENT 등) 또는 시그널/타임아웃
            const reason = typeof e.code === 'string' ? e.code : e.killed ? `killed (${e.signal ?? 'timeout'})` : e.message;
            resolve({ code: null, stdout, stderr: [stderr, reason].filter((s) => s.length > 0).join('\n') });
          },
        );
      });
    },
  };
}
