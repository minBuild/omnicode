import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, UpstreamError } from '@omnicode/hub';
import { CALLBACK_CSP, SUCCESS_TEXT } from '../src/index.js';
import { authed, json, makeApp, type ErrorResponse, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});
afterEach(async () => {
  await t.app.close();
});

describe('GET /.well-known/omnicode/client.json (CIMD, 10.3)', () => {
  it('serves the client metadata document built from publicUrl', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/.well-known/omnicode/client.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(json(res)).toEqual({
      client_id: 'https://omni.example/.well-known/omnicode/client.json',
      client_name: 'OmniCode (omni.example)',
      client_uri: 'https://omni.example',
      redirect_uris: ['https://omni.example/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('normalizes a trailing slash and a port in publicUrl', async () => {
    await t.app.close();
    t = makeApp({ publicUrl: 'https://omni.example:8443/' });
    const res = await t.app.inject({ method: 'GET', url: '/.well-known/omnicode/client.json' });
    expect(json<{ client_id: string; client_name: string }>(res)).toMatchObject({
      client_id: 'https://omni.example:8443/.well-known/omnicode/client.json',
      client_name: 'OmniCode (omni.example:8443)',
    });
  });

  it('is 404 when publicUrl is null (Tailscale-only deployment)', async () => {
    await t.app.close();
    t = makeApp({ publicUrl: null });
    const res = await t.app.inject({ method: 'GET', url: '/.well-known/omnicode/client.json' });
    expect(res.statusCode).toBe(404);
    expect(json<ErrorResponse>(res).error.code).toBe('not_found');
  });

  it('refuses to build with a non-https publicUrl', async () => {
    await t.app.close();
    t = makeApp({ publicUrl: 'http://omni.example' });
    await expect(t.app.ready()).rejects.toThrow(/https/);
  });
});

describe('GET /oauth/callback (10.3)', () => {
  const html = (res: { headers: Record<string, unknown> }) => {
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['content-security-policy']).toBe(CALLBACK_CSP);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  };

  it('success without any cookie → 200 static page telling the user to go back', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/oauth/callback?code=SECRET-CODE-123&state=st4te&iss=https://auth.example' });
    expect(res.statusCode).toBe(200);
    html(res);
    expect(res.body).toContain(SUCCESS_TEXT);
    expect(res.body).not.toContain('SECRET-CODE-123');
    expect(res.body).not.toContain('<script');
    expect(t.hub.callsTo('oauth.handleCallback')[0]?.args[0]).toEqual({ code: 'SECRET-CODE-123', state: 'st4te', iss: 'https://auth.example' });
  });

  it('success with a valid session → 303 to the server detail', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/oauth/callback?code=c&state=s', headers: authed });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/mcp/servers/fish-audio');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toBe(CALLBACK_CSP);
  });

  it('success with a session but no server id → 200 page', async () => {
    t.hub.callbackResult = { ok: true, serverId: null };
    const res = await t.app.inject({ method: 'GET', url: '/oauth/callback?code=c&state=s', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(SUCCESS_TEXT);
  });

  it('never redirects to a malformed server id', async () => {
    t.hub.callbackResult = { ok: true, serverId: '../evil' };
    const res = await t.app.inject({ method: 'GET', url: '/oauth/callback?code=c&state=s', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(res.headers.location).toBeUndefined();
  });

  it.each([
    ['oauth_state_invalid', 400],
    ['oauth_issuer_mismatch', 400],
    ['oauth_denied', 400],
    ['oauth_registration_failed', 422],
    ['not_found', 404],
  ])('failure %s → %i page showing only the error code', async (code, status) => {
    t.hub.callbackResult = { ok: false, serverId: 'fish-audio', error: code };
    const res = await t.app.inject({
      method: 'GET',
      url: `/oauth/callback?state=s&error=access_denied&error_description=${encodeURIComponent('<b>RAW DESCRIPTION</b>')}`,
      headers: authed,
    });
    expect(res.statusCode).toBe(status);
    html(res);
    expect(res.body).toContain(`<code>${code}</code>`);
    expect(res.body).not.toContain('RAW DESCRIPTION');
    expect(res.body).not.toContain('access_denied');
    expect(res.headers.location).toBeUndefined();
  });

  it('forwards error parameters to the hub as given', async () => {
    t.hub.callbackResult = { ok: false, serverId: 'fish-audio', error: 'oauth_denied' };
    await t.app.inject({ method: 'GET', url: '/oauth/callback?state=s&error=access_denied&error_description=nope' });
    expect(t.hub.callsTo('oauth.handleCallback')[0]?.args[0]).toEqual({ state: 's', error: 'access_denied', error_description: 'nope' });
  });

  it('shows a generic message for unknown codes and HTML-escapes them', async () => {
    t.hub.callbackResult = { ok: false, serverId: null, error: '<img src=x onerror=alert(1)>' };
    const res = await t.app.inject({ method: 'GET', url: '/oauth/callback?state=s' });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('<img');
    expect(res.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('failure without an error code falls back to internal (500)', async () => {
    t.hub.callbackResult = { ok: false, serverId: null };
    const res = await t.app.inject({ method: 'GET', url: '/oauth/callback?state=s' });
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain('<code>internal</code>');
  });

  it('maps thrown hub errors to the failure page (never JSON)', async () => {
    t.hub.failWith('oauth.handleCallback', new NotFoundError('server gone'));
    const nf = await t.app.inject({ method: 'GET', url: '/oauth/callback?code=c&state=s' });
    expect(nf.statusCode).toBe(404);
    html(nf);
    expect(nf.body).toContain('<code>not_found</code>');

    t.hub.failWith('oauth.handleCallback', new UpstreamError('unavailable', 'token endpoint 503 with secret-ish text'));
    const up = await t.app.inject({ method: 'GET', url: '/oauth/callback?code=c&state=s' });
    expect(up.statusCode).toBe(422);
    expect(up.body).toContain('<code>probe_failed</code>');
    expect(up.body).not.toContain('secret-ish');

    t.hub.failWith('oauth.handleCallback', new Error('boom'));
    const boom = await t.app.inject({ method: 'GET', url: '/oauth/callback?code=c&state=s' });
    expect(boom.statusCode).toBe(500);
    html(boom);
    expect(boom.body).toContain('<code>internal</code>');
    expect(boom.body).not.toContain('boom');
  });

  it('ignores repeated or non-string query values', async () => {
    await t.app.inject({ method: 'GET', url: '/oauth/callback?state=a&state=b&code=c' });
    expect(t.hub.callsTo('oauth.handleCallback')[0]?.args[0]).toEqual({ code: 'c' });
  });
});
