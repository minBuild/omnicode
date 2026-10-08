/**
 * D7 · P10: systemd `.socket` 유닛으로 agentd 를 띄우는 소켓 활성화 (sd_listen_fds(3)).
 * - resolveListenTarget: 언제 fd 3 에서 듣고 언제 경로로 여는지 (순수 함수)
 * - 실제 실행: dist/main.js 를 systemd 처럼 띄운다 — 미리 듣고 있는 Unix 소켓을 fd 3 으로, LISTEN_FDS=1, LISTEN_PID=<자식 pid>.
 *   먼저 빌드해야 한다: npx tsc -b packages/agentd
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentdClient } from '../src/client.js';
import { SD_LISTEN_FDS_START, resolveListenTarget } from '../src/server.js';
import { entry, makeHome, removeHome } from './helpers.js';

async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('resolveListenTarget (sd_listen_fds(3))', () => {
  const sock = '/run/omnicode/agentd.sock';
  const pathTarget = { kind: 'path', path: sock };

  it('listens on the socket path when LISTEN_* are absent (development, tests)', () => {
    expect(resolveListenTarget({}, 4242, sock)).toEqual(pathTarget);
  });

  it('uses fd 3 when LISTEN_PID is this process and LISTEN_FDS >= 1', () => {
    expect(SD_LISTEN_FDS_START).toBe(3);
    expect(resolveListenTarget({ LISTEN_PID: '4242', LISTEN_FDS: '1' }, 4242, sock)).toEqual({ kind: 'systemd', fd: 3 });
    expect(resolveListenTarget({ LISTEN_PID: '4242', LISTEN_FDS: '2', LISTEN_FDNAMES: 'agentd:extra' }, 4242, sock)).toEqual({ kind: 'systemd', fd: 3 });
  });

  it('ignores LISTEN_* addressed to another process (inherited from a parent)', () => {
    expect(resolveListenTarget({ LISTEN_PID: '1', LISTEN_FDS: '1' }, 4242, sock)).toEqual(pathTarget);
    expect(resolveListenTarget({ LISTEN_FDS: '1' }, 4242, sock)).toEqual(pathTarget);
    expect(resolveListenTarget({ LISTEN_PID: '4242' }, 4242, sock)).toEqual(pathTarget);
  });

  it.each(['0', '', '-1', '1x', ' 1', 'one'])('ignores LISTEN_FDS=%j', (fds) => {
    expect(resolveListenTarget({ LISTEN_PID: '4242', LISTEN_FDS: fds }, 4242, sock)).toEqual(pathTarget);
  });

  it.each(['', '4242 ', '+4242', '0x1092', '4242.0'])('ignores a malformed LISTEN_PID=%j', (pid) => {
    expect(resolveListenTarget({ LISTEN_PID: pid, LISTEN_FDS: '1' }, 4242, sock)).toEqual(pathTarget);
  });
});

describe('agentd started by systemd socket activation (spawned dist/main.js)', () => {
  const mainJs = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  let home: string | undefined;
  let child: ChildProcess | undefined;

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child = undefined;
    if (home) await removeHome(home);
    home = undefined;
  });

  it.runIf(process.platform !== 'win32')('serves on the inherited fd 3 and leaves the socket file to systemd', async () => {
    expect(existsSync(mainJs), `${mainJs} is missing; build first: npx tsc -b packages/agentd`).toBe(true);
    home = await makeHome();
    const socketPath = path.join(home, 'a.sock');

    // systemd 역할: 소켓을 만들어 듣기 시작한 뒤 fd 를 넘긴다. 권한은 일부러 0600 —
    // 경로 모드였다면 agentd 가 0660 으로 바꾸고 OMNICODE_AGENTD_GROUP 으로 chgrp 했을 것이다.
    const listener = net.createServer();
    await new Promise<void>((resolve) => listener.listen(socketPath, resolve));
    await fs.chmod(socketPath, 0o600);
    const before = await fs.stat(socketPath);
    const otherGid = process.getgroups?.().find((g) => g !== before.gid);
    const fd = (listener as unknown as { _handle: { fd: number } })._handle.fd;

    // agentd 가 띄우는 CLI 가 LISTEN_* 를 물려받는지 보는 가짜 claude (status 가 `claude --version` 첫 줄을 보고한다)
    const bin = path.join(home, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho "LISTEN_PID=${LISTEN_PID-unset} LISTEN_FDS=${LISTEN_FDS-unset}"\n', { mode: 0o755 });

    // LISTEN_PID 는 node 자신의 pid 여야 한다: sh 가 자기 pid($$)를 넣고 exec 로 node 가 그 pid 를 이어받는다
    const proc = spawn('/bin/sh', ['-c', 'LISTEN_PID=$$; export LISTEN_PID; exec "$0" "$@"', process.execPath, mainJs], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: home,
        LISTEN_FDS: '1',
        OMNICODE_AGENTD_SOCKET: socketPath,
        OMNICODE_AGENTD_GROUP: otherGid !== undefined ? String(otherGid) : 'omnicode',
      },
      stdio: ['ignore', 'pipe', 'pipe', fd],
    });
    child = proc;
    let stdout = '';
    let stderr = '';
    proc.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    proc.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));

    // 부모는 더 이상 accept 하지 않는다. libuv 는 close 때 자기가 bind 한 경로를 unlink 하므로 잠시 옮겨 두었다가 되돌린다.
    await fs.rename(socketPath, `${socketPath}.keep`);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await fs.rename(`${socketPath}.keep`, socketPath);

    // 소켓은 이미 듣고 있으므로 agentd 가 준비되기 전에 접속해도 커널 대기열에서 기다린다
    const client = createAgentdClient(socketPath, { timeoutMs: 10_000 });
    const plan = await client.syncPlan('codex', { entries: [entry('a')] }).catch((e: unknown) => {
      throw new Error(`${String(e)}\nagentd stderr: ${stderr}\nagentd stdout: ${stdout}`);
    });
    expect(plan).toEqual({ added: ['omni-a'], updated: [], removed: [], unchanged: [] });

    const status = await client.status();
    expect(status.home).toBe(home);
    expect(status.cli.claude).toBe('LISTEN_PID=unset LISTEN_FDS=unset');

    await waitFor(() => stdout.includes('"agentd listening"'), 5_000, `agentd listening log (stderr: ${stderr})`);
    const listening = stdout
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l['msg'] === 'agentd listening');
    expect(listening).toMatchObject({ systemd: true, socketPath });

    // 소켓 파일의 권한·그룹은 systemd(.socket 유닛) 몫이라 그대로다
    const after = await fs.stat(socketPath);
    expect(after.mode & 0o777).toBe(0o600);
    expect(after.gid).toBe(before.gid);
    expect(after.ino).toBe(before.ino);

    // 종료해도 소켓 파일을 지우지 않는다 (RemoveOnStop=yes 는 systemd 가 한다)
    proc.kill('SIGTERM');
    expect(await exited, `agentd stderr: ${stderr}`).toBe(0);
    expect((await fs.lstat(socketPath)).isSocket()).toBe(true);
  });
});
