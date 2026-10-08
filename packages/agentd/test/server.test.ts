import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { generateAgentToken, type AgentdResponse } from '@omnicode/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexConfigPath } from '../src/adapters/codex.js';
import { AgentdRequestError, AgentdUnavailableError, createAgentdClient } from '../src/client.js';
import { MAX_LINE_BYTES } from '../src/constants.js';
import { lookupGid, startAgentd, type AgentdHandle, type AgentdLogger } from '../src/server.js';
import { tokenPath } from '../src/tokens.js';
import { entry, fakeClaudeRunner, makeHome, mode, readOrUndefined, removeHome } from './helpers.js';

/** 원시 소켓으로 보내고 n 줄을 받거나 서버가 끊을 때까지 기다린다. */
function raw(socketPath: string, payload: string | Buffer, want: { lines?: number; close?: boolean }): Promise<{ lines: string[]; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    const lines: string[] = [];
    let buf = '';
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ lines, closed });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(`raw(): timed out with ${lines.length} line(s): ${lines.join(' | ')}`));
    }, 10_000);
    sock.setEncoding('utf8');
    sock.once('connect', () => sock.write(payload));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      if (!want.close && want.lines !== undefined && lines.length >= want.lines) finish(false);
    });
    sock.on('close', () => finish(true));
    sock.on('error', (e) => {
      if (lines.length === 0 && !settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
  });
}

function collectingLogger(): AgentdLogger & { entries: Array<{ level: string; msg?: string; obj: unknown }> } {
  const entries: Array<{ level: string; msg?: string; obj: unknown }> = [];
  const make = (level: string) => (obj: Record<string, unknown> | string, msg?: string) => {
    entries.push({ level, msg: typeof obj === 'string' ? obj : msg, obj });
  };
  return { entries, info: make('info'), warn: make('warn'), error: make('error') };
}

