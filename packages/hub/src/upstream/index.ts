/**
 * upstream 진입점 — 세대 감지 + 커넥터 생성 (설계문서 11장).
 *
 * `createUpstreamConnector(opts)`: `opts.era`가 있으면 그 세대의 커넥터를 바로 만들고,
 * 없으면 `connect()` 시점에 11.1 절차로 감지해 알맞은 커넥터에 위임한다.
 */
import type { ProtocolEra, ToolDefinition } from '@omnicode/shared';
import {
  UpstreamError,
  type CallContext,
  type CallToolParams,
  type CreateUpstreamConnector,
  type ProbeResult,
  type UpstreamConnector,
  type UpstreamConnectorOptions,
} from '../contracts.js';
import { describeError, unavailableError } from './common.js';
import { LegacyConnector } from './legacy.js';
import { ModernConnector } from './modern.js';
import { detectEra } from './probe.js';

export {
  LegacyConnector,
  classifyLegacyError,
  openLegacySession,
  openLegacySessionWithFallback,
  resolveTimeouts,
  type LegacyInternalOptions,
  type LegacySession,
  type LegacyTransportKind,
} from './legacy.js';
export {
  LISTEN_NOTIFICATIONS,
  LISTEN_SUBSCRIPTIONS,
  MAX_INPUT_REQUIRED_RETRIES,
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  ModernConnector,
  buildModernBody,
  buildModernHeaders,
  modernPost,
  parseDiscoverResult,
  type DiscoverInfo,
  type ModernInternalOptions,
  type ModernPostOptions,
  type ModernPostOutcome,
} from './modern.js';
export { detectEra, type DetectOptions, type Detection } from './probe.js';
export {
  HUB_CLIENT_INFO,
  USER_AGENT,
  UpstreamHttpError,
  advertisedVersionsOf,
  decodeMcpName,
  encodeMcpName,
  isModernJsonRpcError,
  isPlainHeaderValue,
  parseWwwAuthenticate,
} from './common.js';

type ListKind = 'tools' | 'prompts' | 'resources';

/** 세대를 모를 때: connect()에서 감지한 뒤 실제 커넥터에 위임한다. */
class DetectingConnector implements UpstreamConnector {
  readonly serverId: string;
  private readonly opts: UpstreamConnectorOptions;
  private connector: UpstreamConnector | undefined;
  private connecting: Promise<ProbeResult> | undefined;
  private closed = false;
  private readonly listChangedCbs = new Set<(kind: ListKind) => void>();
  private readonly closeCbs = new Set<(reason?: string) => void>();
  private readonly resourceUpdatedCbs = new Set<(uri: string) => void>();

  constructor(opts: UpstreamConnectorOptions) {
    this.opts = opts;
    this.serverId = opts.serverId;
  }

  /** 감지 전에는 자리표시자: era 'legacy', 버전 '', 전송 'streamable_http' */
  get era(): ProtocolEra {
    return this.connector?.era ?? 'legacy';
  }
  get protocolVersion(): string {
    return this.connector?.protocolVersion ?? '';
  }
  get transport(): 'streamable_http' | 'sse' {
    return this.connector?.transport ?? 'streamable_http';
  }
  get serverInfo(): Record<string, unknown> | null {
    return this.connector?.serverInfo ?? null;
  }
  get capabilities(): Record<string, unknown> | null {
    return this.connector?.capabilities ?? null;
  }
  get lastToolsTtlMs(): number | null {
    return this.connector?.lastToolsTtlMs ?? null;
  }

  async connect(): Promise<ProbeResult> {
    if (this.closed) throw unavailableError('upstream connector is closed');
    if (this.connector) return this.connector.connect();
    if (!this.connecting) {
      this.connecting = this.detectAndConnect().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  private async detectAndConnect(): Promise<ProbeResult> {
    let authRetried = false;
    for (;;) {
      try {
        const d = await detectEra(this.opts);
        if (this.closed) {
          if (d.era === 'legacy') await d.session.client.close().catch(() => undefined);
          throw unavailableError('upstream connector is closed');
        }
        const inner: UpstreamConnector =
          d.era === 'modern'
            ? new ModernConnector(this.opts, { discovered: d.discover })
            : new LegacyConnector(this.opts, { session: d.session });
        this.attach(inner);
        return await inner.connect();
      } catch (e) {
        if (e instanceof UpstreamError && e.kind === 'unauthorized' && !authRetried && this.opts.onUnauthorized) {
          authRetried = true;
          this.opts.logger?.debug({ serverId: this.serverId }, 'upstream probe got 401; asking credential provider');
          if ((await this.opts.onUnauthorized(e.info.wwwAuthenticate)) === 'retry') continue;
        }
        throw e;
      }
    }
  }

  private attach(inner: UpstreamConnector): void {
    this.connector = inner;
    for (const cb of this.listChangedCbs) inner.onListChanged(cb);
    for (const cb of this.closeCbs) inner.onClose(cb);
    for (const cb of this.resourceUpdatedCbs) inner.onResourceUpdated(cb);
    this.listChangedCbs.clear();
    this.closeCbs.clear();
    this.resourceUpdatedCbs.clear();
  }

  private async inner(): Promise<UpstreamConnector> {
    if (this.connector) return this.connector;
    await this.connect();
    if (!this.connector) throw unavailableError('upstream connector did not initialize');
    return this.connector;
  }

  async listTools(signal?: AbortSignal): Promise<ToolDefinition[]> {
    return (await this.inner()).listTools(signal);
  }

  async callTool(params: CallToolParams, ctx: CallContext): Promise<Record<string, unknown>> {
    return (await this.inner()).callTool(params, ctx);
  }

  async subscribeResource(uri: string): Promise<void> {
    return (await this.inner()).subscribeResource(uri);
  }

  async unsubscribeResource(uri: string): Promise<void> {
    if (this.connector) await this.connector.unsubscribeResource(uri);
  }

  onResourceUpdated(cb: (uri: string) => void): () => void {
    if (this.connector) return this.connector.onResourceUpdated(cb);
    this.resourceUpdatedCbs.add(cb);
    return () => {
      this.resourceUpdatedCbs.delete(cb);
    };
  }

  async forward(method: string, params: Record<string, unknown> | undefined, ctx: CallContext): Promise<Record<string, unknown>> {
    return (await this.inner()).forward(method, params, ctx);
  }

  onListChanged(cb: (kind: ListKind) => void): () => void {
    if (this.connector) return this.connector.onListChanged(cb);
    this.listChangedCbs.add(cb);
    return () => {
      this.listChangedCbs.delete(cb);
    };
  }

  onClose(cb: (reason?: string) => void): () => void {
    if (this.connector) return this.connector.onClose(cb);
    this.closeCbs.add(cb);
    return () => {
      this.closeCbs.delete(cb);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.connecting) await this.connecting.then(() => undefined, () => undefined);
    if (this.connector) {
      await this.connector.close();
      return;
    }
    for (const cb of this.closeCbs) {
      try {
        cb('closed');
      } catch (e) {
        this.opts.logger?.warn({ serverId: this.serverId, err: describeError(e) }, 'onClose callback threw');
      }
    }
  }
}

export const createUpstreamConnector: CreateUpstreamConnector = (opts) => {
  if (opts.era === 'modern') return new ModernConnector(opts);
  if (opts.era === 'legacy') return new LegacyConnector(opts);
  return new DetectingConnector(opts);
};
