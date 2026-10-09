/**
 * 서버 관리 파사드 (HubServers, 14장). 추가 → 탐지 → 인증 → 승인 → 동기화 → 삭제 흐름 (9장).
 */
import {
  AGENTS,
  ApiError,
  SERVER_ID_RE,
  nowIso,
  type Agent,
  type ApproveBody,
  type ApproveResult,
  type CreateServerBody,
  type DeleteResult,
  type PatchServerBody,
  type Preset,
  type ServerDetail,
  type ServerRecord,
  type ServerSummary,
  type TestResult,
  type ToolDefinition,
} from '@omnicode/shared';
import {
  InvalidTransitionError,
  NotFoundError,
  SsrfBlockedError,
  UpstreamError,
  canTransition,
  secretRefFor,
  type GuardedFetch,
  type HubConfig,
  type HubServers,
  type Logger,
  type OAuthManager,
  type OAuthSecret,
  type Registry,
  type SecretStore,
  type ToolUpsertDiff,
} from '../contracts.js';
import type { DownstreamServer } from '../downstream/server.js';
import { idFromEntryName, isEnvPlaceholder, parseMcpServersJson, type McpJsonEntry, type McpJsonHttpEntry } from './mcpJson.js';
import { agentsFromBindings, serverDetail, serverSummary } from './dto.js';
import type { SyncService } from './sync.js';
import type { UpstreamPool } from './upstreamPool.js';

export interface ServersServiceDeps {
  config: HubConfig;
  registry: Registry;
  secrets: SecretStore;
  oauth: OAuthManager;
  pool: UpstreamPool;
  sync: SyncService;
  guard: GuardedFetch;
  presets: () => Preset[];
  downstream: Pick<DownstreamServer, 'notifyListChanged' | 'closeSessionsFor'>;
  masker: { add(secret: string): void };
  logger: Logger;
}

/** 호스트 이름에서 서버 ID 를 만든다: api.fish.audio → fish-audio */
export function deriveServerId(url: string, taken: (id: string) => boolean): string {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = 'server';
  }
  const labels = host.split('.').filter((l) => !['www', 'api', 'mcp', 'app'].includes(l));
  const base = (labels.length >= 2 ? labels.slice(0, -1).join('-') : labels.join('-')).replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'server';
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
}

export interface RefreshOutcome {
  ok: boolean;
  /** 업스트림이 tools/list 에 준 ttlMs (modern). 상태 점검 간격에 쓴다 (17.3) */
  ttlMs: number | null;
  error?: string;
}

/** 상태 점검·list_changed 로 도구 목록을 다시 받는 상태 */
export const REFRESHABLE_STATUSES: ReadonlySet<ServerRecord['status']> = new Set(['active', 'changed', 'error', 'pending_approval']);

export interface ServersService extends HubServers {
  /**
   * 연결을 유지한 채 도구 목록만 다시 받아 상태를 갱신한다 (상태 점검·list_changed 용, D8).
   * 업스트림을 다시 탐지하지 않으므로 진행 중인 호출을 끊지 않는다. 업스트림 실패는 던지지 않고 결과로 돌려주며,
   * 연속 2회 실패해야 error 로 바꾼다 (17.3).
   */
  refreshTools(id: string): Promise<RefreshOutcome>;
}

