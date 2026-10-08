import { describe, expect, it } from 'vitest';
import { buildClientMetadata, clientIdFor, escapeHtml, normalizePublicUrl, redirectUriFor, renderCallbackPage } from '../src/index.js';

describe('CIMD helpers (10.3)', () => {
  it('builds the document exactly as the design shows', () => {
    expect(buildClientMetadata('https://my.domain')).toEqual({
      client_id: 'https://my.domain/.well-known/omnicode/client.json',
      client_name: 'OmniCode (my.domain)',
      client_uri: 'https://my.domain',
      redirect_uris: ['https://my.domain/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('derives client_id and redirect_uri from the normalized origin', () => {
    expect(clientIdFor('https://my.domain/')).toBe('https://my.domain/.well-known/omnicode/client.json');
    expect(redirectUriFor('https://my.domain/')).toBe('https://my.domain/oauth/callback');
    expect(normalizePublicUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080');
    expect(() => normalizePublicUrl('http://my.domain')).toThrow();
    expect(() => normalizePublicUrl('https://my.domain/base')).toThrow();
  });
});

describe('callback page', () => {
  it('escapes HTML', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('renders without scripts and with lang=ko', () => {
    const ok = renderCallbackPage({ kind: 'success' });
    expect(ok).toContain('<html lang="ko">');
    expect(ok).not.toContain('<script');
    const fail = renderCallbackPage({ kind: 'failure', code: 'oauth_denied' });
    expect(fail).toContain('<code>oauth_denied</code>');
    expect(fail).toContain('거부');
  });
});
