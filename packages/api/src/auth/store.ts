/**
 * 인증 저장소 — `<dataDir>/auth.sqlite` (설계 0002 4장).
 * MCP 레지스트리와 파일을 나눈다. 스키마 버전은 PRAGMA user_version 으로 관리한다.
 * 비밀값(세션 토큰, 설치 토큰)은 SHA-256 해시만 저장한다.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

export type CredentialDeviceType = 'singleDevice' | 'multiDevice';
export type ChallengePurpose = 'setup' | 'login' | 'reauth' | 'add_passkey';

export interface PasskeyRecord {
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
  deviceType: CredentialDeviceType;
  backedUp: boolean;
  aaguid: string | null;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface SessionRecord {
  tokenSha256: string;
  publicId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  authAt: string;
  passkeyId: string | null;
  userAgent: string | null;
}

export interface ChallengeRecord {
  id: string;
  purpose: ChallengePurpose;
  challenge: string;
  sessionId: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface SetupTokenRecord {
  tokenSha256: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface AuthStore {
  /** WebAuthn user.id (base64url). 없으면 만들어 저장한다 */
  userHandle(): string;
  passkeys: {
    list(): PasskeyRecord[];
    get(id: string): PasskeyRecord | undefined;
    count(): number;
    insert(rec: PasskeyRecord): void;
    recordUse(id: string, counter: number, at: string): void;
    delete(id: string): boolean;
    deleteAll(): number;
  };
  sessions: {
    create(rec: SessionRecord): void;
    byTokenHash(hash: string): SessionRecord | undefined;
    byPublicId(publicId: string): SessionRecord | undefined;
    list(): SessionRecord[];
    touch(hash: string, at: string): void;
    setAuth(hash: string, at: string, passkeyId: string): void;
    delete(hash: string): boolean;
    deleteByPublicId(publicId: string): boolean;
    deleteAll(): number;
    /** 절대 만료가 지났거나 마지막 사용이 idleCutoff 이전인 세션을 지운다 */
    purge(nowIso: string, idleCutoffIso: string): number;
  };
  challenges: {
    create(rec: ChallengeRecord): void;
    /** 목적·세션이 맞고 만료·사용 전이면 used_at 을 찍고 돌려준다 (1회용) */
    consume(id: string, purpose: ChallengePurpose, sessionId: string | null, nowIso: string): ChallengeRecord | undefined;
    purge(nowIso: string): number;
  };
  setupTokens: {
    create(rec: SetupTokenRecord): void;
    /** 해시가 같고 만료·사용 전인 토큰 */
    findValid(hash: string, nowIso: string): SetupTokenRecord | undefined;
    anyValid(nowIso: string): boolean;
    markUsed(hash: string, at: string): boolean;
    deleteAll(): number;
  };
  transaction<T>(fn: () => T): T;
  close(): void;
}

