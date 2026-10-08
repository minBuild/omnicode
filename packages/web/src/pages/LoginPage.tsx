import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { authApi } from '../api/auth';
import { describeError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { isCeremonyCancelled, loginWithPasskey, safeNextPath } from '../auth/flows';
import { Field, Loading, Notice, Section } from '../components/ui';
import { authText as t } from '../i18n/ko';

export function LoginPage() {
  const { status, refresh, expired } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNextPath(params.get('next'));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: 'danger' | 'info'; text: string } | null>(null);
  const [devToken, setDevToken] = useState('');

  if (!status) return <Loading label={t.checking} />;
  if (status.setupRequired) return <Navigate to="/setup" replace />;
  if (status.authenticated) return <Navigate to={next} replace />;

  const finish = async () => {
    const s = await refresh();
    if (s?.authenticated) navigate(next, { replace: true });
  };

  const onPasskey = async () => {
    setPending(true);
    setMessage(null);
    try {
      await loginWithPasskey();
      await finish();
    } catch (e) {
      setMessage(isCeremonyCancelled(e) ? { tone: 'info', text: t.cancelled } : { tone: 'danger', text: describeError(e) });
    } finally {
      setPending(false);
    }
  };

  const onDev = async (ev: FormEvent) => {
    ev.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      await authApi.devLogin(devToken.trim());
      await finish();
    } catch (e) {
      setMessage({ tone: 'danger', text: describeError(e) });
    } finally {
      setPending(false);
    }
  };

  if (status.mode === 'dev') {
    return (
      <Section title={t.devHeading} id="login-dev">
        <p>{t.devLead}</p>
        {expired && <Notice tone="warn">{t.sessionExpired}</Notice>}
        <form onSubmit={(e) => void onDev(e)}>
          <Field label={t.devTokenLabel} htmlFor="dev-token">
            <input id="dev-token" type="password" autoComplete="off" value={devToken} onChange={(e) => setDevToken(e.target.value)} required />
          </Field>
          {message && <Notice tone={message.tone}>{message.text}</Notice>}
          <button type="submit" className="btn btn-primary" disabled={pending || devToken.trim().length === 0}>
            {t.devLoginButton}
          </button>
        </form>
      </Section>
    );
  }

  const supported = browserSupportsWebAuthn();
  return (
    <Section title={t.loginHeading} id="login">
      <p>{t.loginLead}</p>
      {expired && <Notice tone="warn">{t.sessionExpired}</Notice>}
      {!supported && <Notice tone="danger">{t.noWebAuthn}</Notice>}
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <button type="button" className="btn btn-primary btn-block" onClick={() => void onPasskey()} disabled={pending || !supported} autoFocus>
        {pending ? t.loggingIn : t.loginButton}
      </button>
    </Section>
  );
}
