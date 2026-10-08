/**
 * 인증 서비스 — 패스키 등록·로그인·재인증, 세션, 설치 토큰 (설계 0002 5·6장).
 * HTTP 를 모른다. 라우트(routes/auth.ts)와 훅(auth/session.ts)이 이것을 쓴다.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { ApiError, type AuthStatus, type PasskeyView, type SessionView, type WebAuthnChallenge } from '@omnicode/shared';
import type { AuthStore, ChallengePurpose, PasskeyRecord, SessionRecord } from './store.js';

export const SESSION_COOKIE_NAME = '__Host-omnicode_session';
export const SETUP_TOKEN_FILE = 'setup-token';

const DAY_MS = 24 * 60 * 60 * 1000;
export const AUTH_DEFAULTS = {
  idleMs: 7 * DAY_MS,
  maxMs: 30 * DAY_MS,
  recentAuthMs: 5 * 60 * 1000,
  challengeTtlMs: 5 * 60 * 1000,
  setupTokenTtlMs: DAY_MS,
  touchIntervalMs: 60 * 1000,
} as const;

const LABEL_MAX = 60;
const USER_AGENT_MAX = 200;

export interface AuthLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface AuthServiceOptions {
  store: AuthStore;
  /** 공개 URL 의 origin (예: https://omni.example). WebAuthn expectedOrigin */
  origin: string;
  /** WebAuthn RP ID — origin 의 호스트 이름 */
  rpId: string;
  rpName?: string;
  /** 설치 토큰 파일을 둘 디렉터리. null 이면 파일을 쓰지 않는다 (테스트) */
  dataDir: string | null;
  idleMs?: number;
  maxMs?: number;
  recentAuthMs?: number;
  now?: () => Date;
  logger?: AuthLogger;
}

/** 새 세션: 쿠키에 넣을 토큰 원문과 레코드 */
export interface IssuedSession {
  token: string;
  session: SessionRecord;
}

export interface SetupTokenState {
  required: boolean;
  /** 이번 호출에서 새로 만들었으면 원문 (파일에도 썼다) */
  token: string | null;
  path: string | null;
}

export interface AuthService {
  readonly rpId: string;
  readonly origin: string;
  readonly recentAuthMs: number;
  /** 쿠키 토큰 → 유효한 세션. 만료면 지우고 null. 1분에 한 번 last_seen 갱신 */
  resolveSession(token: string | undefined): SessionRecord | null;
  isRecent(session: SessionRecord): boolean;
  recentAuthUntil(session: SessionRecord): string | null;
  status(token: string | undefined): AuthStatus;

  /** 시작 시: 패스키가 없으면 설치 토큰을 보장한다 (파일에 유효한 토큰이 있으면 그대로) */
  ensureSetupToken(): SetupTokenState;
  /** CLI `auth setup-token`: 패스키가 없을 때만 새 토큰 */
  regenerateSetupToken(): string;
  /** CLI `auth reset`: 패스키·세션·챌린지를 모두 지우고 새 설치 토큰 */
  resetAll(): { passkeys: number; sessions: number; token: string };

  setupOptions(setupToken: string): Promise<WebAuthnChallenge>;
  setupVerify(input: { setupToken: string; challengeId: string; response: unknown; label?: string; userAgent?: string }): Promise<IssuedSession>;
  loginOptions(): Promise<WebAuthnChallenge>;
  loginVerify(input: { challengeId: string; response: unknown; userAgent?: string }): Promise<IssuedSession>;
  reauthOptions(session: SessionRecord): Promise<WebAuthnChallenge>;
  reauthVerify(session: SessionRecord, input: { challengeId: string; response: unknown }): Promise<{ recentAuthUntil: string }>;

  listPasskeys(): PasskeyView[];
  addPasskeyOptions(session: SessionRecord): Promise<WebAuthnChallenge>;
  addPasskeyVerify(session: SessionRecord, input: { challengeId: string; response: unknown; label: string }): Promise<PasskeyView>;
  deletePasskey(id: string): void;

