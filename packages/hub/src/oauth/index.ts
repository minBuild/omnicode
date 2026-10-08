/**
 * oauth 모듈 진입점 (설계 10장). 계약은 ../contracts.ts의 OAuthManager.
 */
export { createOAuthManager, RefreshFailure } from './manager.js';
export type { HubOAuthManager, OAuthManagerDeps, RefreshFailureKind, RefreshOutcome } from './manager.js';
export { createRefreshScheduler } from './scheduler.js';
export type { RefreshScheduler, RefreshSchedulerOptions, RefreshSweepResult } from './scheduler.js';
export { parseScope, unionScope } from './scope.js';
export { canonicalResourceUrl, issuersEqual, normalizeIssuer, parseWwwAuthenticate } from './discovery.js';
