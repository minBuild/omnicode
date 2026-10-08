import { describe, expect, it } from 'vitest';
import { ApiConfigError, loadApiConfig } from '../src/index.js';

describe('loadApiConfig', () => {
  it('applies defaults: session auth (0002) with 7/30 day sessions', () => {
    const c = loadApiConfig({ OMNICODE_PUBLIC_URL: 'https://omni.example' });
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(8080);
    expect(c.publicUrl).toBe('https://omni.example');
    expect(c.auth).toEqual({ mode: 'session', idleDays: 7, maxDays: 30 });
    expect(c.webLive).toBe(false);
    expect(c.webDir.replace(/\\/g, '/')).toMatch(/\/packages\/web\/dist$/);
  });

  it('refuses session auth without OMNICODE_PUBLIC_URL', () => {
    expect(() => loadApiConfig({})).toThrow(ApiConfigError);
    expect(() => loadApiConfig({ OMNICODE_AUTH_MODE: 'session' })).toThrow(/OMNICODE_PUBLIC_URL/);
  });

  it('reads session lifetimes and rejects bad values', () => {
    const base = { OMNICODE_PUBLIC_URL: 'https://omni.example' };
    expect(loadApiConfig({ ...base, OMNICODE_SESSION_IDLE_DAYS: '3', OMNICODE_SESSION_MAX_DAYS: '14' }).auth).toEqual({ mode: 'session', idleDays: 3, maxDays: 14 });
    for (const bad of [{ OMNICODE_SESSION_IDLE_DAYS: '0' }, { OMNICODE_SESSION_MAX_DAYS: '400' }, { OMNICODE_SESSION_IDLE_DAYS: 'x' }, { OMNICODE_SESSION_IDLE_DAYS: '10', OMNICODE_SESSION_MAX_DAYS: '5' }]) {
      expect(() => loadApiConfig({ ...base, ...bad }), JSON.stringify(bad)).toThrow(ApiConfigError);
    }
  });

  it('explicit OMNICODE_AUTH_MODE=session wins over a leftover dev token', () => {
    const c = loadApiConfig({ OMNICODE_PUBLIC_URL: 'https://omni.example', OMNICODE_AUTH_MODE: 'session', OMNICODE_DEV_TOKEN: 'dev-token-0123456789abcdef' });
    expect(c.auth.mode).toBe('session');
  });

  it('reads host, port, web dir and live static flag', () => {
    const c = loadApiConfig({ OMNICODE_AUTH_MODE: 'dev', OMNICODE_API_HOST: '0.0.0.0', OMNICODE_API_PORT: '9090', OMNICODE_WEB_DIR: '/srv/omnicode/web', OMNICODE_WEB_LIVE: '1' });
    expect(c).toMatchObject({ host: '0.0.0.0', port: 9090, webDir: '/srv/omnicode/web', webLive: true });
  });

  it('rejects bad ports', () => {
    for (const bad of ['abc', '0', '70000', '80.5', '-1']) {
      expect(() => loadApiConfig({ OMNICODE_API_PORT: bad }), bad).toThrow(ApiConfigError);
    }
  });

  it('normalizes OMNICODE_PUBLIC_URL to an origin', () => {
    expect(loadApiConfig({ OMNICODE_PUBLIC_URL: 'https://omni.example/' }).publicUrl).toBe('https://omni.example');
    expect(loadApiConfig({ OMNICODE_PUBLIC_URL: ' https://omni.example:8443 ' }).publicUrl).toBe('https://omni.example:8443');
    expect(loadApiConfig({ OMNICODE_PUBLIC_URL: 'http://localhost:8080' }).publicUrl).toBe('http://localhost:8080');
    expect(loadApiConfig({ OMNICODE_AUTH_MODE: 'dev', OMNICODE_PUBLIC_URL: '' }).publicUrl).toBeNull();
  });

  it('rejects non-https, path-bearing or malformed public URLs', () => {
    for (const bad of ['http://omni.example', 'https://omni.example/app', 'https://omni.example/?x=1', 'https://user:pw@omni.example', 'not a url', 'ftp://omni.example']) {
      expect(() => loadApiConfig({ OMNICODE_PUBLIC_URL: bad }), bad).toThrow(ApiConfigError);
    }
  });

  it('enables dev auth when OMNICODE_DEV_TOKEN is set', () => {
    const c = loadApiConfig({ OMNICODE_DEV_TOKEN: 'dev-token-0123456789abcdef' });
    expect(c.auth).toEqual({ mode: 'dev', token: 'dev-token-0123456789abcdef', generated: false });
  });

  it('rejects short dev tokens', () => {
    expect(() => loadApiConfig({ OMNICODE_DEV_TOKEN: 'short' })).toThrow(ApiConfigError);
  });

  it('generates a dev token when OMNICODE_AUTH_MODE=dev and no token is given', () => {
    const c = loadApiConfig({ OMNICODE_AUTH_MODE: 'dev' });
    expect(c.auth.mode).toBe('dev');
    if (c.auth.mode === 'dev') {
      expect(c.auth.generated).toBe(true);
      expect(c.auth.token.length).toBeGreaterThanOrEqual(16);
      expect(loadApiConfig({ OMNICODE_AUTH_MODE: 'dev' }).auth).not.toEqual(c.auth);
    }
  });

  it('rejects unknown auth modes', () => {
    expect(() => loadApiConfig({ OMNICODE_AUTH_MODE: 'production', OMNICODE_PUBLIC_URL: 'https://omni.example' })).toThrow(ApiConfigError);
  });
});
