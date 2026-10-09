/**
 * MCP Registry 호환 API 검색 (설계 0001 9.1·미결 5, handoff D — Phase 3).
 * GET {registryUrl}/v0.1/servers?search=&limit=&version=latest&cursor= — 항목은 { server, _meta } 로 감싸져 온다.
 * 기본 소스는 정하지 않는다: OMNICODE_MCP_REGISTRY_URL 이 없으면 검색을 끈다.
 * 레지스트리 응답은 신뢰하지 않는 입력이다 — 모양을 검증하고, 화면은 텍스트로만 그린다 (16.3).
 */
import { z } from 'zod';
import { ApiError, type RegistryRemoteView, type RegistrySearchResult, type RegistryServerView } from '@omnicode/shared';
import type { FetchLike, HubCatalog, HubConfig, Logger } from '../contracts.js';

const PAGE_SIZE = 20;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

const RemoteSchema = z
  .object({
    type: z.string(),
    url: z.string().max(2048),
    headers: z.array(z.object({ name: z.string().max(200) }).loose()).optional(),
  })
  .loose();

const ServerDetailSchema = z
  .object({
    name: z.string().min(1).max(200),
    title: z.string().max(100).optional(),
    description: z.string().max(1000).default(''),
    version: z.string().max(255).default(''),
    websiteUrl: z.string().max(2048).optional(),
    repository: z.object({ url: z.string().max(2048) }).loose().optional(),
    remotes: z.array(RemoteSchema).optional(),
    packages: z.array(z.unknown()).optional(),
  })
  .loose();

const ListSchema = z
  .object({
    servers: z.array(
      z
        .object({
          server: ServerDetailSchema,
          _meta: z.record(z.string(), z.unknown()).optional(),
        })
        .loose(),
    ),
    metadata: z.object({ nextCursor: z.string().nullable().optional() }).loose().optional(),
  })
  .loose();

const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';

function httpsOnly(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function toRemote(r: z.infer<typeof RemoteSchema>): RegistryRemoteView | null {
  if (r.type !== 'streamable-http' && r.type !== 'sse') return null;
  const templated = /\{[^}]+\}/.test(r.url);
  if (!templated && !httpsOnly(r.url)) return null; // http·기타 스킴은 보이지 않는다 (16.2 https 만)
  return { type: r.type, url: r.url, templated, headers: (r.headers ?? []).map((h) => h.name) };
}

export function toServerView(item: z.infer<typeof ListSchema>['servers'][number]): RegistryServerView | null {
  const official = item._meta?.[OFFICIAL_META];
  const statusRaw = typeof official === 'object' && official !== null ? (official as { status?: unknown }).status : undefined;
  if (statusRaw === 'deleted') return null;
  const s = item.server;
  const remotes = (s.remotes ?? []).map(toRemote).filter((r): r is RegistryRemoteView => r !== null);
  return {
    name: s.name,
    title: s.title ?? null,
    description: s.description,
    version: s.version,
    websiteUrl: httpsOnly(s.websiteUrl),
    repositoryUrl: httpsOnly(s.repository?.url),
    remotes,
    stdioOnly: remotes.length === 0 && (s.packages?.length ?? 0) > 0,
    status: statusRaw === 'active' || statusRaw === 'deprecated' ? statusRaw : null,
  };
}

export function createCatalog(deps: { config: HubConfig; fetch: FetchLike; logger: Logger }): HubCatalog {
  return {
    async search(q, cursor) {
      const base = deps.config.registryUrl;
      if (!base) return { enabled: false, source: null, items: [], nextCursor: null } satisfies RegistrySearchResult;
      const url = new URL(`${base}/v0.1/servers`);
      if (q) url.searchParams.set('search', q);
      url.searchParams.set('limit', String(PAGE_SIZE));
      url.searchParams.set('version', 'latest');
      if (cursor) url.searchParams.set('cursor', cursor);

      let res: Response;
      try {
        res = await deps.fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (e) {
        deps.logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'registry search failed');
        throw new ApiError('upstream_error', '레지스트리에 연결할 수 없습니다.');
      }
      if (!res.ok) throw new ApiError('upstream_error', `레지스트리가 HTTP ${res.status} 을 돌려주었습니다.`, { status: res.status });
      const text = await res.text();
      if (text.length > MAX_BODY_BYTES) throw new ApiError('upstream_error', '레지스트리 응답이 너무 큽니다.');
      let parsed: z.infer<typeof ListSchema>;
      try {
        parsed = ListSchema.parse(JSON.parse(text));
      } catch {
        throw new ApiError('upstream_error', '레지스트리 응답 형식을 알 수 없습니다 (MCP Registry v0.1 호환이어야 합니다).');
      }
      const items = parsed.servers.map(toServerView).filter((v): v is RegistryServerView => v !== null);
      const next = parsed.metadata?.nextCursor;
      return { enabled: true, source: new URL(base).host, items, nextCursor: typeof next === 'string' && next !== '' ? next : null };
    },
  };
}
