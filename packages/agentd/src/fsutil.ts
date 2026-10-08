import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 임시 파일 접미사. `<file>.omnicode-tmp`에 쓰고 rename 한다 (설계 12.1). */
export const TMP_SUFFIX = '.omnicode-tmp';
/** 백업 접미사. `<file>.omnicode-bak.<unix-ms>` — 최근 3개만 남긴다. */
export const BAK_SUFFIX = '.omnicode-bak.';
export const BACKUP_KEEP = 3;

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if (isEnoent(e)) return undefined;
    throw e;
  }
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (e) {
    if (isEnoent(e)) return false;
    throw e;
  }
}

/** 부모 디렉터리를 0700으로 만든다 (이미 있으면 권한은 건드리지 않는다). */
export async function ensureDir(dir: string, mode = DIR_MODE): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode });
}

export interface WriteOptions {
  /** 기본 0600 */
  mode?: number;
  /** 남길 백업 수. 0이면 백업하지 않는다 (토큰 파일). 기본 3 */
  backups?: number;
}

/**
 * 원자적 쓰기: 기존 파일을 백업 → 임시 파일에 쓰기 → rename.
 * 파일 모드는 0600, 부모 디렉터리는 0700으로 만든다.
 */
export async function writeFileAtomic(file: string, content: string, opts: WriteOptions = {}): Promise<void> {
  const mode = opts.mode ?? FILE_MODE;
  const backups = opts.backups ?? BACKUP_KEEP;
  await ensureDir(path.dirname(file));
  if (backups > 0 && (await fileExists(file))) {
    await backupFile(file, backups);
  }
  const tmp = file + TMP_SUFFIX;
  await fs.rm(tmp, { force: true });
  await fs.writeFile(tmp, content, { mode, flag: 'wx' });
  await fs.chmod(tmp, mode);
  await fs.rename(tmp, file);
}

interface BackupName {
  name: string;
  ms: number;
  seq: number;
}

function parseBackupName(base: string, name: string): BackupName | undefined {
  if (!name.startsWith(base)) return undefined;
  const m = /^(\d+)(?:-(\d+))?$/.exec(name.slice(base.length));
  if (!m) return undefined;
  return { name, ms: Number(m[1]), seq: m[2] === undefined ? 0 : Number(m[2]) };
}

/** `<file>.omnicode-bak.<ms>`로 복사하고 오래된 백업을 지운다. 같은 밀리초에 겹치면 `-1`, `-2` 접미사를 붙인다. */
async function backupFile(file: string, keep: number): Promise<void> {
  const dir = path.dirname(file);
  const base = path.basename(file) + BAK_SUFFIX;
  const ms = Date.now();
  let bak = path.join(dir, `${base}${ms}`);
  for (let seq = 1; await fileExists(bak); seq++) bak = path.join(dir, `${base}${ms}-${seq}`);
  await fs.copyFile(file, bak);
  await fs.chmod(bak, FILE_MODE);

  const entries = (await fs.readdir(dir))
    .map((n) => parseBackupName(base, n))
    .filter((b): b is BackupName => b !== undefined)
    .sort((a, b) => b.ms - a.ms || b.seq - a.seq);
  for (const stale of entries.slice(keep)) {
    await fs.rm(path.join(dir, stale.name), { force: true });
  }
}

/** 파일의 권한 비트(0o777 마스크). 테스트와 상태 점검용. */
export async function fileMode(file: string): Promise<number> {
  const st = await fs.stat(file);
  return st.mode & 0o777;
}
