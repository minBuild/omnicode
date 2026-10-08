import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { LegacyConnector, ModernConnector, createUpstreamConnector, detectEra } from '../../src/upstream/index.js';
import { startLegacySseFixture } from '../fixtures/upstream-legacy-sse.js';
import { closeServer, listen, startLegacyFixture } from '../fixtures/upstream-legacy.js';
import { startModernFixture } from '../fixtures/upstream-modern.js';
import { baseOpts, expectUpstreamError, waitFor } from './helpers.js';

describe('detectEra (design 11.1)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  it('detects a modern server from a 200 server/discover', async () => {
    const f = await startModernFixture();
    cleanups.push(() => f.close());
    const d = await detectEra(baseOpts(f.url));
    expect(d.era).toBe('modern');
    expect(d.result).toMatchObject({
      era: 'modern',
      protocolVersion: '2026-07-28',
      transport: 'streamable_http',
      serverInfo: { name: 'modern-fixture', version: '1.0.0' },
      capabilities: { tools: { listChanged: true } },
      instructions: 'modern fixture',
    });
    if (d.era === 'modern') expect(d.discover.protocolVersions).toEqual(['2026-07-28']);
    const discover = f.requests.filter((r) => r.rpcMethod === 'server/discover');
    expect(discover).toHaveLength(1);
    expect(discover[0]?.headers).toMatchObject({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' });
    expect(f.count('initialize')).toBe(0);
  });

  it('retries server/discover with the version advertised by UnsupportedProtocolVersion', async () => {
    const f = await startModernFixture({ supportedVersions: ['2026-09-01'] });
    cleanups.push(() => f.close());
    const d = await detectEra(baseOpts(f.url));
    expect(d.era).toBe('modern');
    expect(d.result.protocolVersion).toBe('2026-09-01');
    expect(d.result.serverInfo).toMatchObject({ name: 'modern-fixture' });
    expect(f.count('server/discover')).toBe(2);
    expect(f.requests[1]?.headers['mcp-protocol-version']).toBe('2026-09-01');
  });

  it('treats a HeaderMismatch (-32020) answer as modern', async () => {
    const f = await startModernFixture();
    cleanups.push(() => f.close());
    f.rejectNextWith({ status: 400, code: -32020, message: 'HeaderMismatch', data: { header: 'Mcp-Method' } });
    const d = await detectEra(baseOpts(f.url));
    expect(d.era).toBe('modern');
    expect(d.result.protocolVersion).toBe('2026-07-28');
    expect(f.count('initialize')).toBe(0);
  });

  it('falls back to initialize for a legacy streamable HTTP server (SDK -32000 bodies are not modern errors)', async () => {
    const f = await startLegacyFixture();
    cleanups.push(() => f.close());
    const d = await detectEra(baseOpts(f.url));
    expect(d.era).toBe('legacy');
    expect(d.result).toMatchObject({
      era: 'legacy',
      protocolVersion: '2025-11-25',
      transport: 'streamable_http',
      serverInfo: { name: 'legacy-fixture', version: '1.0.0' },
      capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } },
      instructions: 'legacy fixture',
    });
    expect(f.requests[0]?.rpcMethod).toBe('server/discover');
    expect(f.count('initialize')).toBe(1);
    if (d.era === 'legacy') await d.session.client.close();
  });

  it('falls back to HTTP+SSE when streamable HTTP initialize is rejected with 4xx', async () => {
    const f = await startLegacySseFixture();
    cleanups.push(() => f.close());
    const d = await detectEra(baseOpts(f.url));
    expect(d.era).toBe('legacy');
    expect(d.result.transport).toBe('sse');
    expect(d.result.serverInfo).toMatchObject({ name: 'legacy-sse-fixture' });
    expect(d.result.protocolVersion).toBe('2025-11-25');
    if (d.era === 'legacy') {
      expect(d.session.kind).toBe('sse');
      await d.session.client.close();
    }
  });

  it('throws unauthorized with WWW-Authenticate on 401 (modern)', async () => {
    const f = await startModernFixture();
    cleanups.push(() => f.close());
    f.setUnauthorized('Bearer realm="up", resource_metadata="https://up.example/.well-known/oauth-protected-resource"');
    const err = await expectUpstreamError(detectEra(baseOpts(f.url)), 'unauthorized');
    expect(err.info.wwwAuthenticate).toContain('resource_metadata=');
    expect(err.info.status).toBe(401);
    expect(f.count()).toBe(1);
  });

  it('throws unauthorized with WWW-Authenticate on 401 (legacy)', async () => {
    const f = await startLegacyFixture();
    cleanups.push(() => f.close());
    f.setUnauthorized('Bearer realm="legacy"');
    const err = await expectUpstreamError(detectEra(baseOpts(f.url)), 'unauthorized');
    expect(err.info.wwwAuthenticate).toBe('Bearer realm="legacy"');
  });

  it('throws insufficient_scope on 403 insufficient_scope', async () => {
    const f = await startModernFixture();
    cleanups.push(() => f.close());
    f.setUnauthorized('Bearer error="insufficient_scope", scope="tools:read tools:call"', 403);
    const err = await expectUpstreamError(detectEra(baseOpts(f.url)), 'insufficient_scope');
    expect(err.info.scope).toBe('tools:read tools:call');
  });

  it('throws unavailable when no transport answers', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    });
    const url = await listen(server);
    cleanups.push(() => closeServer(server));
    const err = await expectUpstreamError(detectEra(baseOpts(url)), 'unavailable');
    expect(err.info.status).toBe(404);
  });

  it('throws unavailable when the host is unreachable', async () => {
    await expectUpstreamError(detectEra(baseOpts('http://127.0.0.1:1/mcp')), 'unavailable');
  });
});

