import { afterEach, describe, expect, it } from 'vitest';
import { request, setAuthInterceptors, type FetchLike } from '../src/api/client';
import { describeUserAgent, guessDeviceLabel, isCeremonyCancelled, safeNextPath } from '../src/auth/flows';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe('auth interceptors (0002 9장)', () => {
  it('re-authenticates once on reauth_required and replays the same request', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    let first = true;
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, body: init.body });
      if (first) {
        first = false;
        return jsonResponse(401, { error: { code: 'reauth_required', message: 'x' } });
      }
      return jsonResponse(200, { rotatedAt: 'now' });
    };
    let asked = 0;
    restore = setAuthInterceptors({
      onReauthRequired: async () => {
        asked++;
        return true;
      },
    });
    const r = await request<{ rotatedAt: string }>('POST', '/api/mcp/hub/tokens/rotate', { body: { agents: ['claude'] }, fetchImpl });
    expect(r.rotatedAt).toBe('now');
    expect(asked).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.body).toBe(seen[0]?.body);
  });

  it('does not loop: a second reauth_required after retry is thrown', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(401, { error: { code: 'reauth_required' } });
    let asked = 0;
    restore = setAuthInterceptors({ onReauthRequired: async () => (asked++, true) });
    await expect(request('POST', '/api/mcp/hub/tokens/rotate', { fetchImpl })).rejects.toMatchObject({ code: 'reauth_required' });
    expect(asked).toBe(1);
  });

  it('throws reauth_required when the user cancels, and skipReauth bypasses the dialog', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(401, { error: { code: 'reauth_required' } });
    let asked = 0;
    restore = setAuthInterceptors({ onReauthRequired: async () => (asked++, false) });
    await expect(request('POST', '/x', { fetchImpl })).rejects.toMatchObject({ code: 'reauth_required' });
    await expect(request('POST', '/x', { fetchImpl, skipReauth: true })).rejects.toMatchObject({ code: 'reauth_required' });
    expect(asked).toBe(1);
  });

  it('reports unauthenticated except for /api/auth/* calls', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(401, { error: { code: 'unauthenticated' } });
    let expired = 0;
    restore = setAuthInterceptors({ onUnauthenticated: () => void expired++ });
    await expect(request('GET', '/api/mcp/servers', { fetchImpl })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(request('GET', '/api/auth/passkeys', { fetchImpl })).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(expired).toBe(1);
  });
});

describe('auth helpers', () => {
  it('safeNextPath allows only same-site absolute paths', () => {
    expect(safeNextPath('/mcp/servers/fish?x=1')).toBe('/mcp/servers/fish?x=1');
    for (const bad of [null, '', 'https://evil.example', '//evil.example', '/\\evil.example', 'mcp', '/login?next=/x', '/setup', '/mcp\n']) {
      expect(safeNextPath(bad), String(bad)).toBe('/mcp');
    }
  });

  it('guesses passkey labels and describes user agents', () => {
    expect(guessDeviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Safari/604.1')).toBe('iPhone');
    expect(guessDeviceLabel('Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile')).toBe('Android');
    expect(guessDeviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Mac');
    expect(guessDeviceLabel('curl/8')).toBe('이 기기');
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/140 Safari/537.36 Edg/140')).toBe('Windows · Edge');
    expect(describeUserAgent('Mozilla/5.0 (iPhone) AppleWebKit Version/18 Mobile Safari/604.1')).toBe('iPhone · Safari');
    expect(describeUserAgent(null)).toBe('알 수 없는 기기');
  });

  it('treats a closed passkey prompt as a cancellation, not an error', () => {
    expect(isCeremonyCancelled(Object.assign(new Error('x'), { name: 'NotAllowedError' }))).toBe(true);
    expect(isCeremonyCancelled(Object.assign(new Error('x'), { code: 'ERROR_CEREMONY_ABORTED' }))).toBe(true);
    expect(isCeremonyCancelled(new Error('server said no'))).toBe(false);
    expect(isCeremonyCancelled('nope')).toBe(false);
  });
});
