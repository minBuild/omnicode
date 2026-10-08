/** 공용 UI 조각. 프레임워크 없이 styles.css의 클래스만 쓴다. */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { app } from '../i18n/ko';
import { describeError, isApiClientError } from '../api/client';
import type { BadgeTone } from '../lib/status';

export function Badge({ tone = 'muted', children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Dot({ tone, label }: { tone: BadgeTone; label: string }) {
  return <span className={`dot dot-${tone}`} role="img" aria-label={label} title={label} />;
}

export function Loading({ label = app.loading }: { label?: string }) {
  return (
    <p className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> {label}
    </p>
  );
}

export function ErrorNotice({ error, onRetry, retryLabel = app.retry }: { error: unknown; onRetry?: () => void; retryLabel?: string }) {
  if (error === undefined || error === null) return null;
  const code = isApiClientError(error) ? error.code : null;
  return (
    <div className="notice notice-danger" role="alert">
      <p>{describeError(error)}</p>
      {code && <p className="muted small">code: {code}</p>}
      {onRetry && (
        <button type="button" className="btn btn-ghost" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

export function Notice({ tone = 'info', children, role }: { tone?: BadgeTone; children: ReactNode; role?: 'status' | 'alert' }) {
  return (
    <div className={`notice notice-${tone}`} role={role ?? (tone === 'danger' ? 'alert' : 'status')}>
      {children}
    </div>
  );
}

export function Section({ title, children, actions, id }: { title: string; children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <section className="card" aria-labelledby={id ? `${id}-h` : undefined} id={id}>
      <div className="card-head">
        <h2 id={id ? `${id}-h` : undefined}>{title}</h2>
        {actions && <div className="card-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  hideLabel,
  description,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  hideLabel?: boolean;
  description?: string;
}) {
  const id = useId();
  return (
    <label className="switch" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-checked={checked}
        aria-label={hideLabel ? label : undefined}
        aria-description={description}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" aria-hidden="true" />
      <span className={hideLabel ? 'sr-only' : 'switch-label'}>{label}</span>
    </label>
  );
}

export function KeyValue({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div className="kv-row" key={k}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function JsonBlock({ value, label }: { value: string; label?: string }) {
  return (
    <pre className="json" aria-label={label} tabIndex={0}>
      {value}
    </pre>
  );
}

export interface TabItem {
  key: string;
  label: string;
  disabled?: boolean;
  note?: string;
}

export function Tabs({ items, active, onChange, ariaLabel }: { items: TabItem[]; active: string; onChange: (key: string) => void; ariaLabel: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          className={`tab${active === t.key ? ' tab-active' : ''}`}
          aria-selected={active === t.key}
          aria-disabled={t.disabled || undefined}
          disabled={t.disabled}
          title={t.note}
          onClick={() => !t.disabled && onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** 네이티브 <dialog>로 모달을 띄운다 (포커스 가둠·ESC는 브라우저가 처리). */
export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onClose} onCancel={onClose}>
      <h2 id={titleId}>{title}</h2>
      {open && children}
    </dialog>
  );
}

export function ButtonRow({ children }: { children: ReactNode }) {
  return <div className="btn-row">{children}</div>;
}
