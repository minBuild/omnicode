import { expect } from 'vitest';
import { UpstreamError, type CallContext, type ProgressNotification, type UpstreamConnectorOptions } from '../../src/contracts.js';

export function baseOpts(url: string, extra: Partial<UpstreamConnectorOptions> = {}): UpstreamConnectorOptions {
  return { serverId: 'test-server', url, fetch: globalThis.fetch, headers: async () => ({}), ...extra };
}

export interface TestCtx extends CallContext {
  progress: ProgressNotification[];
}

export function makeCtx(overrides: Partial<CallContext> = {}): TestCtx {
  const progress: ProgressNotification[] = [];
  return {
    agent: 'claude',
    signal: new AbortController().signal,
    downstreamEra: 'legacy',
    mcpParamHeaders: {},
    onProgress: (n) => {
      progress.push(n);
    },
    timeoutMs: 10_000,
    idleTimeoutMs: 5_000,
    ...overrides,
    progress,
  };
}

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await delay(20);
  }
}

export async function expectUpstreamError(p: Promise<unknown>, kind: UpstreamError['kind']): Promise<UpstreamError> {
  let caught: unknown;
  let resolved = false;
  try {
    await p;
    resolved = true;
  } catch (e) {
    caught = e;
  }
  if (resolved) throw new Error(`expected UpstreamError('${kind}') but the promise resolved`);
  expect(caught).toBeInstanceOf(UpstreamError);
  const err = caught as UpstreamError;
  expect(err.kind).toBe(kind);
  return err;
}
