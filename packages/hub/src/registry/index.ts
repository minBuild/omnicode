/**
 * registry — SQLite (node:sqlite, WAL, 외래 키) 위의 저장소 묶음. 13장 데이터 모델.
 * `openRegistry(':memory:')` 는 테스트용.
 */
import type { Registry } from '../contracts.js';
import { createAgentTokenRepo } from './agentTokens.js';
import { createAuditRepo } from './audit.js';
import { createBindingRepo } from './bindings.js';
import { openDatabase, type Db } from './db.js';
import { createEventRepo } from './events.js';
import { applyMigrations, readMigrations, type Migration } from './migrate.js';
import { createOAuthStateRepo } from './oauthStates.js';
import { createServerRepo } from './servers.js';
import { createToolRepo } from './tools.js';

export { applyMigrations, defaultMigrationsDir, readMigrations } from './migrate.js';
export type { Migration, MigrationResult } from './migrate.js';
export { Db, openDatabase } from './db.js';

export interface RegistryHandle extends Registry {
  /** 테스트·백업용 저수준 접근 */
  readonly db: Db;
}

export interface OpenRegistryOptions {
  /** 기본: src/registry/migrations 의 번호 붙은 .sql */
  migrations?: Migration[];
}

export function openRegistry(path: string | ':memory:', opts: OpenRegistryOptions = {}): RegistryHandle {
  const db = openDatabase(path);
  try {
    applyMigrations(db.raw, opts.migrations ?? readMigrations());
  } catch (e) {
    db.close();
    throw e;
  }
  return {
    db,
    servers: createServerRepo(db),
    tools: createToolRepo(db),
    bindings: createBindingRepo(db),
    oauthStates: createOAuthStateRepo(db),
    agentTokens: createAgentTokenRepo(db),
    events: createEventRepo(db),
    audit: createAuditRepo(db),
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
}
