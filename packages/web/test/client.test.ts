import { describe, expect, it } from 'vitest';
import { ApiClientError, buildQuery, describeError, errorFromBody, isErrorBody, request, type FetchLike } from '../src/api/client';
import { errorMessages, networkErrorMessage } from '../src/i18n/ko';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('errorFromBody (14.3 오류 형식)', () => {
  it('known code → ApiClientError with code, status, details and Korean message', () => {
    const e = errorFromBody(400, {
      error: { code: 'ssrf_blocked', message: '사설 주소(10.0.0.5)로 연결할 수 없습니다.', details: { host: 'internal.example', resolved: '10.0.0.5' } },
    });
    expect(e).toBeInstanceOf(ApiClientError);
    expect(e.code).toBe('ssrf_blocked');
    expect(e.status).toBe(400);
    expect(e.details).toEqual({ host: 'internal.example', resolved: '10.0.0.5' });
    expect(e.serverMessage).toContain('10.0.0.5');
    expect(e.userMessage).toContain(errorMessages.ssrf_blocked);
    expect(e.userMessage).toContain('10.0.0.5');
  });

  it('stale_tool_hash keeps details.tools for re-rendering', () => {
    const e = errorFromBody(400, { error: { code: 'stale_tool_hash', message: 'changed', details: { tools: [{ name: 'a' }] } } });
    expect(e.code).toBe('stale_tool_hash');
    expect(e.details?.['tools']).toEqual([{ name: 'a' }]);
    expect(e.userMessage).toBe(errorMessages.stale_tool_hash);
  });

  it('reauth_required maps to the 401 step-up message', () => {
    const e = errorFromBody(401, { error: { code: 'reauth_required' } });
    expect(e.code).toBe('reauth_required');
    expect(e.status).toBe(401);
    expect(e.userMessage).toBe(errorMessages.reauth_required);
  });

  it('unknown code → unexpected_response but keeps the server message', () => {
    const e = errorFromBody(418, { error: { code: 'teapot', message: 'short and stout' } });
    expect(e.code).toBe('unexpected_response');
    expect(e.status).toBe(418);
    expect(e.userMessage).toBe('short and stout');
  });

  it('non-error-shaped body → unexpected_response with HTTP status', () => {
    const e = errorFromBody(502, '<html>bad gateway</html>');
    expect(e.code).toBe('unexpected_response');
    expect(e.userMessage).toBe('HTTP 502');
  });
});

describe('isErrorBody', () => {
  it('accepts the documented shape and rejects others', () => {
    expect(isErrorBody({ error: { code: 'internal' } })).toBe(true);
    expect(isErrorBody({ error: { code: 'internal', message: 'x', details: { a: 1 } } })).toBe(true);
    expect(isErrorBody({ error: { code: 1 } })).toBe(false);
    expect(isErrorBody({ error: { code: 'x', details: 'nope' } })).toBe(false);
    expect(isErrorBody({ error: 'x' })).toBe(false);
    expect(isErrorBody(null)).toBe(false);
    expect(isErrorBody('str')).toBe(false);
  });
});

describe('buildQuery', () => {
  it('skips undefined, null and empty values', () => {
    expect(buildQuery({ serverId: 'a', agent: undefined, outcome: null, cursor: 0, limit: 50, since: '' })).toBe('?serverId=a&cursor=0&limit=50');
    expect(buildQuery(undefined)).toBe('');
    expect(buildQuery({ a: undefined })).toBe('');
  });
});

describe('request', () => {
  it('sends JSON with same-origin credentials and parses the response', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(201, { id: 'fish-audio', status: 'needs_auth' });
    };
    const res = await request<{ id: string; status: string }>('POST', '/api/mcp/servers', {
      body: { source: 'url', url: 'https://api.fish.audio/mcp' },
      fetchImpl,
    });
    expect(res).toEqual({ id: 'fish-audio', status: 'needs_auth' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('/api/mcp/servers');
    expect(call.init.method).toBe('POST');
    expect(call.init.credentials).toBe('same-origin');
    expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(call.init.body as string)).toEqual({ source: 'url', url: 'https://api.fish.audio/mcp' });
  });

  it('appends query strings for GET', async () => {
    let seen = '';
    const fetchImpl: FetchLike = async (url) => {
      seen = url;
      return jsonResponse(200, { items: [], nextCursor: null });
    };
    await request('GET', '/api/mcp/audit', { query: { agent: 'claude', limit: 20 }, fetchImpl });
    expect(seen).toBe('/api/mcp/audit?agent=claude&limit=20');
  });

  it('rejects with ApiClientError on an error response', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(401, { error: { code: 'reauth_required', message: 'step-up' } });
    await expect(request('POST', '/api/mcp/hub/tokens/rotate', { body: { agents: ['claude'] }, fetchImpl })).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'reauth_required',
      status: 401,
    });
  });

  it('wraps fetch failures as network errors', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    const err = await request('GET', '/api/mcp/servers', { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('network');
    expect((err as ApiClientError).status).toBe(0);
    expect(describeError(err)).toBe(networkErrorMessage);
  });

  it('treats an empty 204 body as undefined', async () => {
    const fetchImpl: FetchLike = async () => new Response(null, { status: 204 });
    await expect(request('PUT', '/api/mcp/servers/x/credentials', { body: { headerName: 'X', value: 'y' }, fetchImpl })).resolves.toBeUndefined();
  });

  it('non-JSON error body → unexpected_response with HTTP status', async () => {
    const fetchImpl: FetchLike = async () => new Response('<html>502</html>', { status: 502 });
    const err = await request('GET', '/api/mcp/servers', { fetchImpl }).catch((e: unknown) => e);
    expect((err as ApiClientError).code).toBe('unexpected_response');
    expect((err as ApiClientError).status).toBe(502);
  });
});

describe('describeError', () => {
  it('falls back for plain errors and unknown values', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(typeof describeError(42)).toBe('string');
  });
});
