import { describe, expect, it } from 'vitest';
import { ApiConfigError, loadApiConfig } from '../src/index.js';

describe('loadApiConfig', () => {
  it('applies defaults', () => {
    const c = loadApiConfig({});
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(8080);
    expect(c.publicUrl).toBeNull();
    expect(c.auth).toEqual({ mode: 'unconfigured' });
    expect(c.webDir.replace(/\\/g, '/')).toMatch(/\/packages\/web\/dist$/);
  });

  it('reads host, port and web dir', () => {
    const c = loadApiConfig({ OMNICODE_API_HOST: '0.0.0.0', OMNICODE_API_PORT: '9090', OMNICODE_WEB_DIR: '/srv/omnicode/web' });
    expect(c).toMatchObject({ host: '0.0.0.0', port: 9090, webDir: '/srv/omnicode/web' });
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
    expect(loadApiConfig({ OMNICODE_PUBLIC_URL: '' }).publicUrl).toBeNull();
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

  it('stays unconfigured for any other auth mode', () => {
    expect(loadApiConfig({ OMNICODE_AUTH_MODE: 'production' }).auth).toEqual({ mode: 'unconfigured' });
  });
});
