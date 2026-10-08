import { describe, expect, it } from 'vitest';
import { formatDuration, formatRelative, formatUptime, prettyJson, serverInfoSummary, truncate } from '../src/lib/format';

describe('format helpers', () => {
  it('formatDuration', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(65_000)).toBe('1m 5s');
  });

  it('formatUptime', () => {
    expect(formatUptime(0)).toBe('0분');
    expect(formatUptime(3700)).toBe('1시간 1분');
    expect(formatUptime(90_061)).toBe('1일 1시간 1분');
  });

  it('formatRelative', () => {
    const now = Date.parse('2026-10-07T08:10:00Z');
    expect(formatRelative('2026-10-07T08:09:30Z', now)).toBe('30초 전');
    expect(formatRelative('2026-10-07T07:10:00Z', now)).toBe('1시간 전');
    expect(formatRelative('2026-10-05T08:10:00Z', now)).toBe('2일 전');
    expect(formatRelative('2026-10-07T08:25:00Z', now)).toBe('15분 후');
    expect(formatRelative(null, now)).toBe('—');
    expect(formatRelative('garbage', now)).toBe('garbage');
  });

  it('prettyJson and truncate', () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyJson(null)).toBe('null');
    expect(truncate('abcdef', 3)).toBe('abc…');
    expect(truncate('abc', 3)).toBe('abc');
  });

  it('serverInfoSummary reads only string name/version', () => {
    expect(serverInfoSummary(null)).toEqual({ name: null, version: null });
    expect(serverInfoSummary({ name: 'fish', version: '1.2' })).toEqual({ name: 'fish', version: '1.2' });
    expect(serverInfoSummary({ name: 7, version: { x: 1 } })).toEqual({ name: null, version: null });
  });
});
