import { promises as fs } from 'node:fs';
import path from 'node:path';
import { generateAgentToken } from '@omnicode/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentdError } from '../src/errors.js';
import { ENV_SH, envShPath, tokenPath, tokensDir, writeToken } from '../src/tokens.js';
import { makeHome, mode, removeHome } from './helpers.js';

describe('tokens.write', () => {
  let home: string;
  beforeEach(async () => {
    home = await makeHome();
  });
  afterEach(async () => {
    await removeHome(home);
  });

  it('writes the token file with 0600 and regenerates env.sh', async () => {
    const token = generateAgentToken();
    const result = await writeToken(home, 'codex', token);
    expect(result).toEqual({ path: tokenPath(home, 'codex') });
    expect(await fs.readFile(result.path, 'utf8')).toBe(token); // 개행 없음
    expect(await mode(result.path)).toBe(0o600);
    expect(await mode(tokensDir(home))).toBe(0o700);
    expect(await mode(path.join(home, '.omnicode'))).toBe(0o700);

    const env = await fs.readFile(envShPath(home), 'utf8');
    expect(env).toBe(ENV_SH);
    expect(env).toBe(
      '# ~/.omnicode/env.sh (agentd가 생성)\n' +
        'export OMNICODE_HUB_TOKEN_CODEX="$(cat "$HOME/.omnicode/tokens/codex")"\n' +
        'export OMNICODE_HUB_TOKEN_GEMINI="$(cat "$HOME/.omnicode/tokens/gemini")"\n',
    );
    expect(await mode(envShPath(home))).toBe(0o600);
  });

  it('overwrites without leaving backups or temp files', async () => {
    await writeToken(home, 'gemini', generateAgentToken());
    const second = generateAgentToken();
    await writeToken(home, 'gemini', second);
    expect(await fs.readFile(tokenPath(home, 'gemini'), 'utf8')).toBe(second);
    expect(await fs.readdir(tokensDir(home))).toEqual(['gemini']);
    expect((await fs.readdir(path.join(home, '.omnicode'))).sort()).toEqual(['env.sh', 'tokens']);
  });

  it('rejects malformed tokens and unknown agents', async () => {
    const bad = await writeToken(home, 'claude', 'omh_short').catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(AgentdError);
    expect((bad as AgentdError).code).toBe('invalid_request');
    const badAgent = await writeToken(home, 'cursor' as never, generateAgentToken()).catch((e: unknown) => e);
    expect((badAgent as AgentdError).code).toBe('invalid_request');
    await expect(fs.access(path.join(home, '.omnicode'))).rejects.toThrow();
  });
});
