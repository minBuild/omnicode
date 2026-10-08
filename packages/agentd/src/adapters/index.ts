import type { Agent } from '@omnicode/shared';
import type { CommandRunner } from '../runner.js';
import { createClaudeAdapter } from './claude.js';
import { createCodexAdapter } from './codex.js';
import { createGeminiAdapter } from './gemini.js';
import type { Adapter } from './types.js';

export type { Adapter, SyncPlan, Classification } from './types.js';
export { classify, isHubEntryName } from './types.js';
export { createClaudeAdapter, CLAUDE_HEADERS_HELPER, claudeConfigPath, claudeSettingsPath, permissionName } from './claude.js';
export type { ClaudeAdapterOptions } from './claude.js';
export { createCodexAdapter, codexConfigPath, renderCodexBlock, toolTimeoutSec } from './codex.js';
export type { CodexAdapterOptions } from './codex.js';
export { createGeminiAdapter, geminiSettingsPath, renderGeminiEntry } from './gemini.js';
export type { GeminiAdapterOptions, GeminiServerEntry } from './gemini.js';

export interface CreateAdaptersOptions {
  home: string;
  runner: CommandRunner;
}

/** 에이전트 3종의 어댑터를 한 번에 만든다. */
export function createAdapters(opts: CreateAdaptersOptions): Record<Agent, Adapter> {
  return {
    claude: createClaudeAdapter({ home: opts.home, runner: opts.runner }),
    codex: createCodexAdapter({ home: opts.home }),
    gemini: createGeminiAdapter({ home: opts.home }),
  };
}
