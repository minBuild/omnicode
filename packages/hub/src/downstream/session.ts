/**
 * 다운스트림 세션 하나 = SDK Server 하나. 에이전트(토큰)와 업스트림 서버 ID에 묶인다.
 * 요청마다 레지스트리를 읽어 11.8 정책을 적용하고, 업스트림 커넥터로 전달한다.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';
import { DEFAULTS, HubError, JOB_ID_RE, LIMITS, sha256Hex, type Agent, type AuditEntry, type ToolRecord } from '@omnicode/shared';
import { UpstreamError, isLoggingLevel, type CallContext, type LogMessageNotification, type LoggingLevel, type UpstreamConnector } from '../contracts.js';
import type { DownstreamDeps } from './deps.js';
import type { Limiter } from './limiter.js';
import { authorizeCall, visibleTools, type PolicyInput } from './policy.js';

export interface SessionContext {
  agent: Agent;
  serverId: string;
}

/** 이 세션의 리소스 구독 (C3). server.ts 가 세션별로 만든다 */
export interface SessionSubscriptions {
  add(uri: string): Promise<void>;
  remove(uri: string): Promise<void>;
}

type HeaderBag = Record<string, string | string[] | undefined>;

function header(h: HeaderBag | undefined, name: string): string | undefined {
  if (!h) return undefined;
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function mcpParamHeaders(h: HeaderBag | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase().startsWith('mcp-param-') && v !== undefined) out[k] = Array.isArray(v) ? (v[0] ?? '') : v;
  }
  return out;
}

export function toolRecordToTool(t: ToolRecord): Record<string, unknown> {
  const def = JSON.parse(t.definition_json) as Record<string, unknown>;
  const tool: Record<string, unknown> = { name: t.name, inputSchema: def.inputSchema ?? { type: 'object' } };
  if (def.title !== undefined) tool.title = def.title;
  if (def.description !== undefined) tool.description = def.description;
  if (def.outputSchema !== undefined) tool.outputSchema = def.outputSchema;
  if (def.annotations !== undefined) tool.annotations = def.annotations;
  return tool;
}

/** 업스트림 오류 → 에이전트에게 돌려줄 JSON-RPC 오류 (11.9) */
export function mapUpstreamError(e: UpstreamError, serverLabel: string, timeoutMs: number): McpError {
  switch (e.kind) {
    case 'unauthorized':
    case 'insufficient_scope':
      return fromHub(new HubError('upstream_auth_required', { server: serverLabel }));
    case 'timeout':
      return fromHub(new HubError('upstream_timeout', { seconds: Math.round(timeoutMs / 1000) }));
    case 'too_large':
      return fromHub(new HubError('response_too_large', { mb: Math.round(LIMITS.callResultBytes / (1024 * 1024)) }));
    case 'input_required':
      return fromHub(new HubError('input_required_unsupported'));
    case 'protocol':
      return new McpError(e.info.rpc?.code ?? -32603, e.info.rpc?.message ?? e.message, e.info.rpc?.data);
    case 'unavailable':
    default:
      return fromHub(new HubError('upstream_unavailable', { reason: e.message.slice(0, 200) }));
  }
}

export function fromHub(e: HubError): McpError {
  return new McpError(e.rpc.code, e.rpc.message, e.rpc.data);
}

