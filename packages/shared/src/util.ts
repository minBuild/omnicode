import { randomBytes } from 'node:crypto';
import { AGENT_TOKEN_PREFIX } from './constants.js';

export function nowIso(): string {
  return new Date().toISOString();
}

export function base64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function randomId(bytes = 16): string {
  return base64url(randomBytes(bytes));
}

/** 10.5: omh_ + 32바이트 난수 base64url. */
export function generateAgentToken(): string {
  return AGENT_TOKEN_PREFIX + base64url(randomBytes(32));
}

export function hubEntryName(serverId: string): string {
  return `omni-${serverId}`;
}

export function hubServerUrl(port: number, serverId: string): string {
  return `http://127.0.0.1:${port}/mcp/${serverId}`;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });
}
