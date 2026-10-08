/**
 * `status` 응답 (설계 12.2): agentd 버전, CLI 설치 버전, 마지막 동기화 결과.
 * CLI 버전은 `<cli> --version` 을 5초 제한으로 실행하고 60초 동안 캐시한다.
 */
import { AGENTS, nowIso, type Agent, type AgentdCliVersions, type AgentdStatus } from '@omnicode/shared';
import type { CommandRunner } from './runner.js';

export interface StatusTrackerOptions {
  version: string;
  home: string;
  runner: CommandRunner;
  /** 기본 60초 */
  cacheMs?: number;
  /** 기본 5초 */
  cliTimeoutMs?: number;
  /** CLI 실행 파일 이름 덮어쓰기 (테스트용) */
  bins?: Partial<Record<Agent, string>>;
  now?: () => number;
}

export type LastSync = AgentdStatus['lastSync'];

export class StatusTracker {
  private readonly version: string;
  private readonly home: string;
  private readonly runner: CommandRunner;
  private readonly cacheMs: number;
  private readonly cliTimeoutMs: number;
  private readonly bins: Record<Agent, string>;
  private readonly now: () => number;
  private readonly lastSync: LastSync = { claude: null, codex: null, gemini: null };
  private cache: { at: number; cli: AgentdCliVersions } | undefined;
  private inflight: Promise<AgentdCliVersions> | undefined;

  constructor(opts: StatusTrackerOptions) {
    this.version = opts.version;
    this.home = opts.home;
    this.runner = opts.runner;
    this.cacheMs = opts.cacheMs ?? 60_000;
    this.cliTimeoutMs = opts.cliTimeoutMs ?? 5_000;
    this.bins = { claude: 'claude', codex: 'codex', gemini: 'gemini', ...opts.bins };
    this.now = opts.now ?? Date.now;
  }

  /** sync.apply 결과를 기록한다 (메모리). */
  recordSync(agent: Agent, result: { ok: boolean; error?: string }, at: string = nowIso()): void {
    this.lastSync[agent] = result.ok ? { at, ok: true } : { at, ok: false, error: result.error ?? 'unknown error' };
  }

  async status(): Promise<AgentdStatus> {
    const cli = await this.cliVersions();
    return { version: this.version, home: this.home, cli, lastSync: { ...this.lastSync } };
  }

  /** 캐시를 비운다 (테스트용). */
  invalidate(): void {
    this.cache = undefined;
  }

  private cliVersions(): Promise<AgentdCliVersions> {
    if (this.cache && this.now() - this.cache.at < this.cacheMs) return Promise.resolve(this.cache.cli);
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const [claude, codex, gemini] = await Promise.all(AGENTS.map((a) => this.cliVersion(this.bins[a])));
      const cli: AgentdCliVersions = { claude: claude ?? null, codex: codex ?? null, gemini: gemini ?? null };
      this.cache = { at: this.now(), cli };
      return cli;
    })().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async cliVersion(bin: string): Promise<string | null> {
    try {
      const r = await this.runner.run(bin, ['--version'], { env: { ...process.env, HOME: this.home }, cwd: this.home, timeoutMs: this.cliTimeoutMs });
      if (r.code !== 0) return null;
      const line = r.stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
      return line.length > 0 ? line : null;
    } catch {
      return null;
    }
  }
}
