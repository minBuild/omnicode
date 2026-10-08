/** `/api/auth/*` (설계 0002 8장). 타입만 shared 에서 가져온다. */
import type { AuthStatus, PasskeyView, ReauthResult, SessionView, WebAuthnChallenge } from '@omnicode/shared';
import { apiDelete, apiGet, apiPost } from './client';

export const authApi = {
  status: (signal?: AbortSignal) => apiGet<AuthStatus>('/api/auth/status', signal ? { signal } : {}),
  setupOptions: (setupToken: string) => apiPost<WebAuthnChallenge>('/api/auth/setup/options', { setupToken }),
  setupVerify: (body: { setupToken: string; challengeId: string; response: unknown; label?: string }) => apiPost<{ ok: true }>('/api/auth/setup/verify', body),
  loginOptions: () => apiPost<WebAuthnChallenge>('/api/auth/login/options'),
  loginVerify: (body: { challengeId: string; response: unknown }) => apiPost<{ ok: true }>('/api/auth/login/verify', body),
  reauthOptions: () => apiPost<WebAuthnChallenge>('/api/auth/reauth/options', undefined, { skipReauth: true }),
  reauthVerify: (body: { challengeId: string; response: unknown }) => apiPost<ReauthResult>('/api/auth/reauth/verify', body, { skipReauth: true }),
  logout: () => apiPost<void>('/api/auth/logout'),
  devLogin: (token: string) => apiPost<void>('/api/auth/dev-login', { token }),
  passkeys: (signal?: AbortSignal) => apiGet<PasskeyView[]>('/api/auth/passkeys', signal ? { signal } : {}),
  addPasskeyOptions: () => apiPost<WebAuthnChallenge>('/api/auth/passkeys/options'),
  addPasskeyVerify: (body: { challengeId: string; response: unknown; label: string }) => apiPost<PasskeyView>('/api/auth/passkeys/verify', body),
  deletePasskey: (id: string) => apiDelete<void>(`/api/auth/passkeys/${encodeURIComponent(id)}`),
  sessions: (signal?: AbortSignal) => apiGet<SessionView[]>('/api/auth/sessions', signal ? { signal } : {}),
  revokeSession: (id: string) => apiDelete<void>(`/api/auth/sessions/${encodeURIComponent(id)}`),
};
