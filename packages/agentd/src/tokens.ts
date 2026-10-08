/**
 * 에이전트 토큰 파일 (설계 10.5, 12.6).
 * `~/.omnicode/tokens/<agent>` 0600 (한 줄, 개행 없음) + `~/.omnicode/env.sh` 재생성.
 */
import path from 'node:path';
import { AGENT_TOKEN_RE, isAgent, type Agent, type TokensWriteResult } from '@omnicode/shared';
import { AgentdError } from './errors.js';
import { ensureDir, writeFileAtomic } from './fsutil.js';

/** 설계 12.6 그대로. 셸 프로필이 source 한다. */
export const ENV_SH =
  '# ~/.omnicode/env.sh (agentd가 생성)\n' +
  'export OMNICODE_HUB_TOKEN_CODEX="$(cat "$HOME/.omnicode/tokens/codex")"\n' +
  'export OMNICODE_HUB_TOKEN_GEMINI="$(cat "$HOME/.omnicode/tokens/gemini")"\n';

export function omnicodeDir(home: string): string {
  return path.join(home, '.omnicode');
}
export function tokensDir(home: string): string {
  return path.join(omnicodeDir(home), 'tokens');
}
export function tokenPath(home: string, agent: Agent): string {
  return path.join(tokensDir(home), agent);
}
export function envShPath(home: string): string {
  return path.join(omnicodeDir(home), 'env.sh');
}

/** 토큰을 쓰고 env.sh 를 다시 만든다. 토큰 파일은 백업하지 않는다 (이전 토큰 사본을 남기지 않기 위해). */
export async function writeToken(home: string, agent: Agent, token: string): Promise<TokensWriteResult> {
  if (!isAgent(agent)) throw new AgentdError('invalid_request', `unknown agent: ${String(agent)}`);
  if (typeof token !== 'string' || !AGENT_TOKEN_RE.test(token)) {
    throw new AgentdError('invalid_request', 'token must match omh_<base64url> (10.5)');
  }
  await ensureDir(omnicodeDir(home), 0o700);
  await ensureDir(tokensDir(home), 0o700);
  const file = tokenPath(home, agent);
  await writeFileAtomic(file, token, { mode: 0o600, backups: 0 });
  await writeFileAtomic(envShPath(home), ENV_SH, { mode: 0o600, backups: 0 });
  return { path: file };
}
