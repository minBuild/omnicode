import { describe, expect, it } from 'vitest';
import type { HubConfig } from '../../src/contracts.js';
import { createCatalog } from '../../src/services/catalog.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

function catalogWith(body: unknown, opts: { status?: number; registryUrl?: string | null } = {}) {
  const seen: string[] = [];
  const fetch = async (url: string | URL) => {
    seen.push(String(url));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: opts.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  const config = { registryUrl: opts.registryUrl === undefined ? 'https://registry.example' : opts.registryUrl } as HubConfig;
  return { catalog: createCatalog({ config, fetch, logger }), seen };
}

const page = {
  servers: [
    {
      server: {
        name: 'io.fish/audio',
        title: 'Fish Audio',
        description: 'TTS',
        version: '1.2.0',
        websiteUrl: 'https://fish.audio',
        repository: { url: 'https://github.com/fish/mcp', source: 'github' },
        remotes: [
          { type: 'streamable-http', url: 'https://api.fish.audio/mcp', headers: [{ name: 'Authorization' }] },
          { type: 'sse', url: 'https://{region}.fish.audio/sse' },
          { type: 'streamable-http', url: 'http://insecure.example/mcp' },
        ],
      },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
    },
    { server: { name: 'io.x/local', description: 'local only', version: '0.1.0', packages: [{ registryType: 'npm', identifier: 'x', transport: { type: 'stdio' } }] } },
    { server: { name: 'io.gone/old', description: 'deleted', version: '1' }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted' } } },
    { server: { name: 'io.old/dep', description: 'old', version: '2', websiteUrl: 'javascript:alert(1)' }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deprecated' } } },
  ],
  metadata: { nextCursor: 'cur-2', count: 4 },
};

describe('registry catalog (Phase 3)', () => {
  it('is disabled without a configured registry URL and never fetches', async () => {
    const { catalog, seen } = catalogWith(page, { registryUrl: null });
    expect(await catalog.search('fish')).toEqual({ enabled: false, source: null, items: [], nextCursor: null });
    expect(seen).toEqual([]);
  });

  it('queries /v0.1/servers and maps remotes, stdio-only, deleted and deprecated entries safely', async () => {
    const { catalog, seen } = catalogWith(page);
    const r = await catalog.search('fish', 'cur-1');
    expect(seen[0]).toBe('https://registry.example/v0.1/servers?search=fish&limit=20&version=latest&cursor=cur-1');
    expect(r).toMatchObject({ enabled: true, source: 'registry.example', nextCursor: 'cur-2' });
    expect(r.items.map((i) => i.name)).toEqual(['io.fish/audio', 'io.x/local', 'io.old/dep']);
    expect(r.items[0]).toMatchObject({
      title: 'Fish Audio',
      websiteUrl: 'https://fish.audio/',
      repositoryUrl: 'https://github.com/fish/mcp',
      status: 'active',
      stdioOnly: false,
      remotes: [
        { type: 'streamable-http', url: 'https://api.fish.audio/mcp', templated: false, headers: ['Authorization'] },
        { type: 'sse', url: 'https://{region}.fish.audio/sse', templated: true, headers: [] },
      ],
    });
    expect(r.items[1]).toMatchObject({ stdioOnly: true, remotes: [] });
    expect(r.items[2]).toMatchObject({ status: 'deprecated', websiteUrl: null });
  });

  it('reports registry failures as upstream_error', async () => {
    await expect(catalogWith(page, { status: 503 }).catalog.search('x')).rejects.toMatchObject({ code: 'upstream_error' });
    await expect(catalogWith('not json').catalog.search('x')).rejects.toMatchObject({ code: 'upstream_error' });
    await expect(catalogWith({ items: [] }).catalog.search('x')).rejects.toMatchObject({ code: 'upstream_error' });
  });
});
