import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { describeError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { guessDeviceLabel, isCeremonyCancelled, setupWithPasskey } from '../auth/flows';
import { Field, Loading, Notice, Section } from '../components/ui';
import { authText as t } from '../i18n/ko';

export function SetupPage() {
  const { status, refresh } = useAuth();
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const [label, setLabel] = useState(() => guessDeviceLabel(typeof navigator === 'undefined' ? '' : navigator.userAgent));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: 'danger' | 'info'; text: string } | null>(null);

  if (!status) return <Loading label={t.checking} />;
  if (!status.setupRequired) return <Navigate to={status.authenticated ? '/mcp' : '/login'} replace />;

  const supported = browserSupportsWebAuthn();
  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      await setupWithPasskey(token, label);
      await refresh();
      navigate('/mcp', { replace: true });
    } catch (e) {
      setMessage(isCeremonyCancelled(e) ? { tone: 'info', text: t.cancelled } : { tone: 'danger', text: describeError(e) });
    } finally {
      setPending(false);
    }
  };

  return (
    <Section title={t.setupHeading} id="setup">
      <p>{t.setupLead}</p>
      <p className="muted">{t.setupHowTo}</p>
      <pre className="mono command">{t.setupCommand}</pre>
      {!supported && <Notice tone="danger">{t.noWebAuthn}</Notice>}
      <form onSubmit={(e) => void onSubmit(e)}>
        <Field label={t.setupTokenLabel} htmlFor="setup-token">
          <input
            id="setup-token"
            className="mono"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
        </Field>
        <Field label={t.passkeyLabel} hint={t.passkeyLabelHint} htmlFor="passkey-label">
          <input id="passkey-label" type="text" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} required />
        </Field>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        <button type="submit" className="btn btn-primary btn-block" disabled={pending || !supported || token.trim().length < 20 || label.trim().length === 0}>
          {pending ? t.registering : t.setupButton}
        </button>
      </form>
    </Section>
  );
}