  listSessions(current: SessionRecord | null): SessionView[];
  revokeSession(publicId: string): boolean;
  logout(token: string | undefined): void;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

function cleanLabel(label: string | undefined, fallback: string): string {
  const t = (label ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, LABEL_MAX);
  return t || fallback;
}

function passkeyView(p: PasskeyRecord): PasskeyView {
  return { id: p.id, label: p.label, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, deviceType: p.deviceType, backedUp: p.backedUp };
}

/** 라이브러리가 던진 검증 오류를 400 webauthn_failed 로 바꾼다. 메시지는 원인 파악용으로 남긴다 */
function webauthnFailure(e: unknown): ApiError {
  const reason = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
  return new ApiError('webauthn_failed', '패스키 확인에 실패했습니다.', { reason });
}

export function createAuthService(opts: AuthServiceOptions): AuthService {
  const { store, origin, rpId } = opts;
  const rpName = opts.rpName ?? 'OmniCode';
  const idleMs = opts.idleMs ?? AUTH_DEFAULTS.idleMs;
  const maxMs = opts.maxMs ?? AUTH_DEFAULTS.maxMs;
  const recentAuthMs = opts.recentAuthMs ?? AUTH_DEFAULTS.recentAuthMs;
  const now = opts.now ?? (() => new Date());
  const nowIso = () => now().toISOString();
  const tokenPath = opts.dataDir ? join(opts.dataDir, SETUP_TOKEN_FILE) : null;

  // --- 설치 토큰 파일 -----------------------------------------------------
  function writeTokenFile(token: string) {
    if (!tokenPath || !opts.dataDir) return;
    mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${tokenPath}.tmp-${process.pid}`;
    writeFileSync(tmp, token + '\n', { mode: 0o600 });
    renameSync(tmp, tokenPath);
  }
  function readTokenFile(): string | null {
    if (!tokenPath) return null;
    try {
      return readFileSync(tokenPath, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }
  function removeTokenFile() {
    if (tokenPath) rmSync(tokenPath, { force: true });
  }
  function issueSetupToken(): string {
    const token = randomToken();
    const created = now();
    store.setupTokens.create({
      tokenSha256: sha256Hex(token),
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + AUTH_DEFAULTS.setupTokenTtlMs).toISOString(),
      usedAt: null,
    });
    writeTokenFile(token);
    opts.logger?.info({ path: tokenPath }, '설치 토큰을 만들었습니다. 이 파일의 토큰으로 /setup 에서 첫 패스키를 등록하세요');
    return token;
  }
  function checkSetupToken(setupToken: string): string {
    if (store.passkeys.count() > 0) throw new ApiError('conflict', '이미 패스키가 등록되어 있습니다. 로그인하세요.');
    const hash = sha256Hex(setupToken.trim());
    const rec = store.setupTokens.findValid(hash, nowIso());
    if (!rec || !safeEqualHex(rec.tokenSha256, hash)) throw new ApiError('setup_token_invalid', '설치 토큰이 올바르지 않거나 만료되었습니다.');
    return hash;
  }

  // --- 챌린지 ------------------------------------------------------------
  function saveChallenge(purpose: ChallengePurpose, challenge: string, sessionId: string | null): string {
    const id = randomToken(18);
    const created = now();
    store.challenges.purge(created.toISOString());
    store.challenges.create({
      id,
      purpose,
      challenge,
      sessionId,
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + AUTH_DEFAULTS.challengeTtlMs).toISOString(),
      usedAt: null,
    });
    return id;
  }
  function takeChallenge(id: string, purpose: ChallengePurpose, sessionId: string | null): string {
    const rec = store.challenges.consume(id, purpose, sessionId, nowIso());
    if (!rec) throw new ApiError('challenge_invalid', '인증 요청이 만료되었거나 이미 사용되었습니다.');
    return rec.challenge;
  }

  // --- 세션 ---------------------------------------------------------------
  function issueSession(passkeyId: string, userAgent: string | undefined): IssuedSession {
    const token = randomToken();
    const t = now();
    const iso = t.toISOString();
    const session: SessionRecord = {
      tokenSha256: sha256Hex(token),
      publicId: randomToken(18),
      createdAt: iso,
      lastSeenAt: iso,
      expiresAt: new Date(t.getTime() + maxMs).toISOString(),
      authAt: iso,
      passkeyId,
      userAgent: userAgent ? userAgent.slice(0, USER_AGENT_MAX) : null,
    };
    store.sessions.purge(iso, new Date(t.getTime() - idleMs).toISOString());
    store.sessions.create(session);
    return { token, session };
  }

  function registrationOptions(excludeAll: boolean) {
    const userHandle = store.userHandle();
    return generateRegistrationOptions({
      rpName,
      rpID: rpId,
      userName: `owner@${rpId}`,
      userDisplayName: `OmniCode (${rpId})`,
      userID: Buffer.from(userHandle, 'base64url'),
      attestationType: 'none',
      excludeCredentials: excludeAll ? store.passkeys.list().map((p) => ({ id: p.id, transports: p.transports })) : [],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: AUTH_DEFAULTS.challengeTtlMs,
    });
  }

  async function verifyRegistration(response: unknown, expectedChallenge: string): Promise<Omit<PasskeyRecord, 'label' | 'createdAt' | 'lastUsedAt'>> {
    let result;
    try {
      result = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        requireUserVerification: true,
      });
    } catch (e) {
      throw webauthnFailure(e);
    }
    if (!result.verified) throw webauthnFailure(new Error('registration not verified'));
    const info = result.registrationInfo;
    if (store.passkeys.get(info.credential.id)) throw new ApiError('conflict', '이미 등록된 패스키입니다.');
    return {
      id: info.credential.id,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      aaguid: info.aaguid ?? null,
    };
  }

  async function verifyAssertion(response: unknown, expectedChallenge: string): Promise<PasskeyRecord> {
    const credentialId = typeof (response as { id?: unknown } | null)?.id === 'string' ? (response as { id: string }).id : '';
    const passkey = credentialId ? store.passkeys.get(credentialId) : undefined;
    if (!passkey) throw new ApiError('webauthn_failed', '등록되지 않은 패스키입니다.', { reason: 'unknown_credential' });
    const userHandle = (response as AuthenticationResponseJSON).response?.userHandle;
    if (userHandle && userHandle !== store.userHandle()) {
      throw new ApiError('webauthn_failed', '등록되지 않은 패스키입니다.', { reason: 'user_handle_mismatch' });
    }
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: { id: passkey.id, publicKey: passkey.publicKey, counter: passkey.counter, transports: passkey.transports },
        requireUserVerification: true,
      });
    } catch (e) {
      throw webauthnFailure(e);
    }
    if (!result.verified) throw webauthnFailure(new Error('authentication not verified'));
    store.passkeys.recordUse(passkey.id, result.authenticationInfo.newCounter, nowIso());
    return passkey;
  }

  const service: AuthService = {
    rpId,
    origin,
    recentAuthMs,

    resolveSession(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
      const hash = sha256Hex(token);
      const s = store.sessions.byTokenHash(hash);
      if (!s) return null;
      const t = now().getTime();
      if (Date.parse(s.expiresAt) <= t || Date.parse(s.lastSeenAt) + idleMs <= t) {
        store.sessions.delete(hash);
        return null;
      }
      if (t - Date.parse(s.lastSeenAt) >= AUTH_DEFAULTS.touchIntervalMs) {
        const iso = new Date(t).toISOString();
        store.sessions.touch(hash, iso);
        return { ...s, lastSeenAt: iso };
      }
      return s;
    },

    isRecent(session) {
      return now().getTime() - Date.parse(session.authAt) <= recentAuthMs;
    },

    recentAuthUntil(session) {
      const until = Date.parse(session.authAt) + recentAuthMs;
      return until > now().getTime() ? new Date(until).toISOString() : null;
    },

    status(token) {
      const session = service.resolveSession(token);
      return {
        mode: 'session',
        authenticated: session !== null,
        setupRequired: store.passkeys.count() === 0,
        recentAuthUntil: session ? service.recentAuthUntil(session) : null,
        session: session ? { id: session.publicId, createdAt: session.createdAt, expiresAt: session.expiresAt } : null,
      };
    },

    ensureSetupToken() {
      if (store.passkeys.count() > 0) {
        removeTokenFile();
        return { required: false, token: null, path: null };
      }
      const existing = readTokenFile();
      if (existing && store.setupTokens.findValid(sha256Hex(existing), nowIso())) {
        return { required: true, token: null, path: tokenPath };
      }
      // 파일이 없는 테스트·개발 모드에서도 유효한 토큰이 이미 있으면 새로 만들지 않는다
      if (!tokenPath && store.setupTokens.anyValid(nowIso())) return { required: true, token: null, path: null };
      return { required: true, token: issueSetupToken(), path: tokenPath };
    },

    regenerateSetupToken() {
      if (store.passkeys.count() > 0) {
        throw new ApiError('conflict', '패스키가 이미 있습니다. 모두 지우고 다시 시작하려면 `auth reset` 을 쓰세요.');
      }
      store.setupTokens.deleteAll();
      return issueSetupToken();
    },

    resetAll() {
      const counts = store.transaction(() => {
        const passkeys = store.passkeys.deleteAll();
        const sessions = store.sessions.deleteAll();
        store.challenges.purge('9999-12-31T23:59:59.999Z');
        store.setupTokens.deleteAll();
        return { passkeys, sessions };
      });
      opts.logger?.warn(counts, '인증 정보를 초기화했습니다 (auth reset)');
      return { ...counts, token: issueSetupToken() };
    },

    async setupOptions(setupToken) {
      checkSetupToken(setupToken);
      const options = await registrationOptions(false);
      const challengeId = saveChallenge('setup', options.challenge, null);
      return { challengeId, options: options as unknown as Record<string, unknown> };
    },

    async setupVerify({ setupToken, challengeId, response, label, userAgent }) {
      const tokenHash = checkSetupToken(setupToken);
      const challenge = takeChallenge(challengeId, 'setup', null);
      const cred = await verifyRegistration(response, challenge);
      const at = nowIso();
      const issued = store.transaction(() => {
        // 동시에 두 번 설정을 시도해도 첫 번째만 성공한다
        if (!store.setupTokens.markUsed(tokenHash, at)) throw new ApiError('setup_token_invalid', '설치 토큰이 이미 사용되었습니다.');
        if (store.passkeys.count() > 0) throw new ApiError('conflict', '이미 패스키가 등록되어 있습니다.');
        store.passkeys.insert({ ...cred, label: cleanLabel(label, '첫 패스키'), createdAt: at, lastUsedAt: at });
        return issueSession(cred.id, userAgent);
      });
      removeTokenFile();
      opts.logger?.info({ passkey: cred.id.slice(0, 8) }, '첫 패스키를 등록했습니다');
      return issued;
    },

    async loginOptions() {
      if (store.passkeys.count() === 0) throw new ApiError('conflict', '등록된 패스키가 없습니다. 먼저 설정을 마치세요.', { setupRequired: true });
      const options = await generateAuthenticationOptions({ rpID: rpId, allowCredentials: [], userVerification: 'required', timeout: AUTH_DEFAULTS.challengeTtlMs });
      const challengeId = saveChallenge('login', options.challenge, null);
      return { challengeId, options: options as unknown as Record<string, unknown> };
    },

    async loginVerify({ challengeId, response, userAgent }) {
      const challenge = takeChallenge(challengeId, 'login', null);
      const passkey = await verifyAssertion(response, challenge);
      return issueSession(passkey.id, userAgent);
    },

    async reauthOptions(session) {
      const options = await generateAuthenticationOptions({
        rpID: rpId,
        allowCredentials: store.passkeys.list().map((p) => ({ id: p.id, transports: p.transports })),
        userVerification: 'required',
        timeout: AUTH_DEFAULTS.challengeTtlMs,
      });
      const challengeId = saveChallenge('reauth', options.challenge, session.publicId);
      return { challengeId, options: options as unknown as Record<string, unknown> };
    },

    async reauthVerify(session, { challengeId, response }) {
      const challenge = takeChallenge(challengeId, 'reauth', session.publicId);
      const passkey = await verifyAssertion(response, challenge);
      const at = nowIso();
      store.sessions.setAuth(session.tokenSha256, at, passkey.id);
      return { recentAuthUntil: new Date(Date.parse(at) + recentAuthMs).toISOString() };
    },

    listPasskeys: () => store.passkeys.list().map(passkeyView),

    async addPasskeyOptions(session) {
      const options = await registrationOptions(true);
      const challengeId = saveChallenge('add_passkey', options.challenge, session.publicId);
      return { challengeId, options: options as unknown as Record<string, unknown> };
    },

    async addPasskeyVerify(session, { challengeId, response, label }) {
      const challenge = takeChallenge(challengeId, 'add_passkey', session.publicId);
      const cred = await verifyRegistration(response, challenge);
      const at = nowIso();
      const rec: PasskeyRecord = { ...cred, label: cleanLabel(label, `패스키 ${store.passkeys.count() + 1}`), createdAt: at, lastUsedAt: null };
      store.passkeys.insert(rec);
      return passkeyView(rec);
    },

    deletePasskey(id) {
      store.transaction(() => {
        if (!store.passkeys.get(id)) throw new ApiError('not_found', '패스키를 찾을 수 없습니다.');
        if (store.passkeys.count() <= 1) throw new ApiError('conflict', '마지막 패스키는 지울 수 없습니다. 다른 패스키를 먼저 추가하세요.');
        store.passkeys.delete(id);
      });
    },

    listSessions(current) {
      const t = now().getTime();
      return store.sessions
        .list()
        .filter((s) => Date.parse(s.expiresAt) > t && Date.parse(s.lastSeenAt) + idleMs > t)
        .map((s) => ({
          id: s.publicId,
          current: current !== null && s.publicId === current.publicId,
          createdAt: s.createdAt,
          lastSeenAt: s.lastSeenAt,
          expiresAt: s.expiresAt,
          userAgent: s.userAgent,
        }));
    },

    revokeSession: (publicId) => store.sessions.deleteByPublicId(publicId),

    logout(token) {
      if (typeof token === 'string' && token.length > 0 && token.length <= 200) store.sessions.delete(sha256Hex(token));
    },
  };
  return service;
}