export function createSessionServer(
  deps: DownstreamDeps,
  ctx: SessionContext,
  limiter: Limiter,
  capabilities: ServerCapabilities,
  subs?: SessionSubscriptions,
): Server {
  const now = deps.now ?? (() => new Date());
  const server = new Server({ name: 'omnicode-hub', version: deps.config.version }, { capabilities });

  const policyInput = (): PolicyInput | undefined => {
    const rec = deps.registry.servers.get(ctx.serverId);
    if (!rec) return undefined;
    return {
      server: rec,
      binding: deps.registry.bindings.get(ctx.serverId, ctx.agent),
      tools: deps.registry.tools.listByServer(ctx.serverId),
      agent: ctx.agent,
    };
  };

  const label = () => deps.registry.servers.get(ctx.serverId)?.display_name ?? ctx.serverId;

  /** 이 세션이 logging/setLevel 로 요청한 최소 수준 (D1). 업스트림으로는 보내지 않는다 (11.3) */
  let sessionLogLevel: LoggingLevel | undefined;

  /**
   * 업스트림 문자열을 에이전트에 넘기기 전에 Hub 가 아는 비밀값을 가린다 (16.6).
   * 업스트림이 자기 요청 헤더(우리의 access token)를 로그에 찍는 경우를 막는다.
   */
  const maskValue = (v: unknown): unknown => {
    let json: string | undefined;
    try {
      json = JSON.stringify(v);
    } catch {
      return '[unserializable]';
    }
    if (json === undefined) return v;
    const masked = deps.masker.mask(json);
    if (masked === json) return v;
    try {
      return JSON.parse(masked) as unknown;
    } catch {
      return masked;
    }
  };

  const audit = (entry: Omit<AuditEntry, 'id' | 'ts' | 'agent' | 'server_id'>) =>
    deps.audit.record({ ts: now().toISOString(), agent: ctx.agent, server_id: ctx.serverId, ...entry });

  /** 전달 메서드(resources/prompts/completion)의 상태 검사: 도구 검사만 뺀 authorizeCall */
  const authorizeForward = (input: PolicyInput) => {
    const { server: s, binding } = input;
    if (s.status === 'deleting') throw new HubError('server_deleting');
    if (s.status === 'disabled') throw new HubError('server_disabled');
    if (!binding || binding.enabled !== 1) throw new HubError('binding_disabled', { agent: ctx.agent });
    if (s.status === 'needs_auth') throw new HubError('upstream_auth_required', { server: s.display_name || s.id });
    if (s.status === 'pending_approval' || s.status === 'draft') throw new HubError('tool_not_approved', { server: s.display_name || s.id });
  };

  const buildCtx = (extra: { signal: AbortSignal; requestInfo?: { headers: HeaderBag }; _meta?: { progressToken?: string | number }; sendNotification: (n: never) => Promise<void> }, timeoutMs: number): { call: CallContext; jobId?: string; stop: () => void } => {
    const headers = extra.requestInfo?.headers;
    const rawJob = header(headers, 'x-omnicode-job');
    const jobId = rawJob && JOB_ID_RE.test(rawJob) ? rawJob : undefined;
    const progressToken = extra._meta?.progressToken;
    const startedAt = now().getTime();
    let lastProgressAt = startedAt;
    const send = (n: { progress: number; total?: number; message?: string }) => {
      if (progressToken === undefined) return;
      const notification = { method: 'notifications/progress', params: { ...n, progressToken } };
      void (extra.sendNotification as unknown as (n: unknown) => Promise<void>)(notification).catch(() => undefined);
    };
    const heartbeat =
      progressToken !== undefined
        ? setInterval(() => {
            if (now().getTime() - lastProgressAt >= DEFAULTS.syntheticProgressIntervalMs - 50) {
              send({ progress: Math.round((now().getTime() - startedAt) / 1000), message: 'in progress (omnicode-hub heartbeat)' });
              lastProgressAt = now().getTime();
            }
          }, DEFAULTS.syntheticProgressIntervalMs)
        : undefined;
    const sendMessage = (n: LogMessageNotification) => {
      const params = { level: n.level, ...(n.logger !== undefined ? { logger: deps.masker.mask(n.logger) } : {}), data: maskValue(n.data) };
      void (extra.sendNotification as unknown as (n: unknown) => Promise<void>)({ method: 'notifications/message', params }).catch(() => undefined);
    };
    const call: CallContext = {
      agent: ctx.agent,
      ...(jobId ? { jobId } : {}),
      signal: extra.signal,
      downstreamEra: 'legacy',
      mcpParamHeaders: mcpParamHeaders(headers),
      onProgress: (n) => {
        lastProgressAt = now().getTime();
        send({
          progress: n.progress,
          ...(n.total !== undefined ? { total: n.total } : {}),
          ...(n.message !== undefined ? { message: deps.masker.mask(n.message) } : {}),
        });
      },
      timeoutMs,
      idleTimeoutMs: deps.config.idleTimeoutMs,
      ...(deps.config.forwardLogMessages ? { onMessage: sendMessage, ...(sessionLogLevel ? { logLevel: sessionLogLevel } : {}) } : {}),
    };
    return { call, ...(jobId ? { jobId } : {}), stop: () => heartbeat && clearInterval(heartbeat) };
  };

  const getConnector = async (): Promise<UpstreamConnector> => {
    try {
      return await deps.connectors.get(ctx.serverId);
    } catch (e) {
      if (e instanceof UpstreamError) {
        await deps.hooks.onUpstreamError(ctx.serverId, e);
        throw e;
      }
      throw new UpstreamError('unavailable', e instanceof Error ? e.message : String(e));
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const input = policyInput();
    if (!input) return { tools: [] };
    return { tools: visibleTools(input).map(toolRecordToTool) } as { tools: never[] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const started = now().getTime();
    const toolName = req.params.name;
    const argsJson = JSON.stringify(req.params.arguments ?? {});
    const base = { method: 'tools/call', tool: toolName, req_bytes: Buffer.byteLength(argsJson), args_sha256: sha256Hex(argsJson), job_id: null as string | null, protocol_version: null as string | null, res_bytes: null as number | null };
    const input = policyInput();
    if (!input) throw fromHub(new HubError('server_deleting'));
    const timeoutMs = input.server.call_timeout_ms;
    try {
      authorizeCall(input, toolName);
    } catch (e) {
      if (e instanceof HubError) {
        audit({ ...base, outcome: 'blocked', error_code: e.code, duration_ms: 0, error: e.message });
        throw fromHub(e);
      }
      throw e;
    }
    let release: (() => void) | undefined;
    const built = buildCtx(extra as never, timeoutMs);
    base.job_id = built.jobId ?? null;
    try {
      release = await limiter.acquire(ctx.serverId, ctx.agent, extra.signal);
      const connector = await getConnector();
      base.protocol_version = connector.protocolVersion;
      const result = await connector.callTool({ name: toolName, ...(req.params.arguments ? { arguments: req.params.arguments } : {}), ...(req.params._meta ? { _meta: req.params._meta } : {}) }, built.call);
      const resJson = JSON.stringify(result);
      audit({ ...base, outcome: 'ok', error_code: null, duration_ms: now().getTime() - started, res_bytes: Buffer.byteLength(resJson), error: null });
      await deps.hooks.onUpstreamOk(ctx.serverId);
      return result as never;
    } catch (e) {
      const duration = now().getTime() - started;
      if (e instanceof HubError) {
        audit({ ...base, outcome: 'blocked', error_code: e.code, duration_ms: duration, error: e.message });
        throw fromHub(e);
      }
      if (e instanceof UpstreamError) {
        await deps.hooks.onUpstreamError(ctx.serverId, e);
        const mapped = mapUpstreamError(e, label(), timeoutMs);
        audit({ ...base, outcome: 'error', error_code: mapped.code, duration_ms: duration, error: e.message });
        throw mapped;
      }
      if (e instanceof McpError) {
        audit({ ...base, outcome: 'error', error_code: e.code, duration_ms: duration, error: e.message });
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      deps.logger.error({ serverId: ctx.serverId, agent: ctx.agent, tool: toolName, err: msg }, 'tools/call failed');
      audit({ ...base, outcome: 'error', error_code: -32603, duration_ms: duration, error: msg });
      throw new McpError(-32603, 'internal error in omnicode-hub');
    } finally {
      built.stop();
      release?.();
    }
  });

  const forwardList = (schema: typeof ListResourcesRequestSchema | typeof ListResourceTemplatesRequestSchema | typeof ListPromptsRequestSchema, method: string, empty: Record<string, unknown>) =>
    server.setRequestHandler(schema as typeof ListResourcesRequestSchema, async (req, extra) => {
      const input = policyInput();
      if (!input || visibleTools(input).length === 0 && !isListable(input)) return empty as never;
      const connector = await getConnector().catch(() => undefined);
      if (!connector) return empty as never;
      const built = buildCtx(extra as never, DEFAULTS.listTimeoutMs);
      try {
        return (await connector.forward(method, req.params as Record<string, unknown> | undefined, built.call)) as never;
      } catch (e) {
        if (e instanceof UpstreamError) throw mapUpstreamError(e, label(), DEFAULTS.listTimeoutMs);
        throw e;
      } finally {
        built.stop();
      }
    });

  const isListable = (input: PolicyInput) => {
    try {
      authorizeForward(input);
      return true;
    } catch {
      return false;
    }
  };

  // SDK 는 capabilities 에 없는 메서드의 핸들러 등록을 거부하므로, 광고한 capability 에 맞춰 등록한다 (11.3)
  if (capabilities.resources) {
    forwardList(ListResourcesRequestSchema, 'resources/list', { resources: [] });
    forwardList(ListResourceTemplatesRequestSchema, 'resources/templates/list', { resourceTemplates: [] });
  }
  if (capabilities.prompts) forwardList(ListPromptsRequestSchema, 'prompts/list', { prompts: [] });

  const forwardOne = (schema: typeof ReadResourceRequestSchema | typeof GetPromptRequestSchema | typeof CompleteRequestSchema, method: string, nameOf: (p: Record<string, unknown>) => string) =>
    server.setRequestHandler(schema as typeof ReadResourceRequestSchema, async (req, extra) => {
      const started = now().getTime();
      const params = req.params as unknown as Record<string, unknown>;
      const input = policyInput();
      if (!input) throw fromHub(new HubError('server_deleting'));
      try {
        authorizeForward(input);
      } catch (e) {
        if (e instanceof HubError) {
          audit({ method, tool: nameOf(params), outcome: 'blocked', error_code: e.code, duration_ms: 0, req_bytes: null, res_bytes: null, args_sha256: null, job_id: null, protocol_version: null, error: e.message });
          throw fromHub(e);
        }
        throw e;
      }
      const built = buildCtx(extra as never, input.server.call_timeout_ms);
      try {
        const connector = await getConnector();
        const result = await connector.forward(method, params, built.call);
        if (method !== 'completion/complete') {
          audit({ method, tool: nameOf(params), outcome: 'ok', error_code: null, duration_ms: now().getTime() - started, req_bytes: null, res_bytes: Buffer.byteLength(JSON.stringify(result)), args_sha256: null, job_id: built.jobId ?? null, protocol_version: connector.protocolVersion, error: null });
        }
        return result as never;
      } catch (e) {
        if (e instanceof UpstreamError) {
          await deps.hooks.onUpstreamError(ctx.serverId, e);
          const mapped = mapUpstreamError(e, label(), input.server.call_timeout_ms);
          audit({ method, tool: nameOf(params), outcome: 'error', error_code: mapped.code, duration_ms: now().getTime() - started, req_bytes: null, res_bytes: null, args_sha256: null, job_id: built.jobId ?? null, protocol_version: null, error: e.message });
          throw mapped;
        }
        throw e;
      } finally {
        built.stop();
      }
    });

  if (capabilities.resources) forwardOne(ReadResourceRequestSchema, 'resources/read', (p) => String(p.uri ?? ''));
  if (capabilities.prompts) forwardOne(GetPromptRequestSchema, 'prompts/get', (p) => String(p.name ?? ''));
  if (capabilities.completions) forwardOne(CompleteRequestSchema, 'completion/complete', () => 'completion');

  // resources/subscribe·unsubscribe (C3): 업스트림이 subscribe 를 광고할 때만
  if (capabilities.resources?.subscribe && subs) {
    server.setRequestHandler(SubscribeRequestSchema, async (req) => {
      const input = policyInput();
      if (!input) throw fromHub(new HubError('server_deleting'));
      try {
        authorizeForward(input);
      } catch (e) {
        if (e instanceof HubError) throw fromHub(e);
        throw e;
      }
      try {
        await subs.add(req.params.uri);
      } catch (e) {
        if (e instanceof UpstreamError) {
          await deps.hooks.onUpstreamError(ctx.serverId, e);
          throw mapUpstreamError(e, label(), DEFAULTS.listTimeoutMs);
        }
        throw e;
      }
      return {};
    });
    server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
      await subs.remove(req.params.uri);
      return {};
    });
  }

  // logging/setLevel: 업스트림으로 전달하지 않고, 이 세션에 넘길 로그의 최소 수준으로만 쓴다 (11.3, D1)
  server.setRequestHandler(SetLevelRequestSchema, async (req) => {
    if (isLoggingLevel(req.params.level)) sessionLogLevel = req.params.level;
    return {};
  });

  return server;
}

/** 업스트림 capabilities 를 미러링한 다운스트림 capabilities (11.3 initialize 행) */
export function mirrorCapabilities(upstream: Record<string, unknown> | null | undefined): ServerCapabilities {
  // logging 은 Hub 가 setLevel 을 수락만 하므로 항상 광고한다 (11.3)
  const caps: ServerCapabilities = { tools: { listChanged: true }, logging: {} };
  if (!upstream) return { ...caps, prompts: { listChanged: true }, resources: { listChanged: true, subscribe: false } };
  if (upstream.prompts) caps.prompts = { listChanged: true };
  if (upstream.resources) {
    const r = upstream.resources as { subscribe?: unknown };
    caps.resources = { listChanged: true, subscribe: r.subscribe === true };
  }
  if (upstream.completions) caps.completions = {};
  return caps;
}
