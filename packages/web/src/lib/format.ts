/** 표시용 포맷 함수 (순수). */

const dtf = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return dtf.format(d);
}

export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Math.round((now - t) / 1000);
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '전' : '후';
  if (abs < 60) return `${abs}초 ${suffix}`;
  if (abs < 3600) return `${Math.floor(abs / 60)}분 ${suffix}`;
  if (abs < 86400) return `${Math.floor(abs / 3600)}시간 ${suffix}`;
  return `${Math.floor(abs / 86400)}일 ${suffix}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function formatUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}일`);
  if (d || h) parts.push(`${h}시간`);
  parts.push(`${m}분`);
  return parts.join(' ');
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export function prettyJson(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2) ?? '';
  } catch {
    return String(x);
  }
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 업스트림 serverInfo에서 name·version만 뽑는다 (문자열만, 텍스트 렌더링용). */
export function serverInfoSummary(info: Record<string, unknown> | null): { name: string | null; version: string | null } {
  if (!info) return { name: null, version: null };
  const name = typeof info['name'] === 'string' ? (info['name'] as string) : null;
  const version = typeof info['version'] === 'string' ? (info['version'] as string) : null;
  return { name, version };
}
