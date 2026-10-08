/** agentd 오류 코드 — 소켓 응답의 `error.code`와 1:1 (설계 12.2). */
export type AgentdErrorCode = 'invalid_request' | 'adapter_error' | 'cli_error' | 'internal';

export class AgentdError extends Error {
  constructor(
    readonly code: AgentdErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AgentdError';
  }
}

export function isAgentdError(e: unknown): e is AgentdError {
  return e instanceof AgentdError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
