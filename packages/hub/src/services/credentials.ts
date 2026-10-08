/** 업스트림 자격증명 공급자: auth_type 별로 헤더를 만든다 (10.1). 값은 메모리에만 머문다. */
import { nowIso, type ServerRecord } from '@omnicode/shared';
import { UpstreamError, type HeaderSecret, type Logger, type OAuthManager, type Registry, type SecretStore } from '../contracts.js';

export interface CredentialProvider {
  headersFor(server: ServerRecord): Promise<Record<string, string>>;
  onUnauthorized(serverId: string, wwwAuthenticate?: string): Promise<'retry' | 'needs_auth'>;
}

export function createCredentialProvider(deps: { registry: Registry; secrets: SecretStore; oauth: OAuthManager; logger: Logger }): CredentialProvider {
  return {
    async headersFor(server) {
      switch (server.auth_type) {
        case 'none':
        case 'stdio_env':
          return {};
        case 'header': {
          if (!server.secret_ref) throw new UpstreamError('unauthorized', 'API 키가 저장되어 있지 않습니다');
          const secret = await deps.secrets.get<HeaderSecret>(server.secret_ref);
          if (!secret || secret.type !== 'header') throw new UpstreamError('unauthorized', 'API 키가 저장되어 있지 않습니다');
          return { [secret.header_name]: secret.value };
        }
        case 'oauth':
          return deps.oauth.headersFor(server.id);
        default:
          return {};
      }
    },
    async onUnauthorized(serverId, wwwAuthenticate) {
      const rec = deps.registry.servers.get(serverId);
      if (!rec) return 'needs_auth';
      if (rec.auth_type === 'oauth') return deps.oauth.onUnauthorized(serverId, wwwAuthenticate);
      // header/none: 401 은 키가 틀렸거나 서버가 인증을 요구하기 시작한 것 → needs_auth
      if (rec.status !== 'needs_auth' && rec.status !== 'deleting') {
        try {
          deps.registry.servers.setStatus(serverId, 'needs_auth', { lastError: `업스트림이 401을 돌려줬습니다 (${nowIso()})` });
          deps.registry.events.add({ kind: 'auth.failed', server_id: serverId, actor: 'hub', details: { reason: 'unauthorized', wwwAuthenticate: wwwAuthenticate ?? null } });
        } catch (e) {
          deps.logger.warn({ serverId, err: String(e) }, 'needs_auth transition failed');
        }
      }
      return 'needs_auth';
    },
  };
}
