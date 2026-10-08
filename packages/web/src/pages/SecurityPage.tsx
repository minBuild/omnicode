import { useState } from 'react';
import type { PasskeyView } from '@omnicode/shared';
import { authApi } from '../api/auth';
import { useAsync, useResource } from '../api/hooks';
import { describeError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { addPasskey, describeUserAgent, guessDeviceLabel, isCeremonyCancelled } from '../auth/flows';
import { Badge, ButtonRow, Dialog, ErrorNotice, Field, Loading, Notice, Section } from '../components/ui';
import { formatDateTime, formatRelative } from '../lib/format';
import { app, authText as t } from '../i18n/ko';

export function SecurityPage() {
  const { status, logout } = useAuth();
  if (status?.mode === 'dev') {
    return (
      <>
        <div className="page-head">
          <h1>{t.securityHeading}</h1>
        </div>
        <Notice tone="warn">{t.devModeNotice}</Notice>
        <ButtonRow>
          <button type="button" className="btn" onClick={() => void logout()}>
            {t.logout}
          </button>
        </ButtonRow>
      </>
    );
  }
  return (
    <>
      <div className="page-head">
        <h1>{t.securityHeading}</h1>
      </div>
      <PasskeysSection />
      <SessionsSection />
      <Section title={t.recoveryHeading} id="recovery">
        <p className="muted">{t.recoveryText}</p>
        <pre className="mono command">{t.recoveryCommand}</pre>
      </Section>
    </>
  );
}

function PasskeysSection() {
  const passkeys = useResource((signal) => authApi.passkeys(signal), []);
  const [label, setLabel] = useState(() => guessDeviceLabel(typeof navigator === 'undefined' ? '' : navigator.userAgent));
  const [addMessage, setAddMessage] = useState<{ tone: 'danger' | 'info'; text: string } | null>(null);
  const [toDelete, setToDelete] = useState<PasskeyView | null>(null);
  const add = useAsync(async () => {
    setAddMessage(null);
    try {
      await addPasskey(label.trim());
      await passkeys.refetch();
    } catch (e) {
      setAddMessage(isCeremonyCancelled(e) ? { tone: 'info', text: t.cancelled } : { tone: 'danger', text: describeError(e) });
    }
  });
  const del = useAsync(async (id: string) => {
    await authApi.deletePasskey(id);
    setToDelete(null);
    await passkeys.refetch();
  });
  const list = passkeys.data ?? [];

  return (
    <Section title={t.passkeys} id="passkeys">
      {passkeys.loading && !passkeys.data && <Loading />}
      <ErrorNotice error={passkeys.error} onRetry={() => void passkeys.refetch()} />
      <ul className="plain-list">
        {list.map((p) => (
          <li key={p.id} className="row-item">
            <div>
              <strong>{p.label}</strong>{' '}
              <Badge tone={p.backedUp ? 'ok' : 'muted'}>{p.backedUp ? t.passkeySynced : t.passkeyDeviceBound}</Badge>
              <p className="muted small">
                {t.passkeyCreated} {formatDateTime(p.createdAt)} · {t.passkeyLastUsed} {p.lastUsedAt ? formatRelative(p.lastUsedAt) : t.passkeyNeverUsed}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setToDelete(p)}
              disabled={list.length <= 1}
              title={list.length <= 1 ? t.lastPasskey : undefined}
            >
              {t.deletePasskey}
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small">{t.addPasskeyHint}</p>
      <Field label={t.passkeyLabel} hint={t.passkeyLabelHint} htmlFor="new-passkey-label">
        <input id="new-passkey-label" type="text" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      {addMessage && <Notice tone={addMessage.tone}>{addMessage.text}</Notice>}
      <ErrorNotice error={add.error} />
      <button type="button" className="btn btn-primary" onClick={() => void add.run()} disabled={add.pending || label.trim().length === 0}>
        {add.pending ? t.addingPasskey : t.addPasskey}
      </button>

      <Dialog open={toDelete !== null} title={t.deletePasskey} onClose={() => setToDelete(null)}>
        {toDelete && <p>{t.deletePasskeyConfirm(toDelete.label)}</p>}
        <ErrorNotice error={del.error} />
        <ButtonRow>
          <button type="button" className="btn btn-danger" onClick={() => toDelete && void del.run(toDelete.id)} disabled={del.pending}>
            {t.deletePasskey}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setToDelete(null)}>
            {app.cancel}
          </button>
        </ButtonRow>
      </Dialog>
    </Section>
  );
}

function SessionsSection() {
  const { logout } = useAuth();
  const sessions = useResource((signal) => authApi.sessions(signal), []);
  const end = useAsync(async (id: string, current: boolean) => {
    if (current) {
      await logout();
      return;
    }
    await authApi.revokeSession(id);
    await sessions.refetch();
  });

  return (
    <Section title={t.sessions} id="sessions">
      {sessions.loading && !sessions.data && <Loading />}
      <ErrorNotice error={sessions.error} onRetry={() => void sessions.refetch()} />
      <ErrorNotice error={end.error} />
      <ul className="plain-list">
        {(sessions.data ?? []).map((s) => (
          <li key={s.id} className="row-item">
            <div>
              <strong>{describeUserAgent(s.userAgent)}</strong> {s.current && <Badge tone="info">{t.currentSession}</Badge>}
              <p className="muted small">
                {t.sessionLastSeen} {formatRelative(s.lastSeenAt)} · {t.sessionCreated} {formatDateTime(s.createdAt)} · {t.sessionExpires}{' '}
                {formatDateTime(s.expiresAt)}
              </p>
            </div>
            <button type="button" className="btn btn-ghost" onClick={() => void end.run(s.id, s.current)} disabled={end.pending}>
              {s.current ? t.logout : t.endSession}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
