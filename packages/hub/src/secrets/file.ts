/**
 * 파일 SecretStore — 개발용 (OMNICODE_SECRETS_BACKEND=file). ref 하나당 JSON 파일 하나, 모드 0600.
 * 운영 배포는 AWS 백엔드를 쓴다 (16.6: 디스크 캐시 금지).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import type { SecretStore, SecretValue } from '../contracts.js';

function isErrno(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code;
}

export function secretFilePath(dir: string, ref: string): string {
  if (!ref || ref.includes('\0') || ref.includes('..')) throw new TypeError(`invalid secret ref: ${JSON.stringify(ref)}`);
  return path.join(dir, encodeURIComponent(ref) + '.json');
}

export function createFileSecretStore(dir: string): SecretStore {
  return {
    async get<T extends SecretValue = SecretValue>(ref: string): Promise<T | undefined> {
      try {
        const text = await readFile(secretFilePath(dir, ref), 'utf8');
        return JSON.parse(text) as T;
      } catch (e) {
        if (isErrno(e, 'ENOENT')) return undefined;
        throw e;
      }
    },

    async put(ref, value) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const target = secretFilePath(dir, ref);
      const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      try {
        await chmod(tmp, 0o600); // umask 와 무관하게 0600 보장
        await rename(tmp, target); // 원자적 교체
      } catch (e) {
        await unlink(tmp).catch(() => undefined);
        throw e;
      }
    },

    async delete(ref) {
      try {
        await unlink(secretFilePath(dir, ref));
      } catch (e) {
        if (!isErrno(e, 'ENOENT')) throw e;
      }
    },
  };
}
