/**
 * @omnicode/agentd 공개 진입점 (설계 8.4, 12.2).
 * - startAgentd: 소켓 서버 (omniagent 데몬)
 * - createAgentdClient: Hub 가 쓰는 클라이언트
 * - 어댑터 3종, 토큰 파일, 상태 추적
 */
export { startAgentd, createConsoleLogger, lookupGid } from './server.js';
export type { StartAgentdOptions, AgentdHandle, AgentdLogger } from './server.js';
export { createAgentdClient, AgentdRequestError, AgentdUnavailableError } from './client.js';
export type { AgentdClient, AgentdClientOptions } from './client.js';
export { MAX_LINE_BYTES, DEFAULT_SOCKET_GROUP, DEFAULT_CLIENT_TIMEOUT_MS } from './constants.js';
export { AgentdError, isAgentdError } from './errors.js';
export type { AgentdErrorCode } from './errors.js';
export { createExecFileRunner } from './runner.js';
export type { CommandRunner, RunOptions, RunResult } from './runner.js';
export { writeToken, tokenPath, envShPath, tokensDir, ENV_SH } from './tokens.js';
export { StatusTracker } from './status.js';
export type { StatusTrackerOptions } from './status.js';
export { writeFileAtomic, readTextIfExists, ensureDir, fileMode } from './fsutil.js';
export { detectFormat, parseJsonc, setValue, removeValue, JsoncParseError, JsoncEditError } from './jsonc-edit.js';
export type { JsonFormat } from './jsonc-edit.js';
export * from './adapters/index.js';
