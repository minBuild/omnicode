/** 다운스트림 서버가 조립 계층에서 받는 의존성. 모두 계약 타입이다. */
import type { AuditEntry, Masker } from '@omnicode/shared';
import type { HubConfig, HubTokens, Logger, Registry, UpstreamConnector, UpstreamError } from '../contracts.js';

export interface AuditSink {
  record(entry: Omit<AuditEntry, 'id'>): void;
}

export interface ConnectorPool {
  /** 연결된 커넥터를 돌려준다 (필요하면 연결). 실패 시 UpstreamError */
  get(serverId: string): Promise<UpstreamConnector>;
  /** 연결돼 있으면 돌려주고 아니면 undefined (초기화 시 capabilities 미러링용, 연결 시도 안 함) */
  peek(serverId: string): UpstreamConnector | undefined;
}

export interface DownstreamHooks {
  /** 업스트림 오류를 상태 전이로 반영한다 (needs_auth, error 등). 실패해도 던지지 않는다 */
  onUpstreamError(serverId: string, err: UpstreamError): Promise<void>;
  /** 호출 성공 → error 상태였다면 active 로 복구 */
  onUpstreamOk(serverId: string): Promise<void>;
}

export interface DownstreamDeps {
  config: HubConfig;
  registry: Registry;
  tokens: HubTokens;
  connectors: ConnectorPool;
  hooks: DownstreamHooks;
  audit: AuditSink;
  masker: Masker;
  logger: Logger;
  now?: () => Date;
}
