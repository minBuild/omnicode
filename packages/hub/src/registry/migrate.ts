/**
 * 번호 붙은 SQL 마이그레이션 러너 (17.4). `schema_migrations` 와 비교해 빠진 것만 순서대로 적용한다.
 * 각 파일은 트랜잭션 하나로 적용하고 실패하면 롤백한다 (SQLite DDL 은 트랜잭션 안에서 동작한다).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

const FILE_RE = /^(\d+)_[A-Za-z0-9_-]+\.sql$/;

/**
 * 마이그레이션 디렉터리. tsc 는 .sql 을 dist 로 복사하지 않으므로 모듈 옆(`./migrations`)을 먼저 보고,
 * 없으면 소스 트리(`../../src/registry/migrations`)로 돌아간다. 두 경로는 src·dist 어느 쪽에서도 같은 곳을 가리킨다.
 */
export function defaultMigrationsDir(): string {
  const candidates = [new URL('./migrations/', import.meta.url), new URL('../../src/registry/migrations/', import.meta.url)];
  for (const c of candidates) {
    const p = fileURLToPath(c);
    if (existsSync(p)) return p;
  }
  throw new Error('migrations directory not found');
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function readMigrations(dir: string = defaultMigrationsDir()): Migration[] {
  const files = readdirSync(dir).filter((f) => FILE_RE.test(f));
  const out: Migration[] = [];
  const seen = new Set<number>();
  for (const name of files) {
    const m = FILE_RE.exec(name);
    if (!m || m[1] === undefined) continue;
    const version = Number(m[1]);
    if (seen.has(version)) throw new Error(`duplicate migration version ${version} (${name})`);
    seen.add(version);
    out.push({ version, name, sql: readFileSync(`${dir}/${name}`, 'utf8') });
  }
  return out.sort((a, b) => a.version - b.version);
}

function appliedVersions(db: DatabaseSync): Set<number> {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!exists) return new Set();
  const rows = db.prepare('SELECT version FROM schema_migrations').all();
  return new Set(rows.map((r) => Number(r.version)));
}

export interface MigrationResult {
  applied: number[];
  current: number;
}

/** 멱등: 이미 적용된 버전은 건너뛴다. */
export function applyMigrations(db: DatabaseSync, migrations: Migration[] = readMigrations(), now: () => string = () => new Date().toISOString()): MigrationResult {
  const done = appliedVersions(db);
  const applied: number[] = [];
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, now());
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 이미 롤백됨
      }
      throw new Error(`migration ${m.name} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    applied.push(m.version);
    done.add(m.version);
  }
  return { applied, current: done.size ? Math.max(...done) : 0 };
}
