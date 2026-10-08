/** DatabaseSync 얇은 래퍼: 준비문 캐시 + 중첩 가능한 트랜잭션. */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Db {
  private readonly statements = new Map<string, StatementSync>();

  constructor(readonly raw: DatabaseSync) {}

  stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  /** 바깥 트랜잭션 안에서 불리면 그대로 합류한다 (SQLite 는 중첩 BEGIN 을 허용하지 않는다). */
  transaction<T>(fn: () => T): T {
    if (this.raw.isTransaction) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    let result: T;
    try {
      result = fn();
    } catch (e) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // 이미 롤백됨
      }
      throw e;
    }
    this.raw.exec('COMMIT');
    return result;
  }

  close(): void {
    this.statements.clear();
    if (this.raw.isOpen) this.raw.close();
  }
}

/** WAL + 외래 키 + busy timeout 으로 연다. 파일 DB 면 상위 디렉터리를 0700 으로 만든다. */
export function openDatabase(path: string): Db {
  const inMemory = path === ':memory:' || path === '';
  if (!inMemory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const raw = new DatabaseSync(inMemory ? ':memory:' : path, { enableForeignKeyConstraints: true, timeout: 5_000 });
  if (!inMemory) {
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA synchronous = NORMAL');
  }
  raw.exec('PRAGMA foreign_keys = ON');
  return new Db(raw);
}

export function nowIso(): string {
  return new Date().toISOString();
}
