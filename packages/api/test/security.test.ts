import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SPA_CSP } from '../src/index.js';
import { authed, json, makeApp, type ErrorResponse, type TestApp } from './helpers.js';

describe('security headers (16.3)', () => {
  let t: TestApp;
  afterEach(async () => {
    await t.app.close();
  });

  it('JSON responses carry nosniff and no-referrer, but no HTML CSP', async () => {
    t = makeApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/mcp/servers', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('error responses carry the same headers', async () => {
    t = makeApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/mcp/servers' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('static SPA serving', () => {
  let dir: string;
  let t: TestApp;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnicode-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body><div id="app">SPA</div></body></html>\n');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("spa")\n');
    writeFileSync(join(dir, '.secret'), 'nope\n');
    t = makeApp({ staticDir: dir });
  });
  afterAll(async () => {
    await t.app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves index.html at / with the SPA CSP', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['content-security-policy']).toBe(SPA_CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body).toContain('SPA');
  });

  it('falls back to index.html for /mcp and /mcp/* without a session', async () => {
    for (const url of ['/mcp', '/mcp/servers', '/mcp/servers/fish-audio', '/mcp/hub']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-security-policy']).toBe(SPA_CSP);
      expect(res.body).toContain('SPA');
    }
  });

  it('serves assets with nosniff and no HTML CSP', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('does not serve dot files and answers unknown files as JSON 404', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/.secret' })).statusCode).toBe(404);
    const res = await t.app.inject({ method: 'GET', url: '/missing.txt' });
    expect(res.statusCode).toBe(404);
    expect(json<ErrorResponse>(res).error.code).toBe('not_found');
  });

  it('keeps API and public routes working next to static files', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/mcp/servers', headers: authed })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/mcp/nope', headers: authed })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/.well-known/omnicode/client.json' })).statusCode).toBe(200);
    const cb = await t.app.inject({ method: 'GET', url: '/oauth/callback?code=c&state=s' });
    expect(cb.statusCode).toBe(200);
    expect(cb.headers['content-security-policy']).not.toBe(SPA_CSP);
  });

  it('skips static serving when the directory does not exist', async () => {
    const other = makeApp({ staticDir: join(dir, 'does-not-exist') });
    const res = await other.app.inject({ method: 'GET', url: '/mcp/servers' });
    expect(res.statusCode).toBe(404);
    expect(json<ErrorResponse>(res).error.code).toBe('not_found');
    await other.app.close();
  });
});
