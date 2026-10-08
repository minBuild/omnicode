/** 오류 코드 — 설계문서 11.9 (Hub → 에이전트), 14.3 (API). */

export const HUB_ERRORS = {
  server_disabled: {
    code: -32010,
    action: 'enable_server',
    message: 'OmniCode에서 이 MCP 서버가 꺼져 있습니다. 사용자가 OmniCode → MCP 화면에서 켜야 합니다.',
  },
  tool_not_approved: {
    code: -32011,
    action: 'approve_tool',
    message:
      '이 도구는 OmniCode에서 승인되지 않았거나 정의가 바뀌어 재승인 대기 중입니다. 사용자가 OmniCode → MCP → {server} 화면에서 승인해야 합니다.',
  },
  upstream_auth_required: {
    code: -32012,
    action: 'relogin',
    message: '업스트림 로그인이 만료되었습니다. 사용자가 OmniCode → MCP → {server}에서 [다시 로그인]을 눌러야 합니다.',
  },
  upstream_unavailable: {
    code: -32013,
    action: 'retry_later',
    message: '업스트림 MCP 서버에 연결할 수 없습니다 ({reason}). 잠시 후 다시 시도하거나 사용자에게 알리세요.',
  },
  upstream_timeout: {
    code: -32014,
    action: 'ask_user',
    message: '업스트림 응답이 {seconds}초 안에 오지 않았습니다. 같은 요청을 다시 보내면 중복 실행될 수 있습니다.',
  },
  input_required_unsupported: {
    code: -32015,
    action: 'none',
    message: '이 도구는 실행 중 추가 입력을 요구하는데, 현재 CLI 조합에서는 지원되지 않습니다.',
  },
  response_too_large: {
    code: -32016,
    action: 'none',
    message: '업스트림 응답이 {mb}MB 제한을 넘어 잘렸습니다.',
  },
  rate_limited: {
    code: -32017,
    action: 'retry_later',
    message: '호출이 너무 잦습니다. {seconds}초 후 다시 시도하세요.',
  },
  binding_disabled: {
    code: -32018,
    action: 'enable_binding',
    message: '이 서버는 {agent}에 노출되지 않도록 설정되어 있습니다.',
  },
  server_deleting: {
    code: -32019,
    action: 'none',
    message: '이 서버는 삭제 중입니다.',
  },
  header_mismatch: {
    code: -32020,
    action: 'none',
    message: 'HTTP headers do not match the request body ({detail}).',
  },
} as const;

export type HubErrorName = keyof typeof HUB_ERRORS;
export type HubErrorParams = Record<string, string | number>;

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: { code: HubErrorName; action: string; [k: string]: unknown };
}

export function fillTemplate(template: string, params: HubErrorParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in params ? String(params[k]) : `{${k}}`));
}

export function hubError(name: HubErrorName, params: HubErrorParams = {}, extra: Record<string, unknown> = {}): JsonRpcErrorShape {
  const def = HUB_ERRORS[name];
  return {
    code: def.code,
    message: fillTemplate(def.message, params),
    data: { code: name, action: def.action, ...extra },
  };
}

export class HubError extends Error {
  readonly rpc: JsonRpcErrorShape;
  readonly kind: HubErrorName;
  constructor(kind: HubErrorName, params: HubErrorParams = {}, extra: Record<string, unknown> = {}) {
    const rpc = hubError(kind, params, extra);
    super(rpc.message);
    this.name = 'HubError';
    this.kind = kind;
    this.rpc = rpc;
  }
  get code(): number {
    return this.rpc.code;
  }
}

export function isHubError(e: unknown): e is HubError {
  return e instanceof HubError;
}

/** API 오류 (14.3). */
export const API_ERROR_STATUS = {
  validation_error: 400,
  invalid_url: 400,
  ssrf_blocked: 400,
  stale_tool_hash: 400,
  oauth_state_invalid: 400,
  oauth_issuer_mismatch: 400,
  oauth_denied: 400,
  unauthenticated: 401,
  reauth_required: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_transition: 409,
  probe_failed: 422,
  unsupported_transport: 422,
  oauth_registration_failed: 422,
  oauth_not_applicable: 422,
  agentd_unavailable: 502,
  sync_failed: 502,
  upstream_error: 502,
  internal: 500,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
  get status(): number {
    return API_ERROR_STATUS[this.code];
  }
  toJSON(): { error: { code: ApiErrorCode; message: string; details?: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}
