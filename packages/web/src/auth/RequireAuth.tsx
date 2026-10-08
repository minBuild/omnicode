import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ErrorNotice, Loading } from '../components/ui';
import { authText as t } from '../i18n/ko';
import { useAuth } from './AuthContext';

/** 로그인 필요 화면을 감싼다. 설정 전이면 /setup, 세션이 없으면 /login?next=… 로 보낸다 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, loading, error, refresh } = useAuth();
  const location = useLocation();
  if (!status) {
    if (error && !loading) return <ErrorNotice error={error} onRetry={() => void refresh()} />;
    return <Loading label={t.checking} />;
  }
  if (status.setupRequired) return <Navigate to="/setup" replace />;
  if (!status.authenticated) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}