describe('createUpstreamConnector', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  it('detects modern on connect() and delegates', async () => {
    const f = await startModernFixture();
    cleanups.push(() => f.close());
    const c = createUpstreamConnector(baseOpts(f.url));
    cleanups.push(() => c.close());
    expect(c.protocolVersion).toBe('');
    const probe = await c.connect();
    expect(probe.era).toBe('modern');
    expect(c.era).toBe('modern');
    expect(c.protocolVersion).toBe('2026-07-28');
    expect(c.serverInfo).toMatchObject({ name: 'modern-fixture' });
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toContain('echo');
    expect(f.count('server/discover')).toBe(1);
  });

  it('detects legacy on first use without an explicit connect() and reuses the probe session', async () => {
    const f = await startLegacyFixture();
    cleanups.push(() => f.close());
    const c = createUpstreamConnector(baseOpts(f.url));
    cleanups.push(() => c.close());
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo', 'slow', 'fail']);
    expect(c.era).toBe('legacy');
    expect(c.transport).toBe('streamable_http');
    expect(c.protocolVersion).toBe('2025-11-25');
    expect(f.count('initialize')).toBe(1);
  });

  it('uses the forced era without probing', async () => {
    const f = await startLegacyFixture();
    cleanups.push(() => f.close());
    const legacy = createUpstreamConnector({ ...baseOpts(f.url), era: 'legacy' });
    cleanups.push(() => legacy.close());
    expect(legacy).toBeInstanceOf(LegacyConnector);
    await legacy.connect();
    expect(f.count('server/discover')).toBe(0);
    expect(f.count('initialize')).toBe(1);

    const m = await startModernFixture();
    cleanups.push(() => m.close());
    const modern = createUpstreamConnector({ ...baseOpts(m.url), era: 'modern' });
    cleanups.push(() => modern.close());
    expect(modern).toBeInstanceOf(ModernConnector);
    expect(modern.era).toBe('modern');
    await modern.connect();
    expect(m.count('server/discover')).toBe(1);
  });

  it('keeps onListChanged subscriptions made before detection', async () => {
    const f = await startModernFixture({ keepaliveMs: 20 });
    cleanups.push(() => f.close());
    const c = createUpstreamConnector(baseOpts(f.url));
    cleanups.push(() => c.close());
    const kinds: string[] = [];
    c.onListChanged((k) => kinds.push(k));
    await c.connect();
    await waitFor(() => f.listenerCount() >= 1, 3_000, 'listen stream');
    f.emitListChanged('tools');
    await waitFor(() => kinds.length >= 1, 3_000, 'notification');
    expect(kinds).toEqual(['tools']);
  });

  it('calls onUnauthorized during detection and retries once', async () => {
    const f = await startModernFixture();
    cleanups.push(() => f.close());
    f.setUnauthorized('Bearer realm="up"');
    const seen: Array<string | undefined> = [];
    const c = createUpstreamConnector(
      baseOpts(f.url, {
        onUnauthorized: async (www) => {
          seen.push(www);
          f.setUnauthorized(null);
          return 'retry';
        },
      }),
    );
    cleanups.push(() => c.close());
    const probe = await c.connect();
    expect(probe.era).toBe('modern');
    expect(seen).toEqual(['Bearer realm="up"']);
    expect(f.unauthorizedHits).toBe(1);
  });

  it('fires onClose on close() even before connecting', async () => {
    const c = createUpstreamConnector(baseOpts('http://127.0.0.1:1/mcp'));
    const reasons: Array<string | undefined> = [];
    c.onClose((r) => reasons.push(r));
    await c.close();
    expect(reasons).toEqual(['closed']);
    await expectUpstreamError(c.connect(), 'unavailable');
  });
});