const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE auth_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE auth_passkeys (
  id            TEXT PRIMARY KEY,
  public_key    BLOB NOT NULL,
  counter       INTEGER NOT NULL,
  transports    TEXT,
  device_type   TEXT NOT NULL,
  backed_up     INTEGER NOT NULL,
  aaguid        TEXT,
  label         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
CREATE TABLE auth_sessions (
  token_sha256  TEXT PRIMARY KEY,
  public_id     TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  auth_at       TEXT NOT NULL,
  passkey_id    TEXT,
  user_agent    TEXT
);
CREATE TABLE auth_challenges (
  id            TEXT PRIMARY KEY,
  purpose       TEXT NOT NULL,
  challenge     TEXT NOT NULL,
  session_id    TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT
);
CREATE TABLE auth_setup_tokens (
  token_sha256  TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT
);
CREATE INDEX idx_auth_challenges_expires ON auth_challenges (expires_at);
`;

type Row = Record<string, SQLInputValue>;

function str(v: SQLInputValue | undefined): string {
  return typeof v === 'string' ? v : String(v ?? '');
}
function strOrNull(v: SQLInputValue | undefined): string | null {
  return v === null || v === undefined ? null : String(v);
}

function toPasskey(r: Row): PasskeyRecord {
  const pk = r.public_key;
  return {
    id: str(r.id),
    publicKey: pk instanceof Uint8Array ? new Uint8Array(pk) : new Uint8Array(),
    counter: Number(r.counter ?? 0),
    transports: r.transports ? (JSON.parse(str(r.transports)) as string[]) : [],
    deviceType: str(r.device_type) === 'multiDevice' ? 'multiDevice' : 'singleDevice',
    backedUp: Number(r.backed_up ?? 0) === 1,
    aaguid: strOrNull(r.aaguid),
    label: str(r.label),
    createdAt: str(r.created_at),
    lastUsedAt: strOrNull(r.last_used_at),
  };
}

function toSession(r: Row): SessionRecord {
  return {
    tokenSha256: str(r.token_sha256),
    publicId: str(r.public_id),
    createdAt: str(r.created_at),
    lastSeenAt: str(r.last_seen_at),
    expiresAt: str(r.expires_at),
    authAt: str(r.auth_at),
    passkeyId: strOrNull(r.passkey_id),
    userAgent: strOrNull(r.user_agent),
  };
}

function toChallenge(r: Row): ChallengeRecord {
  return {
    id: str(r.id),
    purpose: str(r.purpose) as ChallengePurpose,
    challenge: str(r.challenge),
    sessionId: strOrNull(r.session_id),
    createdAt: str(r.created_at),
    expiresAt: str(r.expires_at),
    usedAt: strOrNull(r.used_at),
  };
}

function toSetupToken(r: Row): SetupTokenRecord {
  return {
    tokenSha256: str(r.token_sha256),
    createdAt: str(r.created_at),
    expiresAt: str(r.expires_at),
    usedAt: strOrNull(r.used_at),
  };
}

export function openAuthStore(path: string | ':memory:'): AuthStore {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');

  const version = Number((db.prepare('PRAGMA user_version').get() as Row | undefined)?.user_version ?? 0);
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`auth.sqlite schema version ${version} is newer than this build (${SCHEMA_VERSION})`);
  }
  if (version < 1) {
    db.exec('BEGIN');
    try {
      db.exec(SCHEMA_V1);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      db.close();
      throw e;
    }
  }

  const stmt = (sql: string) => db.prepare(sql);
  let depth = 0;

  const store: AuthStore = {
    userHandle() {
      const row = stmt("SELECT value FROM auth_meta WHERE key = 'user_handle'").get() as Row | undefined;
      if (row) return str(row.value);
      const handle = randomBytes(32).toString('base64url');
      stmt("INSERT OR IGNORE INTO auth_meta (key, value) VALUES ('user_handle', ?)").run(handle);
      return str((stmt("SELECT value FROM auth_meta WHERE key = 'user_handle'").get() as Row).value);
    },

    passkeys: {
      list: () => (stmt('SELECT * FROM auth_passkeys ORDER BY created_at').all() as Row[]).map(toPasskey),
      get: (id) => {
        const r = stmt('SELECT * FROM auth_passkeys WHERE id = ?').get(id) as Row | undefined;
        return r ? toPasskey(r) : undefined;
      },
      count: () => Number((stmt('SELECT COUNT(*) AS n FROM auth_passkeys').get() as Row).n ?? 0),
      insert: (rec) => {
        stmt(
          `INSERT INTO auth_passkeys (id, public_key, counter, transports, device_type, backed_up, aaguid, label, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          rec.id,
          rec.publicKey,
          rec.counter,
          JSON.stringify(rec.transports),
          rec.deviceType,
          rec.backedUp ? 1 : 0,
          rec.aaguid,
          rec.label,
          rec.createdAt,
          rec.lastUsedAt,
        );
      },
      recordUse: (id, counter, at) => {
        stmt('UPDATE auth_passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(counter, at, id);
      },
      delete: (id) => Number(stmt('DELETE FROM auth_passkeys WHERE id = ?').run(id).changes) > 0,
      deleteAll: () => Number(stmt('DELETE FROM auth_passkeys').run().changes),
    },

    sessions: {
      create: (rec) => {
        stmt(
          `INSERT INTO auth_sessions (token_sha256, public_id, created_at, last_seen_at, expires_at, auth_at, passkey_id, user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(rec.tokenSha256, rec.publicId, rec.createdAt, rec.lastSeenAt, rec.expiresAt, rec.authAt, rec.passkeyId, rec.userAgent);
      },
      byTokenHash: (hash) => {
        const r = stmt('SELECT * FROM auth_sessions WHERE token_sha256 = ?').get(hash) as Row | undefined;
        return r ? toSession(r) : undefined;
      },
      byPublicId: (publicId) => {
        const r = stmt('SELECT * FROM auth_sessions WHERE public_id = ?').get(publicId) as Row | undefined;
        return r ? toSession(r) : undefined;
      },
      list: () => (stmt('SELECT * FROM auth_sessions ORDER BY last_seen_at DESC').all() as Row[]).map(toSession),
      touch: (hash, at) => {
        stmt('UPDATE auth_sessions SET last_seen_at = ? WHERE token_sha256 = ?').run(at, hash);
      },
      setAuth: (hash, at, passkeyId) => {
        stmt('UPDATE auth_sessions SET auth_at = ?, passkey_id = ?, last_seen_at = ? WHERE token_sha256 = ?').run(at, passkeyId, at, hash);
      },
      delete: (hash) => Number(stmt('DELETE FROM auth_sessions WHERE token_sha256 = ?').run(hash).changes) > 0,
      deleteByPublicId: (publicId) => Number(stmt('DELETE FROM auth_sessions WHERE public_id = ?').run(publicId).changes) > 0,
      deleteAll: () => Number(stmt('DELETE FROM auth_sessions').run().changes),
      purge: (nowIso, idleCutoffIso) =>
        Number(stmt('DELETE FROM auth_sessions WHERE expires_at <= ? OR last_seen_at < ?').run(nowIso, idleCutoffIso).changes),
    },

    challenges: {
      create: (rec) => {
        stmt(
          `INSERT INTO auth_challenges (id, purpose, challenge, session_id, created_at, expires_at, used_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        ).run(rec.id, rec.purpose, rec.challenge, rec.sessionId, rec.createdAt, rec.expiresAt);
      },
      consume: (id, purpose, sessionId, nowIso) => {
        // 조건부 UPDATE 로 원자적으로 소진한다 (동시 요청이 같은 챌린지를 두 번 쓰지 못한다)
        const changed = Number(
          stmt(
            `UPDATE auth_challenges SET used_at = ?
             WHERE id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
               AND ((? IS NULL AND session_id IS NULL) OR session_id = ?)`,
          ).run(nowIso, id, purpose, nowIso, sessionId, sessionId).changes,
        );
        if (changed !== 1) return undefined;
        const r = stmt('SELECT * FROM auth_challenges WHERE id = ?').get(id) as Row | undefined;
        return r ? toChallenge(r) : undefined;
      },
      purge: (nowIso) => Number(stmt('DELETE FROM auth_challenges WHERE expires_at <= ? OR used_at IS NOT NULL').run(nowIso).changes),
    },

    setupTokens: {
      create: (rec) => {
        stmt('INSERT INTO auth_setup_tokens (token_sha256, created_at, expires_at, used_at) VALUES (?, ?, ?, NULL)').run(
          rec.tokenSha256,
          rec.createdAt,
          rec.expiresAt,
        );
      },
      findValid: (hash, nowIso) => {
        const r = stmt('SELECT * FROM auth_setup_tokens WHERE token_sha256 = ? AND used_at IS NULL AND expires_at > ?').get(hash, nowIso) as
          | Row
          | undefined;
        return r ? toSetupToken(r) : undefined;
      },
      anyValid: (nowIso) =>
        Number((stmt('SELECT COUNT(*) AS n FROM auth_setup_tokens WHERE used_at IS NULL AND expires_at > ?').get(nowIso) as Row).n ?? 0) > 0,
      markUsed: (hash, at) =>
        Number(stmt('UPDATE auth_setup_tokens SET used_at = ? WHERE token_sha256 = ? AND used_at IS NULL').run(at, hash).changes) === 1,
      deleteAll: () => Number(stmt('DELETE FROM auth_setup_tokens').run().changes),
    },

    transaction<T>(fn: () => T): T {
      if (depth > 0) {
        depth++;
        try {
          return fn();
        } finally {
          depth--;
        }
      }
      db.exec('BEGIN IMMEDIATE');
      depth = 1;
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      } finally {
        depth = 0;
      }
    },

    close() {
      db.close();
    },
  };
  return store;
}