describe('agentd socket server', () => {
  let home: string;
  let socketPath: string;
  let handle: AgentdHandle | undefined;
  let calls: ReturnType<typeof fakeClaudeRunner>['calls'];
  let logger: ReturnType<typeof collectingLogger>;

  beforeEach(async () => {
    home = await makeHome();
    socketPath = path.join(home, 'a.sock');
    const fake = fakeClaudeRunner(home, {
      versions: {
        claude: { code: 0, stdout: '1.0.0 (Claude Code)\n', stderr: '' },
        gemini: { code: 0, stdout: 'gemini 0.5.0\n', stderr: '' },
      },
    });
    calls = fake.calls;
    logger = collectingLogger();
    handle = await startAgentd({ socketPath, home, version: '0.1.0-test', runner: fake.runner, logger, group: null });
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    await removeHome(home);
  });

  it('listens on a 0660 socket and removes it on close', async () => {
    expect(await mode(socketPath)).toBe(0o660);
    await handle!.close();
    expect(await readOrUndefined(socketPath)).toBeUndefined();
  });

  it('serves status, sync.plan, sync.apply and tokens.write through the client', async () => {
    const client = createAgentdClient(socketPath, { timeoutMs: 5_000 });

    const status = await client.status();
    expect(status.version).toBe('0.1.0-test');
    expect(status.home).toBe(home);
    expect(status.cli).toEqual({ claude: '1.0.0 (Claude Code)', codex: null, gemini: 'gemini 0.5.0' });
    expect(status.lastSync).toEqual({ claude: null, codex: null, gemini: null });
    // 버전은 캐시된다
    await client.status();
    expect(calls.filter((c) => c.args[0] === '--version')).toHaveLength(3);

    const desired = { entries: [entry('a')] };
    expect(await client.syncPlan('codex', desired)).toEqual({ added: ['omni-a'], updated: [], removed: [], unchanged: [] });
    expect(await readOrUndefined(codexConfigPath(home))).toBeUndefined();

    expect(await client.syncApply('codex', desired)).toEqual({ added: ['omni-a'], updated: [], removed: [], unchanged: [] });
    expect(await readOrUndefined(codexConfigPath(home))).toContain('[mcp_servers.omni-a]');
    const after = await client.status();
    expect(after.lastSync.codex?.ok).toBe(true);
    expect(after.lastSync.claude).toBeNull();

    expect(await client.syncApply('claude', desired)).toEqual({ added: ['omni-a'], updated: [], removed: [], unchanged: [] });
    expect(calls.map((c) => c.args.slice(0, 3))).toContainEqual(['mcp', 'add-json', 'omni-a']);

    const token = generateAgentToken();
    await client.writeToken('gemini', token);
    expect(await readOrUndefined(tokenPath(home, 'gemini'))).toBe(token);
  });

  it('maps { ok: false } responses to AgentdRequestError with the agentd code', async () => {
    const client = createAgentdClient(socketPath, { timeoutMs: 5_000 });
    const invalid = await client.syncApply('codex', { entries: [{ ...entry('a'), name: 'not-omni' }] }).catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(AgentdRequestError);
    expect((invalid as AgentdRequestError).code).toBe('invalid_request');

    // 깨진 TOML → adapter_error, lastSync 에 실패가 남는다
    await fs.mkdir(path.join(home, '.codex'), { recursive: true });
    await fs.writeFile(codexConfigPath(home), 'model = \n');
    const broken = await client.syncApply('codex', { entries: [entry('a')] }).catch((e: unknown) => e);
    expect((broken as AgentdRequestError).code).toBe('adapter_error');
    const status = await client.status();
    expect(status.lastSync.codex?.ok).toBe(false);
    expect(status.lastSync.codex?.error).toContain('not valid TOML');
    expect(logger.entries.some((e) => e.level === 'error' && e.msg === 'request failed')).toBe(true);
  });

  it('answers several requests on one connection in order and rejects malformed ones', async () => {
    const payload = 'not json\n' + '{"id":"x","op":"nope"}\n' + '\n' + '{"id":"y","op":"status"}\n' + '{"id":"z","op":"tokens.write","agent":"claude","token":"bad"}\n';
    const { lines } = await raw(socketPath, payload, { lines: 4 });
    const resp = lines.map((l) => JSON.parse(l) as AgentdResponse);
    expect(resp[0]).toEqual({ id: '', ok: false, error: { code: 'invalid_request', message: expect.stringContaining('JSON') } });
    expect(resp[1]).toMatchObject({ id: 'x', ok: false, error: { code: 'invalid_request' } });
    expect(resp[2]).toMatchObject({ id: 'y', ok: true, result: { version: '0.1.0-test' } });
    expect(resp[3]).toMatchObject({ id: 'z', ok: false, error: { code: 'invalid_request', message: expect.stringContaining('token') } });
  });

  it('rejects an oversized line and closes the connection', async () => {
    const payload = Buffer.concat([Buffer.alloc(MAX_LINE_BYTES + 1, 0x61), Buffer.from('\n')]);
    const { lines, closed } = await raw(socketPath, payload, { close: true });
    expect(closed).toBe(true);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: '', ok: false, error: { code: 'invalid_request', message: expect.stringContaining('exceeds') } });
    // 서버는 계속 동작한다
    expect((await createAgentdClient(socketPath).status()).version).toBe('0.1.0-test');
  });

  it('client refuses to send an oversized request', async () => {
    const client = createAgentdClient(socketPath);
    const huge = { entries: [{ ...entry('a'), url: 'http://127.0.0.1:7410/mcp/' + 'a'.repeat(MAX_LINE_BYTES) }] };
    const err = await client.syncPlan('codex', huge).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentdRequestError);
    expect((err as AgentdRequestError).code).toBe('invalid_request');
  });

  it('client reports AgentdUnavailableError when nothing listens', async () => {
    const client = createAgentdClient(path.join(home, 'nope.sock'), { timeoutMs: 2_000 });
    await expect(client.status()).rejects.toBeInstanceOf(AgentdUnavailableError);
    await handle!.close();
    await expect(createAgentdClient(socketPath, { timeoutMs: 2_000 }).status()).rejects.toBeInstanceOf(AgentdUnavailableError);
  });

  it('refuses to start when another instance is listening, replaces a stale socket, rejects a non-socket file', async () => {
    await expect(startAgentd({ socketPath, home, version: 'x', group: null })).rejects.toThrow(/already listening/);

    const stale = path.join(home, 'b.sock');
    const child = spawnSync(process.execPath, ['-e', 'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))', stale], { stdio: 'ignore' });
    expect(child.status).toBe(0);
    expect((await fs.lstat(stale)).isSocket()).toBe(true);
    const log = collectingLogger();
    const second = await startAgentd({ socketPath: stale, home, version: 'x', group: null, logger: log });
    try {
      expect(log.entries.some((e) => e.msg === 'removed stale socket')).toBe(true);
      expect((await createAgentdClient(stale).status()).version).toBe('x');
    } finally {
      await second.close();
    }

    const plain = path.join(home, 'c.sock');
    await fs.writeFile(plain, 'x');
    await expect(startAgentd({ socketPath: plain, home, version: 'x', group: null })).rejects.toThrow(/not a socket/);
  });

  it('resolves gids from /etc/group and ignores unknown groups', async () => {
    expect(await lookupGid('0')).toBe(0);
    expect(await lookupGid('omnicode-no-such-group')).toBeUndefined();
  });
});
