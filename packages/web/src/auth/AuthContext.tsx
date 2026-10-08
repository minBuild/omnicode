/**
 * 인증 상태와 재인증 창 (설계 0002 9장).
 * API 클라이언트 가로채기를 등록해, 어느 화면이든 reauth_required 를 받으면 재인증 창을 띄우고
 * 성공하면 원래 요청을 자동으로 다시 보낸다. unauthenticated 를 받으면 로그인 화면으로 보낸다.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AuthStatus } from '@omnicode/shared';
import { authApi } from '../api/auth';
import { describeError, setAuthInterceptors } from '../api/client';
import { Dialog, ButtonRow, Notice } from '../components/ui';
import { app, authText as t } from '../i18n/ko';
import { isCeremonyCancelled, reauthWithPasskey } from './flows';

export interface AuthContextValue {
  status: AuthStatus | undefined;
  loading: boolean;
  error: unknown;
  /** 세션이 끝나 로그인 화면으로 보냈을 때 true (로그인 화면이 안내 문구를 보인다) */
  expired: boolean;
  refresh: () => Promise<AuthStatus | undefined>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(undefined);
  const [expired, setExpired] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await authApi.status();
      setStatus(s);
      setError(undefined);
      if (s.authenticated) setExpired(false);
      return s;
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setExpired(false);
      await refresh();
    }
  }, [refresh]);

  // --- 재인증 창 ---------------------------------------------------------
  const [reauthOpen, setReauthOpen] = useState(false);
  const [reauthPending, setReauthPending] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);
  /** 동시에 여러 요청이 재인증을 원해도 창은 하나, 결과는 모두가 공유한다 */
  const waiters = useRef<Array<(ok: boolean) => void>>([]);

  const settle = useCallback((ok: boolean) => {
    const list = waiters.current.splice(0);
    for (const resolve of list) resolve(ok);
    setReauthOpen(false);
    setReauthPending(false);
    setReauthError(null);
  }, []);

  const requestReauth = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        waiters.current.push(resolve);
        setReauthOpen(true);
      }),
    [],
  );

  const confirmReauth = useCallback(async () => {
    setReauthPending(true);
    setReauthError(null);
    try {
      await reauthWithPasskey();
      await refresh();
      settle(true);
    } catch (e) {
      setReauthPending(false);
      setReauthError(isCeremonyCancelled(e) ? t.cancelled : describeError(e));
    }
  }, [refresh, settle]);

  useEffect(
    () =>
      setAuthInterceptors({
        onReauthRequired: requestReauth,
        onUnauthenticated: () => {
          setExpired(true);
          setStatus((prev) => (prev ? { ...prev, authenticated: false, session: null, recentAuthUntil: null } : prev));
        },
      }),
    [requestReauth],
  );

  const value = useMemo<AuthContextValue>(() => ({ status, loading, error, expired, refresh, logout }), [status, loading, error, expired, refresh, logout]);

  return (
    <AuthContext.Provider value={value}>
      {children}
      <Dialog open={reauthOpen} title={t.reauthTitle} onClose={() => settle(false)}>
        <p>{t.reauthLead}</p>
        {reauthError && <Notice tone="danger" role="alert">{reauthError}</Notice>}
        <ButtonRow>
          <button type="button" className="btn btn-primary" onClick={() => void confirmReauth()} disabled={reauthPending} autoFocus>
            {reauthPending ? t.reauthing : t.reauthButton}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => settle(false)} disabled={reauthPending}>
            {app.cancel}
          </button>
        </ButtonRow>
      </Dialog>
    </AuthContext.Provider>
  );
}
