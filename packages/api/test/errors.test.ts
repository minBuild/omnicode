import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError } from '@omnicode/shared';
import {
  AgentdUnavailableError,
  InvalidTransitionError,
  NotFoundError,
  SsrfBlockedError,
  StaleToolHashError,
  UpstreamError,
} from '@omnicode/hub';
import { mapError } from '../src/index.js';
import { HASH_B, makeDetail, makeToolRecord } from './fakeHub.js';
import { authed, json, makeApp, type ErrorResponse, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(() => {
  t = makeApp();
  t.hub.seed(makeDetail({ id: 'fish-audio' }));
});
afterEach(async () => {
  await t.app.close();
});

const probe = () => t.app.inject({ method: 'POST', url: '/api/mcp/servers/fish-audio/probe', headers: authed });

describe('error mapping (14.3)', () => {
  it('ApiError → its status and toJSON()', async () => {
    t.hub.failWith('servers.probe', new ApiError('unsupported_transport', 'stdio는 Phase 2', { transport: 'stdio' }));
    const res = await probe();
    expect(res.statusCode).toBe(422);
    expect(json(res)).toEqual({ error: { code: 'unsupported_transport', message: 'stdio는 Phase 2', details: { transport: 'stdio' } } });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('NotFoundError → 404 not_found', async () => {
    t.hub.failWith('servers.probe', new NotFoundError('server fish-audio'));
    const res = await probe();
    expect(res.statusCode).toBe(404);
    expect(json<ErrorResponse>(res).error).toMatchObject({ code: 'not_found', details: { what: 'server fish-audio' } });
  });

  it('InvalidTransitionError → 409 invalid_transition { from, to }', async () => {
    t.hub.failWith('servers.approve', new InvalidTransitionError('fish-audio', 'draft', 'active'));
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/mcp/servers/fish-audio/approve',
      headers: authed,
      payload: { tools: [] },
    });
    expect(res.statusCode).toBe(409);
    expect(json<ErrorResponse>(res).error).toMatchObject({ code: 'invalid_transition', details: { from: 'draft', to: 'active' } });
  });

  it('StaleToolHashError → 400 stale_tool_hash with current tool views', async () => {
    t.hub.failWith('servers.approve', new StaleToolHashError('fish-audio', [makeToolRecord()]));
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/mcp/servers/fish-audio/approve',
      headers: authed,
      payload: { tools: [{ name: 'text_to_speech', schemaHash: 'a'.repeat(64) }] },
    });
    expect(res.statusCode).toBe(400);
    const body = json<ErrorResponse>(res);
    expect(body.error.code).toBe('stale_tool_hash');
    expect(body.error.details?.tools).toEqual([{ name: 'text_to_speech', schemaHash: HASH_B, description: '설명이 바뀜' }]);
  });

  it('SsrfBlockedError → 400 ssrf_blocked { host, reason, resolved }', async () => {
    t.hub.failWith('servers.create', new SsrfBlockedError('internal.example', 'private address', ['10.0.0.5']));
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/mcp/servers',
      headers: authed,
      payload: { source: 'url', url: 'https://internal.example/mcp' },
    });
    expect(res.statusCode).toBe(400);
    const body = json<ErrorResponse>(res);
    expect(body.error.code).toBe('ssrf_blocked');
    expect(body.error.message).toContain('10.0.0.5');
    expect(body.error.details).toEqual({ host: 'internal.example', reason: 'private address', resolved: ['10.0.0.5'] });
  });

  it('AgentdUnavailableError → 502 agentd_unavailable', async () => {
    t.hub.failWith('sync.all', new AgentdUnavailableError('ECONNREFUSED /run/omnicode/agentd.sock'));
    const res = await t.app.inject({ method: 'POST', url: '/api/mcp/sync', headers: authed });
    expect(res.statusCode).toBe(502);
    expect(json<ErrorResponse>(res).error.code).toBe('agentd_unavailable');
  });

  it('UpstreamError → 422 probe_failed { kind }', async () => {
    t.hub.failWith('servers.probe', new UpstreamError('unavailable', 'connect ECONNREFUSED', { status: 503 }));
    const res = await probe();
    expect(res.statusCode).toBe(422);
    const body = json<ErrorResponse>(res);
    expect(body.error.code).toBe('probe_failed');
    expect(body.error.details).toMatchObject({ kind: 'unavailable', status: 503, lastError: 'connect ECONNREFUSED' });
  });

  it('ZodError thrown by the hub → 400 validation_error', async () => {
    const zerr = z.object({ x: z.number() }).safeParse({ x: 'no' });
    expect(zerr.success).toBe(false);
    if (!zerr.success) t.hub.failWith('servers.probe', zerr.error);
    const res = await probe();
    expect(res.statusCode).toBe(400);
    expect(json<ErrorResponse>(res).error.code).toBe('validation_error');
  });

  it('unknown errors → 500 internal without leaking the message or stack', async () => {
    t.hub.failWith('servers.probe', new Error('boom: token omh_' + 'q'.repeat(43)));
    const res = await probe();
    expect(res.statusCode).toBe(500);
    expect(json(res)).toEqual({ error: { code: 'internal', message: '내부 오류가 발생했습니다.' } });
    expect(res.body).not.toContain('boom');
    expect(res.body).not.toContain('at ');
  });

  it('invalid JSON bodies → 400 invalid_json', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/mcp/servers',
      headers: { ...authed, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(json<ErrorResponse>(res).error.code).toBe('invalid_json');
  });

  it('bodies over 1 MiB → 413 in the same error format', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/mcp/servers',
      headers: { ...authed, 'content-type': 'application/json' },
      payload: JSON.stringify({ source: 'json', json: 'x'.repeat(1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(json<ErrorResponse>(res).error.code).toBe('payload_too_large');
    expect(t.hub.callsTo('servers.create')).toHaveLength(0);
  });

  it('masks known secrets and token-shaped strings in error bodies', async () => {
    t.hub.masker.add('super-secret-value-9876');
    t.hub.failWith('servers.probe', new UpstreamError('protocol', 'upstream said super-secret-value-9876 and Bearer abcdefghijklmnopqrstuvwxyz'));
    const res = await probe();
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain('super-secret-value-9876');
    expect(res.body).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});

describe('mapError (unit)', () => {
  it('flags only server faults as unexpected', () => {
    expect(mapError(new Error('x')).unexpected).toBe(true);
    expect(mapError(new NotFoundError('x')).unexpected).toBe(false);
    expect(mapError(new ApiError('internal')).unexpected).toBe(true);
    expect(mapError(new ApiError('conflict')).status).toBe(409);
    expect(mapError('string').status).toBe(500);
    expect(mapError(null).status).toBe(500);
  });

  it('keeps Fastify 4xx status codes and gives them specific codes (D5)', () => {
    const err = Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 });
    expect(mapError(err)).toMatchObject({ status: 415, body: { error: { code: 'unsupported_media_type' } } });
    const ctp = Object.assign(new Error('Body cannot be empty'), { statusCode: 400, code: 'FST_ERR_CTP_EMPTY_JSON_BODY' });
    expect(mapError(ctp)).toMatchObject({ status: 400, body: { error: { code: 'invalid_json' } } });
    const other = Object.assign(new Error('bad'), { statusCode: 400 });
    expect(mapError(other)).toMatchObject({ status: 400, body: { error: { code: 'validation_error' } } });
    const server = Object.assign(new Error('x'), { statusCode: 503 });
    expect(mapError(server).status).toBe(500);
  });
});
