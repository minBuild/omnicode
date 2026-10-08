/**
 * Hub 조립 루트 (createHub). 설계문서 8장의 구성 요소를 계약대로 연결한다.
 * 모든 외부 의존성은 deps 로 바꿔 끼울 수 있어 통합 테스트에서 가짜 agentd·업스트림을 쓴다.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS, createMasker, maskJson, type Agent, type AuditQuery, type HubStatus, type Masker, type Preset } from '@omnicode/shared';
import type { AgentdClient, CreateUpstreamConnector, GuardedFetch, Hub, HubConfig, Logger, Registry, SecretStore } from './contracts.js';
import { createAuditWriter, createRetentionPurger } from './audit/index.js';
import { createDownstreamServer } from './downstream/server.js';
import { createLogger } from './logger.js';
import { createGuardedFetch } from './net/guardedFetch.js';
import { createOAuthManager, createRefreshScheduler } from './oauth/index.js';
import { openRegistry } from './registry/index.js';
import { createSecretsForConfig } from './secrets/index.js';
import { createCredentialProvider } from './services/credentials.js';
import { createHealthScheduler } from './services/health.js';
import { createDownstreamHooks } from './services/hooks.js';
import { loadPresets } from './services/presets.js';
import { createServersService } from './services/servers.js';
import { createSyncService } from './services/sync.js';
import { createTokenManager } from './services/tokens.js';
import { createUpstreamPool } from './services/upstreamPool.js';
import { createAgentdClient } from './sync/agentdClient.js';
import { createUpstreamConnector } from './upstream/index.js';

export interface CreateHubOptions {
  config: HubConfig;
  /** 테스트·개발용 주입. 지정하지 않으면 설정대로 실제 구현을 만든다 */
  deps?: {
    registry?: Registry;
    secrets?: SecretStore;
    logger?: Logger;
    masker?: Masker;
    agentd?: AgentdClient;
    createConnector?: CreateUpstreamConnector;
    guard?: GuardedFetch & { close?(): Promise<void> };
    /** 다운스트림 포트 (0 = 임의). 기본 config.hubPort */
    port?: number;
    now?: () => Date;
  };
}

