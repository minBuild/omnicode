/** 경로·메서드별 가짜 API. 호출 기록을 남긴다 */
import { vi } from 'vitest';

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

export type Handler = (call: Call) => { status?: number; body?: unknown } | undefined;

export function stubFetch(handler: Handler) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const r = handler(call) ?? { status: 404, body: { error: { code: 'not_found', message: `${call.method} ${call.path}` } } };
    const status = r.status ?? 200;
    return new Response(r.body === undefined || status === 204 ? null : JSON.stringify(r.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}
