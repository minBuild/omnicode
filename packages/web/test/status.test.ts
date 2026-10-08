import { describe, expect, it } from 'vitest';
import {
  ALL_AGENTS,
  defaultAgentSelection,
  defaultToolSelection,
  extraBadgeLabels,
  isHttpsUrl,
  isValidServerId,
  needsMoreScope,
  statusLabel,
  statusTone,
  summaryStatusLabel,
  syncLabel,
  syncTone,
} from '../src/lib/status';
import { errorMessages, statusLabels } from '../src/i18n/ko';

/** 14.3 + errors.ts의 모든 ApiErrorCode. 타입으로도 강제되지만 런타임에서도 빠짐없음을 확인한다. */
const API_ERROR_CODES = [
  'validation_error',
  'invalid_url',
  'ssrf_blocked',
  'stale_tool_hash',
  'oauth_state_invalid',
  'oauth_issuer_mismatch',
  'oauth_denied',
  'unauthenticated',
  'reauth_required',
  'forbidden',
  'not_found',
  'conflict',
  'invalid_transition',
  'probe_failed',
  'unsupported_transport',
  'oauth_registration_failed',
  'oauth_not_applicable',
  'agentd_unavailable',
  'sync_failed',
  'upstream_error',
  'internal',
] as const;

describe('status → badge label (15장 1번)', () => {
  it('maps every server status to the designed Korean label', () => {
    expect(statusLabel('active')).toBe('연결됨');
    expect(statusLabel('needs_auth')).toBe('로그인 필요');
    expect(statusLabel('changed')).toBe('변경 감지');
    expect(statusLabel('error')).toBe('오류');
    expect(statusLabel('disabled')).toBe('꺼짐');
    expect(statusLabel('deleting')).toBe('삭제 중');
    expect(statusLabel('pending_approval')).toBe('승인 대기');
    expect(statusLabel('draft')).toBe('확인 중');
    expect(Object.keys(statusLabels).sort()).toEqual(['active', 'changed', 'deleting', 'disabled', 'draft', 'error', 'needs_auth', 'pending_approval']);
  });

  it('shows 추가 권한 필요 only for needs_auth with scope step-up', () => {
    expect(statusLabel('needs_auth', { scopeStepUp: true })).toBe('추가 권한 필요');
    expect(statusLabel('active', { scopeStepUp: true })).toBe('연결됨');
  });

  it('assigns tones', () => {
    expect(statusTone('active')).toBe('ok');
    expect(statusTone('needs_auth')).toBe('warn');
    expect(statusTone('error')).toBe('danger');
    expect(statusTone('disabled')).toBe('muted');
  });

  it('summary label reads scope badges from badges[]', () => {
    expect(summaryStatusLabel({ status: 'needs_auth', badges: ['scope_stepup'] })).toBe('추가 권한 필요');
    expect(summaryStatusLabel({ status: 'needs_auth', badges: [] })).toBe('로그인 필요');
    expect(summaryStatusLabel({ status: 'active', badges: ['scope_stepup'] })).toBe('연결됨');
  });

  it('extra badges map known keys, keep unknown text, drop duplicates and scope badges', () => {
    expect(extraBadgeLabels(['private_host', 'scope_stepup', 'mystery', 'private_host'])).toEqual(['사설 주소', 'mystery']);
    expect(extraBadgeLabels([])).toEqual([]);
  });
});

describe('needsMoreScope (10.3 scope step-up)', () => {
  it('is true when requested scope exceeds granted scope while needs_auth', () => {
    expect(needsMoreScope({ requestedScope: 'tts voices asr', grantedScope: 'tts voices' }, 'needs_auth')).toBe(true);
    expect(needsMoreScope({ requestedScope: 'tts voices', grantedScope: 'voices tts' }, 'needs_auth')).toBe(false);
    expect(needsMoreScope({ requestedScope: 'tts', grantedScope: null }, 'needs_auth')).toBe(false);
    expect(needsMoreScope({ requestedScope: 'tts asr', grantedScope: 'tts' }, 'active')).toBe(false);
  });
});

describe('sync labels', () => {
  it('maps sync status and tones', () => {
    expect(syncLabel('synced')).toBe('동기화됨');
    expect(syncLabel('failed')).toBe('동기화 실패');
    expect(syncLabel(null)).toBe('동기화 안 됨');
    expect(syncTone('synced', true)).toBe('ok');
    expect(syncTone('failed', true)).toBe('danger');
    expect(syncTone('pending', true)).toBe('warn');
    expect(syncTone('synced', false)).toBe('muted');
  });
});

describe('approval defaults (15장 2번)', () => {
  it('unchecks destructive tools and checks the rest', () => {
    const sel = defaultToolSelection([
      { name: 'read', annotations: { readOnlyHint: true } },
      { name: 'delete_all', annotations: { destructiveHint: true } },
      { name: 'plain', annotations: null },
    ]);
    expect(sel).toEqual({ read: true, delete_all: false, plain: true });
  });

  it('prefers preset defaultAgents, then bindings, then all', () => {
    expect(defaultAgentSelection(['claude', 'codex'], undefined)).toEqual({ claude: true, codex: true, gemini: false });
    expect(defaultAgentSelection(undefined, { claude: { enabled: false }, codex: { enabled: true }, gemini: { enabled: false } })).toEqual({
      claude: false,
      codex: true,
      gemini: false,
    });
    expect(defaultAgentSelection([], { claude: { enabled: false }, codex: { enabled: false }, gemini: { enabled: false } })).toEqual({
      claude: true,
      codex: true,
      gemini: true,
    });
    expect(ALL_AGENTS).toEqual(['claude', 'codex', 'gemini']);
  });
});

describe('isHttpsUrl (16.3 인가 URL 재확인)', () => {
  it('accepts only https URLs with a host', () => {
    expect(isHttpsUrl('https://auth.example.com/authorize?x=1')).toBe(true);
    expect(isHttpsUrl('http://auth.example.com/')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsUrl('data:text/html,hi')).toBe(false);
    expect(isHttpsUrl('vbscript:x')).toBe(false);
    expect(isHttpsUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpsUrl('not a url')).toBe(false);
    expect(isHttpsUrl('')).toBe(false);
  });
});

describe('server id validation (9.3)', () => {
  it('matches [a-z0-9-]{1,40}', () => {
    expect(isValidServerId('fish-audio')).toBe(true);
    expect(isValidServerId('Fish')).toBe(false);
    expect(isValidServerId('')).toBe(false);
    expect(isValidServerId('a'.repeat(41))).toBe(false);
  });
});

describe('error message table', () => {
  it('has a Korean message for every ApiErrorCode', () => {
    for (const code of API_ERROR_CODES) {
      expect(errorMessages[code], code).toBeTypeOf('string');
      expect(errorMessages[code].length, code).toBeGreaterThan(0);
    }
    expect(Object.keys(errorMessages).sort()).toEqual([...API_ERROR_CODES].sort());
  });
});