export async function createHub(opts: CreateHubOptions): Promise<Hub> {
  const { config } = opts;
  const deps = opts.deps ?? {};
  const now = deps.now ?? (() => new Date());
  const masker = deps.masker ?? createMasker();
  const logger = deps.logger ?? createLogger(masker, { name: 'omnicode-hub' });

  let registry: Registry;
  if (deps.registry) registry = deps.registry;
  else {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    registry = openRegistry(join(config.dataDir, 'registry.sqlite'));
  }
  // 이벤트 details 는 항상 마스킹된 JSON 문자열로 저장한다 (16.6)
  const rawEventsAdd = registry.events.add.bind(registry.events);
  registry.events.add = (e) => rawEventsAdd({ ...e, details: e.details === undefined ? undefined : maskJson(masker, e.details) });

  const guard = deps.guard ?? createGuardedFetch({ allowPrivateHosts: config.allowPrivateHosts, allowHttpLoopback: config.allowHttpLoopback, logger });
  const secrets = deps.secrets ?? createSecretsForConfig(config, masker);
  const agentd = deps.agentd ?? createAgentdClient(config.agentdSocket);
  const audit = createAuditWriter(registry, masker);
  const purger = createRetentionPurger(registry, { auditRetentionDays: config.auditRetentionDays, eventRetentionDays: config.eventRetentionDays });

  const oauth = createOAuthManager({ config, registry, secrets, fetch: guard.fetch, logger, now });
  const refresher = createRefreshScheduler(oauth, registry, { logger, now });
  const tokens = createTokenManager({ config, registry, secrets, agentd, masker, logger, now });
  const credentials = createCredentialProvider({ registry, secrets, oauth, logger });
  const sync = createSyncService({ registry, agentd, config, logger });

  let presetsCache: Preset[] = loadPresets(config.presetsDir, logger).presets;

  // 순환 의존: pool → onListChanged → servers.refreshTools → downstream.notify
  const pool = createUpstreamPool({
    registry,
    fetch: guard.fetch,
    createConnector: deps.createConnector ?? createUpstreamConnector,
    credentials,
    onListChanged: (serverId, kind) => {
      void handleListChanged(serverId, kind);
    },
    logger,
  });
  const hooks = createDownstreamHooks({ registry, oauth, pool, logger });
  const downstream = createDownstreamServer(
    { config, registry, tokens, connectors: pool, hooks, audit: { record: (e) => audit.record(e) }, masker, logger, now },
    { port: deps.port ?? config.hubPort },
  );
  const servers = createServersService({ config, registry, secrets, oauth, pool, sync, guard, presets: () => presetsCache, downstream, masker, logger });

  async function handleListChanged(serverId: string, kind: 'tools' | 'prompts' | 'resources') {
    try {
      if (kind === 'tools') await servers.refreshTools(serverId);
      else await downstream.notifyListChanged(serverId, kind);
    } catch (e) {
      logger.warn({ serverId, kind, err: e instanceof Error ? e.message : String(e) }, 'list_changed handling failed');
    }
  }

  const startedAt = now().getTime();
  let maintenanceTimer: NodeJS.Timeout | undefined;
  let lastPurge = 0;

  // 17.3 상태 점검: 서버별 기한, ttlMs 반영, 실패 시 지수 백오프 (D8)
  const health = createHealthScheduler(
    () => registry.servers.list().map((r) => ({ id: r.id, status: r.status })),
    async (serverId) => {
      const r = await servers.refreshTools(serverId);
      return { ok: r.ok, ttlMs: r.ttlMs };
    },
    { intervalMs: config.healthIntervalMs, now: () => now().getTime(), logger },
  );

  /** 토큰 사본 재시도, 보존 기간 정리 (17.4) */
  async function maintenance() {
    await tokens.ensureFiles().catch(() => false);
    if (now().getTime() - lastPurge > 24 * 60 * 60 * 1000) {
      lastPurge = now().getTime();
      try {
        const r = purger.purge(now());
        logger.info(r, 'retention purge');
      } catch (e) {
        logger.warn({ err: String(e) }, 'retention purge failed');
      }
    }
  }

  const hub: Hub = {
    config,
    registry,
    servers,
    oauth,
    sync,
    tokens,
    masker,
    logger,
    audit: (q: AuditQuery) => registry.audit.list(q),
    events: (q) => registry.events.list(q),
    presets: () => presetsCache,
    async status(): Promise<HubStatus> {
      let agentdStatus: HubStatus['agentd'];
      try {
        const s = await agentd.status();
        agentdStatus = { ok: true, version: s.version, cli: s.cli };
      } catch (e) {
        agentdStatus = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      const tokenInfo = {} as HubStatus['tokens'];
      for (const a of AGENTS) tokenInfo[a] = { rotatedAt: tokens.rotatedAt(a), graceUntil: tokens.graceUntil(a) };
      return {
        version: config.version,
        uptimeSec: Math.round((now().getTime() - startedAt) / 1000),
        hub: { host: config.hubHost, port: downstream.port ?? config.hubPort },
        downstreamSessions: downstream.sessionCounts(),
        agentd: agentdStatus,
        lastSync: sync.lastSync(),
        allowPrivateHosts: config.allowPrivateHosts,
        allowHttpLoopback: config.allowHttpLoopback,
        tokens: tokenInfo,
      };
    },
    async start() {
      await tokens.init();
      await downstream.start();
      refresher.start();
      presetsCache = loadPresets(config.presetsDir, logger).presets;
      health.start();
      maintenanceTimer = setInterval(() => void maintenance(), config.healthIntervalMs);
      maintenanceTimer.unref();
      // 시작 직후 동기화 (12.2). 실패해도 Hub 는 뜬다
      sync.all().catch((e: unknown) => logger.warn({ err: String(e) }, 'initial sync failed'));
      logger.info({ port: downstream.port, servers: registry.servers.list().length }, 'omnicode hub started');
    },
    async stop() {
      health.stop();
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      refresher.stop();
      await downstream.stop();
      await pool.closeAll();
      if (deps.guard?.close) await deps.guard.close();
      else if ('close' in guard && typeof (guard as { close?: unknown }).close === 'function') await (guard as { close(): Promise<void> }).close();
      if (!deps.registry) registry.close();
    },
  };
  return hub;
}

export type { Agent };
