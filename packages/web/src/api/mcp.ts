/** 14.1 엔드포인트 — 화면이 쓰는 함수 모음. DTO 타입은 @omnicode/shared에서 타입으로만 가져온다. */
import type {
  Agent,
  ApproveResult,
  AuditPage,
  DeleteResult,
  EventPage,
  HubStatus,
  OAuthStartResult,
  PresetView,
  ServerDetail,
  ServerSummary,
  SyncOutcome,
  TestResult,
} from '@omnicode/shared';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from './client';

const BASE = '/api/mcp';
const enc = encodeURIComponent;

export interface CreateServerInput {
  source: 'url' | 'preset' | 'json';
  url?: string;
  presetId?: string;
  json?: string;
  id?: string;
  displayName?: string;
}

export interface PatchServerInput {
  displayName?: string;
  enabled?: boolean;
  bindings?: Partial<Record<Agent, boolean>>;
  tools?: Array<{ name: string; enabled: boolean }>;
  callTimeoutMs?: number;
  cliAutoApprove?: boolean;
}

export interface ApproveInput {
  tools: Array<{ name: string; schemaHash: string; enabled?: boolean }>;
  bindings?: Partial<Record<Agent, boolean>>;
}

export interface AuditQueryInput {
  serverId?: string;
  agent?: Agent;
  outcome?: 'ok' | 'error' | 'blocked';
  since?: string;
  cursor?: number;
  limit?: number;
}

export type SyncReport = Record<Agent, SyncOutcome>;

/** 목록 응답이 배열이든 { items } 래핑이든 받아들인다. */
function asList<T>(x: unknown): T[] {
  if (Array.isArray(x)) return x as T[];
  if (x && typeof x === 'object') {
    for (const key of ['items', 'servers', 'presets']) {
      const v = (x as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

export const mcpApi = {
  listServers: async (signal?: AbortSignal) => asList<ServerSummary>(await apiGet<unknown>(`${BASE}/servers`, { signal })),
  getServer: (id: string, signal?: AbortSignal) => apiGet<ServerDetail>(`${BASE}/servers/${enc(id)}`, { signal }),
  createServer: (input: CreateServerInput) => apiPost<ServerDetail>(`${BASE}/servers`, input),
  patchServer: (id: string, patch: PatchServerInput) => apiPatch<ServerDetail>(`${BASE}/servers/${enc(id)}`, patch),
  deleteServer: (id: string) => apiDelete<DeleteResult>(`${BASE}/servers/${enc(id)}`),
  forceDeleteServer: (id: string) => apiPost<DeleteResult>(`${BASE}/servers/${enc(id)}/delete/force`),
  putCredentials: (id: string, headerName: string, value: string) =>
    apiPut<unknown>(`${BASE}/servers/${enc(id)}/credentials`, { headerName, value }),
  setOAuthClient: (id: string, clientId: string, clientSecret?: string) =>
    apiPost<unknown>(`${BASE}/servers/${enc(id)}/oauth/client`, clientSecret ? { clientId, clientSecret } : { clientId }),
  startOAuth: (id: string) => apiPost<OAuthStartResult>(`${BASE}/servers/${enc(id)}/oauth/start`),
  approve: (id: string, input: ApproveInput) => apiPost<ApproveResult>(`${BASE}/servers/${enc(id)}/approve`, input),
  probe: (id: string) => apiPost<ServerDetail>(`${BASE}/servers/${enc(id)}/probe`),
  test: (id: string) => apiPost<TestResult>(`${BASE}/servers/${enc(id)}/test`),
  syncAll: () => apiPost<SyncReport>(`${BASE}/sync`),
  syncPlan: (signal?: AbortSignal) => apiGet<SyncReport>(`${BASE}/sync/plan`, { signal }),
  audit: (q: AuditQueryInput, signal?: AbortSignal) => apiGet<AuditPage>(`${BASE}/audit`, { query: { ...q }, signal }),
  events: (q: { serverId?: string; agent?: Agent; cursor?: number; limit?: number }, signal?: AbortSignal) =>
    apiGet<EventPage>(`${BASE}/events`, { query: { ...q }, signal }),
  hubStatus: (signal?: AbortSignal) => apiGet<HubStatus>(`${BASE}/hub/status`, { signal }),
  rotateTokens: (agents: Agent[]) => apiPost<{ rotatedAt: string; graceUntil: string }>(`${BASE}/hub/tokens/rotate`, { agents }),
  presets: async (signal?: AbortSignal) => asList<PresetView>(await apiGet<unknown>(`${BASE}/presets`, { signal })),
};