export function createServersService(deps: ServersServiceDeps): ServersService {
  const warnings = new Map<string, string[]>();

  const must = (id: string): ServerRecord => {
    const rec = deps.registry.servers.get(id);
    if (!rec) throw new NotFoundError(`server ${id}`);
    return rec;
  };

  /** OAuth 매니저는 "사전 등록 입력 필요"를 client_mode=preregistered + 빈 client_id 로 표현한다 */
  const computeNeedsClientInput = async (rec: ServerRecord): Promise<boolean> => {
    if (rec.auth_type !== 'oauth' || rec.status !== 'needs_auth') return false;
    if (rec.oauth_client_mode === null) return true;
    if (rec.oauth_client_mode !== 'preregistered' || !rec.secret_ref) return false;
    const secret = await deps.secrets.get<OAuthSecret>(rec.secret_ref).catch(() => undefined);
    return !secret || secret.type !== 'oauth' || !secret.client_id;
  };

  const detail = async (id: string): Promise<ServerDetail> => {
    const rec = must(id);
    const tools = deps.registry.tools.listByServer(id);
    const bindings = deps.registry.bindings.listByServer(id);
    const expiresAt = rec.auth_type === 'oauth' ? await deps.oauth.expiresAt(id).catch(() => null) : null;
    const needsClientInput = await computeNeedsClientInput(rec);
    const recentEvents = deps.registry.events.list({ serverId: id, limit: 10 }).items;
    const w = [...(warnings.get(id) ?? [])];
    if (rec.transport === 'sse') w.push('deprecated_transport');
    return serverDetail(rec, tools, bindings, { expiresAt, needsClientInput, recentEvents, warnings: w });
  };

  const setStatus = (id: string, to: ServerRecord['status'], lastError: string | null = null) => {
    const rec = must(id);
    if (rec.status === to) return rec;
    if (!canTransition(rec.status, to)) throw new InvalidTransitionError(id, rec.status, to);
    return deps.registry.servers.setStatus(id, to, { lastError });
  };

  /** 연속 갱신 실패 수 (상태 점검·list_changed). 사용자 재탐지·성공 시 0 */
  const refreshFailures = new Map<string, number>();

  /** 도구 목록 반영 + 상태 전진 (9.3 단계 5, 16.5) */
  function applyTools(id: string, defs: ToolDefinition[]): ToolUpsertDiff {
    const diff = deps.registry.tools.upsertFromUpstream(id, defs);
    deps.registry.servers.update(id, { tools_synced_at: nowIso(), last_error: null });
    const tools = deps.registry.tools.listByServer(id);
    const anyApproved = tools.some((t) => t.approved_hash !== null);
    const anyChanged = tools.some((t) => t.approved_hash !== null && t.approved_hash !== t.schema_hash);
    const current = must(id).status;
    let next: ServerRecord['status'] = current;
    if (current === 'draft' || current === 'needs_auth' || current === 'error' || current === 'pending_approval') {
      next = anyApproved ? (anyChanged ? 'changed' : 'active') : 'pending_approval';
    } else if (current === 'active' && anyChanged) next = 'changed';
    else if (current === 'changed' && !anyChanged) next = 'active';
    if (next !== current && canTransition(current, next)) deps.registry.servers.setStatus(id, next);
    return diff;
  }

  async function announceToolChanges(id: string, diff: ToolUpsertDiff): Promise<void> {
    if (diff.changed.length || diff.added.length || diff.removed.length) {
      deps.registry.events.add({ kind: 'tools.changed', server_id: id, actor: 'hub', details: diff });
      await deps.downstream.notifyListChanged(id, 'tools');
    }
  }

  /** 401·403: header 인증이면 needs_auth, 아니면 OAuth 탐색으로 넘긴다 (10.3). prepare 실패는 ApiError 로 던진다 */
  async function handleAuthFailure(id: string, e: UpstreamError): Promise<void> {
    const fresh = must(id);
    if (fresh.auth_type === 'header') {
      if (fresh.status !== 'needs_auth' && canTransition(fresh.status, 'needs_auth')) deps.registry.servers.setStatus(id, 'needs_auth', { lastError: 'API 키가 필요하거나 틀렸습니다' });
      return;
    }
    if (fresh.auth_type === 'none') deps.registry.servers.update(id, { auth_type: 'oauth', secret_ref: secretRefFor(deps.config.secretsPrefix, id) });
    try {
      await deps.oauth.prepare(id, e.info.wwwAuthenticate);
    } catch (pe) {
      const msg = pe instanceof Error ? pe.message : String(pe);
      deps.logger.warn({ serverId: id, err: msg }, 'oauth prepare failed');
      const now = must(id);
      if (canTransition(now.status, 'needs_auth')) deps.registry.servers.setStatus(id, 'needs_auth', { lastError: msg });
      else deps.registry.servers.update(id, { last_error: msg });
      throw new ApiError('oauth_registration_failed', msg);
    }
  }

  /**
   * 업스트림을 새로 탐지하고(연결을 끊고 다시 맺는다) 도구 목록을 반영한다 (9.3 단계 3·5).
   * 추가·키 입력·사용자의 [다시 탐지]에서만 쓴다 — 진행 중인 호출이 끊기기 때문이다.
   */
  async function probeAndAdvance(id: string): Promise<void> {
    const rec = must(id);
    if (rec.status === 'deleting') return;
    try {
      const result = await deps.pool.probe(id);
      const connector = await deps.pool.get(id);
      const defs = await connector.listTools();
      refreshFailures.delete(id);
      const diff = applyTools(id, defs);
      warnings.set(id, result.transport === 'sse' ? ['deprecated_transport'] : []);
      deps.registry.events.add({ kind: 'probe', server_id: id, actor: 'hub', details: { era: result.era, version: result.protocolVersion, transport: result.transport, tools: diff } });
      await announceToolChanges(id, diff);
    } catch (e) {
      if (e instanceof UpstreamError && (e.kind === 'unauthorized' || e.kind === 'insufficient_scope')) {
        await handleAuthFailure(id, e);
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      const fresh = must(id);
      if (fresh.status === 'draft' || fresh.status === 'active' || fresh.status === 'changed' || fresh.status === 'needs_auth' || fresh.status === 'pending_approval') {
        if (canTransition(fresh.status, 'error')) deps.registry.servers.setStatus(id, 'error', { lastError: msg });
      } else deps.registry.servers.update(id, { last_error: msg });
      deps.registry.events.add({ kind: 'probe', server_id: id, actor: 'hub', details: { error: msg } });
      throw new ApiError('probe_failed', msg, { lastError: msg });
    }
  }

  async function refreshTools(id: string): Promise<RefreshOutcome> {
    const rec = deps.registry.servers.get(id);
    if (!rec || !REFRESHABLE_STATUSES.has(rec.status)) return { ok: false, ttlMs: null, error: 'not_refreshable' };
    try {
      const connector = await deps.pool.get(id);
      const defs = await connector.listTools();
      refreshFailures.delete(id);
      const wasError = rec.status === 'error';
      const diff = applyTools(id, defs);
      if (wasError && must(id).status !== 'error') {
        deps.registry.events.add({ kind: 'server.updated', server_id: id, actor: 'hub', details: { recovered: true } });
      }
      await announceToolChanges(id, diff);
      return { ok: true, ttlMs: connector.lastToolsTtlMs };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof UpstreamError && (e.kind === 'unauthorized' || e.kind === 'insufficient_scope')) {
        await handleAuthFailure(id, e).catch(() => undefined);
        return { ok: false, ttlMs: null, error: msg };
      }
      const failures = (refreshFailures.get(id) ?? 0) + 1;
      refreshFailures.set(id, failures);
      deps.logger.info({ serverId: id, failures, err: msg }, 'tools refresh failed');
      const fresh = deps.registry.servers.get(id);
      if (fresh && failures >= 2 && fresh.status !== 'error' && canTransition(fresh.status, 'error')) {
        deps.registry.servers.setStatus(id, 'error', { lastError: msg });
        deps.registry.events.add({ kind: 'health.error', server_id: id, actor: 'hub', details: { failures, error: msg } });
      } else if (fresh) {
        deps.registry.servers.update(id, { last_error: msg });
      }
      return { ok: false, ttlMs: null, error: msg };
    }
  }

  async function validateUrl(url: string): Promise<string> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ApiError('invalid_url', 'URL 형식이 올바르지 않습니다');
    }
    if (u.protocol !== 'https:' && !(deps.config.allowHttpLoopback && u.protocol === 'http:')) throw new ApiError('invalid_url', 'https URL만 허용됩니다');
    const decision = await deps.guard.check(u);
    if (!decision.ok) throw new SsrfBlockedError(decision.host, decision.reason ?? 'blocked', decision.addresses);
    u.hash = '';
    return u.toString();
  }

  /** 붙여 넣은 JSON 에서 추가할 http 항목 하나를 고른다 (C2). 여러 개면 화면이 고르도록 목록을 돌려준다 */
  function pickJsonEntry(json: string, entryName: string | undefined): McpJsonHttpEntry {
    const entries = parseMcpServersJson(json);
    const list = entries.map((e) => (e.kind === 'http' ? { name: e.name, kind: e.kind, url: e.url } : { name: e.name, kind: e.kind, command: e.command }));
    let entry: McpJsonEntry | undefined;
    if (entryName !== undefined) {
      entry = entries.find((e) => e.name === entryName);
      if (!entry) throw new ApiError('validation_error', `'${entryName}' 항목이 없습니다.`, { entries: list });
    } else if (entries.length === 1) {
      entry = entries[0];
    } else {
      throw new ApiError('validation_error', '서버가 여러 개입니다. 추가할 항목을 고르세요.', { entries: list });
    }
    if (!entry) throw new ApiError('validation_error', 'MCP 서버 항목을 찾지 못했습니다.');
    if (entry.kind === 'stdio') {
      throw new ApiError('unsupported_transport', 'stdio 서버는 실행 샌드박스(Phase 2)가 준비될 때까지 추가할 수 없습니다. 원격(URL) 서버만 추가할 수 있습니다.', {
        name: entry.name,
        command: entry.command,
      });
    }
    if (Object.keys(entry.headers).length > 1) {
      throw new ApiError('validation_error', '헤더는 인증 헤더 하나만 지원합니다.', { headers: Object.keys(entry.headers) });
    }
    return entry;
  }

  return {
    list(): ServerSummary[] {
      return deps.registry.servers.list().map((rec) => serverSummary(rec, deps.registry.tools.listByServer(rec.id), deps.registry.bindings.listByServer(rec.id)));
    },

    get: (id) => (deps.registry.servers.get(id) ? detail(id) : Promise.resolve(undefined)),

    refreshTools,

    async create(input: CreateServerBody): Promise<ServerDetail> {
      let url: string;
      let displayName = input.displayName;
      let preset: Preset | undefined;
      let jsonEntry: McpJsonHttpEntry | undefined;
      if (input.source === 'preset') {
        preset = deps.presets().find((p) => p.id === input.presetId);
        if (!preset) throw new ApiError('not_found', `프리셋 ${input.presetId}을 찾을 수 없습니다`);
        url = preset.url;
        displayName ??= preset.displayName;
      } else if (input.source === 'url' || input.source === 'registry') {
        // registry: 검색 결과의 원격 URL. 이후 절차는 URL 추가와 같다 (탐지·SSRF 검사 포함)
        url = input.url as string;
      } else {
        jsonEntry = pickJsonEntry(input.json as string, input.entry);
        url = jsonEntry.url;
        displayName ??= jsonEntry.name;
      }
      url = await validateUrl(url);
      const taken = (cand: string) => !!deps.registry.servers.get(cand);
      const fromEntry = jsonEntry ? idFromEntryName(jsonEntry.name) : '';
      const id =
        input.id ??
        (preset && !taken(preset.id) ? preset.id : fromEntry && SERVER_ID_RE.test(fromEntry) && !taken(fromEntry) ? fromEntry : deriveServerId(url, taken));
      if (!SERVER_ID_RE.test(id)) throw new ApiError('validation_error', 'id 형식이 올바르지 않습니다');
      if (taken(id)) throw new ApiError('conflict', `id '${id}'가 이미 있습니다`);
      // JSON 의 헤더 하나는 header 인증으로 본다. 값이 ${VAR} 같은 자리표시자면 키를 따로 입력받는다
      const jsonHeader = jsonEntry ? Object.entries(jsonEntry.headers)[0] : undefined;
      const authType = preset?.auth.type === 'header' || jsonHeader ? 'header' : preset?.auth.type === 'oauth' ? 'oauth' : 'none';
      const ts = nowIso();
      deps.registry.servers.insert({
        id,
        display_name: displayName ?? new URL(url).hostname,
        source: input.source,
        preset_id: preset?.id ?? null,
        transport: preset?.transport ?? jsonEntry?.transportHint ?? 'streamable_http',
        url,
        canonical_url: null,
        command: null,
        args_json: null,
        env_keys_json: null,
        auth_type: authType,
        header_name: preset?.auth.headerName ?? jsonHeader?.[0] ?? null,
        secret_ref: authType === 'none' ? null : secretRefFor(deps.config.secretsPrefix, id),
        oauth_issuer: null,
        oauth_client_mode: null,
        oauth_prm_url: null,
        requested_scope: preset?.auth.scopes?.join(' ') ?? null,
        granted_scope: null,
        protocol_era: null,
        protocol_version: null,
        server_info_json: null,
        capabilities_json: null,
        call_timeout_ms: deps.config.callTimeoutMs,
        cli_auto_approve: 1,
        status: 'draft',
        last_error: null,
        last_probe_at: null,
        tools_synced_at: null,
        created_at: ts,
        updated_at: ts,
      });
      for (const agent of preset?.defaultAgents ?? AGENTS) deps.registry.bindings.upsert(id, agent, true);
      deps.registry.events.add({
        kind: 'server.created',
        server_id: id,
        actor: 'user',
        details: { source: input.source, url, presetId: preset?.id ?? null, ...(jsonEntry ? { entry: jsonEntry.name, headerName: jsonHeader?.[0] ?? null } : {}) },
      });
      if (jsonHeader && !isEnvPlaceholder(jsonHeader[1])) {
        // 붙여 넣은 키는 시크릿에만 둔다 (16.6). 그 뒤 탐지
        const ref = secretRefFor(deps.config.secretsPrefix, id);
        await deps.secrets.put(ref, { type: 'header', header_name: jsonHeader[0], value: jsonHeader[1] });
        deps.masker.add(jsonHeader[1]);
        deps.registry.events.add({ kind: 'credentials.saved', server_id: id, actor: 'user', details: { headerName: jsonHeader[0] } });
        await probeAndAdvance(id).catch((e) => deps.logger.info({ serverId: id, err: String(e) }, 'initial probe did not complete'));
      } else if (authType === 'header') {
        // 키를 받기 전에는 탐지해도 401 이 뻔하다. 바로 needs_auth 로 둔다 (S2)
        deps.registry.servers.setStatus(id, 'needs_auth', { lastError: null });
      } else {
        await probeAndAdvance(id).catch((e) => deps.logger.info({ serverId: id, err: String(e) }, 'initial probe did not complete'));
      }
      return detail(id);
    },

    async patch(id, patch: PatchServerBody) {
      const rec = must(id);
      if (rec.status === 'deleting') throw new InvalidTransitionError(id, rec.status, rec.status);
      let resync = false;
      let notify = false;
      if (patch.displayName !== undefined) deps.registry.servers.update(id, { display_name: patch.displayName });
      if (patch.callTimeoutMs !== undefined) {
        deps.registry.servers.update(id, { call_timeout_ms: patch.callTimeoutMs });
        resync = true;
      }
      if (patch.cliAutoApprove !== undefined) {
        deps.registry.servers.update(id, { cli_auto_approve: patch.cliAutoApprove ? 1 : 0 });
        resync = true;
      }
      if (patch.tools) {
        for (const t of patch.tools) deps.registry.tools.setEnabled(id, t.name, t.enabled);
        notify = true;
      }
      if (patch.bindings) {
        for (const agent of AGENTS) {
          const v = patch.bindings[agent];
          if (v === undefined) continue;
          deps.registry.bindings.upsert(id, agent, v);
          deps.registry.events.add({ kind: 'binding.changed', server_id: id, agent, actor: 'user', details: { enabled: v } });
        }
        resync = true;
        notify = true;
      }
      if (patch.enabled !== undefined) {
        const current = must(id);
        if (patch.enabled === false && current.status !== 'disabled') {
          setStatus(id, 'disabled');
          deps.registry.events.add({ kind: 'server.disabled', server_id: id, actor: 'user' });
          await deps.pool.evict(id);
          notify = true;
        } else if (patch.enabled === true && current.status === 'disabled') {
          const tools = deps.registry.tools.listByServer(id);
          const anyChanged = tools.some((t) => t.approved_hash !== null && t.approved_hash !== t.schema_hash);
          setStatus(id, anyChanged ? 'changed' : 'active');
          deps.registry.events.add({ kind: 'server.enabled', server_id: id, actor: 'user' });
          notify = true;
        }
      }
      deps.registry.events.add({ kind: 'server.updated', server_id: id, actor: 'user', details: { fields: Object.keys(patch) } });
      if (resync) await deps.sync.server(id);
      if (notify) await deps.downstream.notifyListChanged(id, 'tools');
      return detail(id);
    },

    async approve(id, body: ApproveBody): Promise<ApproveResult> {
      const rec = must(id);
      if (!['pending_approval', 'changed', 'active'].includes(rec.status)) throw new InvalidTransitionError(id, rec.status, 'active');
      deps.registry.tools.approve(id, body.tools.map((t) => ({ name: t.name, schemaHash: t.schemaHash, enabled: t.enabled ?? true })));
      if (body.bindings) {
        const enabledAgents = agentsFromBindings(body.bindings, []);
        for (const agent of AGENTS) if (body.bindings[agent] !== undefined) deps.registry.bindings.upsert(id, agent, enabledAgents.includes(agent));
      }
      const tools = deps.registry.tools.listByServer(id);
      const anyChanged = tools.some((t) => t.approved_hash !== null && t.approved_hash !== t.schema_hash);
      const next: ServerRecord['status'] = anyChanged ? 'changed' : 'active';
      if (must(id).status !== next) setStatus(id, next);
      deps.registry.events.add({ kind: 'tools.approved', server_id: id, actor: 'user', details: { tools: body.tools.map((t) => t.name) } });
      const sync = await deps.sync.server(id);
      await deps.downstream.notifyListChanged(id, 'tools');
      return { status: must(id).status, approved: body.tools.map((t) => t.name), sync };
    },

    async probe(id) {
      must(id);
      await deps.pool.evict(id);
      await probeAndAdvance(id);
      return detail(id);
    },

    async test(id): Promise<TestResult> {
      const rec = must(id);
      const started = Date.now();
      try {
        const c = await deps.pool.get(id);
        await c.listTools();
        return { ok: true, latencyMs: Date.now() - started, error: null, protocol: { era: c.era, version: c.protocolVersion } };
      } catch (e) {
        return { ok: false, latencyMs: null, error: e instanceof Error ? e.message : String(e), protocol: { era: rec.protocol_era, version: rec.protocol_version } };
      }
    },

    async delete(id, opts = {}): Promise<DeleteResult> {
      const rec = must(id);
      const steps: DeleteResult['steps'] = [];
      if (rec.status !== 'deleting') {
        deps.registry.servers.setStatus(id, 'deleting');
        await deps.downstream.notifyListChanged(id, 'tools');
        await deps.downstream.closeSessionsFor(id);
        await deps.pool.evict(id);
      }
      steps.push({ step: 'block', ok: true });
      const outcomes = await deps.sync.all();
      const failed = AGENTS.filter((a) => outcomes[a].status === 'failed' && (deps.registry.bindings.get(id, a)?.enabled ?? 0) === 1);
      if (failed.length > 0 && !opts.force) {
        steps.push({ step: 'sync', ok: false, error: failed.map((a) => `${a}: ${outcomes[a].error ?? 'failed'}`).join('; ') });
        return { status: 'deleting', steps };
      }
      steps.push({ step: 'sync', ok: failed.length === 0, ...(failed.length ? { error: 'forced' } : {}) });
      if (rec.auth_type === 'oauth') {
        try {
          await deps.oauth.revoke(id);
          steps.push({ step: 'revoke', ok: true });
        } catch (e) {
          steps.push({ step: 'revoke', ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (rec.secret_ref) {
        try {
          await deps.secrets.delete(rec.secret_ref);
          steps.push({ step: 'secret', ok: true });
        } catch (e) {
          steps.push({ step: 'secret', ok: false, error: e instanceof Error ? e.message : String(e) });
          return { status: 'deleting', steps };
        }
      }
      deps.registry.servers.delete(id);
      warnings.delete(id);
      deps.registry.events.add({ kind: 'server.deleted', server_id: id, actor: 'user', details: { forced: !!opts.force } });
      steps.push({ step: 'row', ok: true });
      return { status: 'deleted', steps };
    },

    async setCredentials(id, headerName, value) {
      const rec = must(id);
      if (rec.auth_type === 'oauth') throw new ApiError('conflict', '이 서버는 OAuth 인증을 씁니다');
      const ref = secretRefFor(deps.config.secretsPrefix, id);
      await deps.secrets.put(ref, { type: 'header', header_name: headerName, value });
      deps.masker.add(value);
      deps.registry.servers.update(id, { auth_type: 'header', header_name: headerName, secret_ref: ref });
      deps.registry.events.add({ kind: 'credentials.saved', server_id: id, actor: 'user', details: { headerName } });
      await deps.pool.evict(id);
      await probeAndAdvance(id).catch((e) => deps.logger.info({ serverId: id, err: String(e) }, 'probe after credentials failed'));
    },
  };
}
