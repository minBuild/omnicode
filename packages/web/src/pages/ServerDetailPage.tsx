import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Agent, DeleteResult, EventRecord, ServerDetail } from '@omnicode/shared';
import { mcpApi, type PatchServerInput } from '../api/mcp';
import { useAsync, useResource } from '../api/hooks';
import { app, authTypeLabels, clientModeLabels, detail as t, eraLabels, eventKindLabels, transportLabels, agentLabels } from '../i18n/ko';
import { needsMoreScope } from '../lib/status';
import { formatDateTime, prettyJson, serverInfoSummary, truncate } from '../lib/format';
import { AgentToggles } from '../components/AgentToggles';
import { StatusBadge } from '../components/StatusBadge';
import { ToolAnnotationChips } from '../components/ToolAnnotationChips';
import { startOAuthLogin } from './AddServerPage';
import { Badge, ButtonRow, Dialog, ErrorNotice, Field, KeyValue, Loading, Notice, Section, Switch } from '../components/ui';

function usePatch(id: string, setData: (d: ServerDetail) => void) {
  return useAsync(async (input: PatchServerInput) => {
    const d = await mcpApi.patchServer(id, input);
    setData(d);
    return d;
  });
}

export function ServerDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const res = useResource((signal) => mcpApi.getServer(id, signal), [id]);
  const server = res.data;
  const setData = (d: ServerDetail) => res.setData(d);

  const toolPatch = usePatch(id, setData);
  const bindingPatch = usePatch(id, setData);
  const settingsPatch = usePatch(id, setData);
  const [busyTool, setBusyTool] = useState<string | null>(null);
  const [busyAgent, setBusyAgent] = useState<Agent | null>(null);

  const test = useAsync(() => mcpApi.test(id));
  const probe = useAsync(async () => {
    const d = await mcpApi.probe(id);
    setData(d);
    return d;
  });
  const login = useAsync(startOAuthLogin(id));
  const resync = useAsync(async () => {
    const r = await mcpApi.syncAll();
    await res.refetch();
    return r;
  });

  // 자격증명 변경 폼
  const [keyFormOpen, setKeyFormOpen] = useState(false);
  const [headerName, setHeaderName] = useState('Authorization');
  const [headerValue, setHeaderValue] = useState('');
  const saveKey = useAsync(async () => {
    await mcpApi.putCredentials(id, headerName.trim(), headerValue);
    setHeaderValue('');
    setKeyFormOpen(false);
    setData(await mcpApi.probe(id));
  });
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const saveClient = useAsync(async () => {
    await mcpApi.setOAuthClient(id, clientId.trim(), clientSecret.trim() || undefined);
    setData(await mcpApi.getServer(id));
  });

  // 설정 폼
  const [displayName, setDisplayName] = useState('');
  const [timeoutSec, setTimeoutSec] = useState('600');
  useEffect(() => {
    if (!server) return;
    setDisplayName(server.displayName);
    setTimeoutSec(String(Math.round(server.callTimeoutMs / 1000)));
    setHeaderName(server.auth.headerName ?? 'Authorization');
  }, [server?.id, server?.displayName, server?.callTimeoutMs, server?.auth.headerName]);

  // 삭제
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleteResult, setDeleteResult] = useState<DeleteResult | null>(null);
  const del = useAsync(async (force: boolean) => {
    const r = force ? await mcpApi.forceDeleteServer(id) : await mcpApi.deleteServer(id);
    setDeleteResult(r);
    if (r.status === 'deleted') navigate('/mcp', { replace: true });
    return r;
  });

  if (res.loading && !server) return <Loading />;
  if (res.error && !server) return <ErrorNotice error={res.error} onRetry={() => void res.refetch()} />;
  if (!server) return null;

  const scope = needsMoreScope(server.auth, server.status);
  const info = serverInfoSummary(server.serverInfo);
  const locked = server.status === 'deleting' || server.status === 'draft';
  const toolsLocked = locked || server.status === 'pending_approval';
  const changedCount = server.tools.filter((x) => x.changed).length;
  const pendingCount = server.tools.filter((x) => x.pendingApproval).length;
  const failedStep = deleteResult?.steps.some((s) => !s.ok) ?? false;
  const detailPath = `/mcp/servers/${encodeURIComponent(server.id)}`;

  function submitSettings(e: FormEvent) {
    e.preventDefault();
    const sec = Number(timeoutSec);
    const patch: PatchServerInput = {};
    if (displayName.trim() && displayName.trim() !== server!.displayName) patch.displayName = displayName.trim();
    if (Number.isFinite(sec) && sec * 1000 !== server!.callTimeoutMs) patch.callTimeoutMs = Math.round(sec * 1000);
    if (Object.keys(patch).length > 0) void settingsPatch.run(patch);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{server.displayName}</h1>
          <p className="mono small muted">{server.id}</p>
        </div>
        <div className="badges">
          <StatusBadge status={server.status} scopeStepUp={scope} />
          {server.presetId && <Badge tone="info">{t.fromPreset(server.presetId)}</Badge>}
        </div>
      </div>
      {server.url && (
        <p className="small">
          <span className="muted">{t.url}: </span>
          <span className="mono wrap">{server.url}</span>
        </p>
      )}
      {server.warnings.length > 0 && (
        <Notice tone="warn">
          <strong>{t.warnings}</strong>
          <ul className="plain">
            {server.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}
      {server.status === 'pending_approval' && (
        <Notice tone="info">
          {t.pendingBanner}{' '}
          <Link to={`/mcp/add?server=${encodeURIComponent(server.id)}`}>{t.reviewPending}</Link>
        </Notice>
      )}
      {(server.status === 'changed' || changedCount > 0) && (
        <Notice tone="warn">
          {t.changedBanner(changedCount)} <Link to={`${detailPath}/changes`}>{t.reviewChanges}</Link>
        </Notice>
      )}
      {server.status === 'needs_auth' && <Notice tone="warn">{scope ? t.scopeBanner : t.needsAuthBanner}</Notice>}
      {server.status === 'error' && (
        <Notice tone="danger">
          {t.errorBanner}
          {server.lastError && (
            <p className="small">
              {t.lastError}: {server.lastError}
            </p>
          )}
        </Notice>
      )}
      {server.status === 'deleting' && <Notice tone="danger">{t.deletingBanner}</Notice>}
      {server.status === 'disabled' && <Notice tone="muted">{t.disabledBanner}</Notice>}
      {server.status !== 'error' && server.lastError && (
        <p className="small danger-text">
          {t.lastError}: {server.lastError}
        </p>
      )}

      <Section
        title={`${t.tools} (${server.tools.length})`}
        id="tools"
        actions={
          (changedCount > 0 || pendingCount > 0) && server.status !== 'pending_approval' ? (
            <Link className="btn btn-ghost" to={`${detailPath}/changes`}>
              {t.reviewChanges}
            </Link>
          ) : undefined
        }
      >
        <ErrorNotice error={toolPatch.error} />
        {server.tools.length === 0 && <p className="empty">{t.toolsEmpty}</p>}
        <ul className="tool-list">
          {server.tools.map((tool) => (
            <li key={tool.name} className={`tool-item${tool.annotations?.destructiveHint ? ' tool-destructive' : ''}`}>
              <div className="tool-row">
                <div className="tool-head">
                  <span className="mono tool-name">{tool.name}</span>
                  {tool.title && <span className="muted"> — {tool.title}</span>}
                </div>
                <Switch
                  label={t.toolEnabled}
                  hideLabel
                  checked={tool.enabled}
                  disabled={toolsLocked || busyTool === tool.name}
                  onChange={(next) => {
                    setBusyTool(tool.name);
                    void toolPatch.run({ tools: [{ name: tool.name, enabled: next }] }).finally(() => setBusyTool(null));
                  }}
                />
              </div>
              <div className="tool-meta">
                {tool.changed && <Badge tone="warn">{t.toolChanged}</Badge>}
                {tool.pendingApproval && <Badge tone="info">{t.toolPending}</Badge>}
                <ToolAnnotationChips annotations={tool.annotations} />
              </div>
              {tool.description && <p className="tool-desc">{tool.description}</p>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t.connection} id="connection">
        <KeyValue
          rows={[
            [t.transport, transportLabels[server.transport]],
            [t.era, server.protocol.era ? eraLabels[server.protocol.era] : app.unknown],
            [t.protocolVersion, server.protocol.version ?? '—'],
            [t.serverInfo, info.name ? `${info.name}${info.version ? ` ${info.version}` : ''}` : '—'],
            [t.canonicalUrl, server.canonicalUrl ? <span className="mono wrap">{server.canonicalUrl}</span> : '—'],
            [t.lastProbeAt, formatDateTime(server.lastProbeAt)],
            [t.toolsSyncedAt, formatDateTime(server.toolsSyncedAt)],
          ]}
        />
        <ErrorNotice error={test.error} />
        <ErrorNotice error={probe.error} />
        {test.result && (
          <Notice tone={test.result.ok ? 'ok' : 'danger'}>
            {test.result.ok ? t.testOk(test.result.latencyMs) : `${t.testFailed}${test.result.error ? `: ${test.result.error}` : ''}`}
          </Notice>
        )}
        <ButtonRow>
          <button type="button" className="btn" disabled={test.pending || locked} onClick={() => void test.run()}>
            {test.pending ? t.testing : t.testConnection}
          </button>
          <button type="button" className="btn" disabled={probe.pending || locked} onClick={() => void probe.run()}>
            {probe.pending ? t.probing : t.probe}
          </button>
        </ButtonRow>
      </Section>

      <Section title={t.auth} id="auth">
        <KeyValue
          rows={[
            [t.authType, authTypeLabels[server.auth.type]],
            ...(server.auth.type === 'header' ? ([[t.headerName, server.auth.headerName ?? '—']] as Array<[string, string]>) : []),
            ...(server.auth.issuer ? ([[t.issuer, <span className="mono wrap">{server.auth.issuer}</span>]] as Array<[string, ReactNode]>) : []),
            ...(server.auth.clientMode ? ([[t.clientMode, clientModeLabels[server.auth.clientMode]]] as Array<[string, string]>) : []),
            ...(server.auth.requestedScope ? ([[t.requestedScope, <span className="mono wrap">{server.auth.requestedScope}</span>]] as Array<[string, ReactNode]>) : []),
            ...(server.auth.grantedScope ? ([[t.grantedScope, <span className="mono wrap">{server.auth.grantedScope}</span>]] as Array<[string, ReactNode]>) : []),
            ...(server.auth.type === 'oauth' ? ([[t.expiresAt, formatDateTime(server.auth.expiresAt)]] as Array<[string, string]>) : []),
          ]}
        />
        {server.auth.type === 'oauth' && server.auth.needsClientInput && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void saveClient.run();
            }}
          >
            <Field label="client_id" htmlFor="detail-client-id">
              <input id="detail-client-id" type="text" autoComplete="off" required value={clientId} onChange={(e) => setClientId(e.target.value)} />
            </Field>
            <Field label="client_secret (선택)" htmlFor="detail-client-secret">
              <input id="detail-client-secret" type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
            </Field>
            <ErrorNotice error={saveClient.error} />
            <ButtonRow>
              <button type="submit" className="btn btn-primary" disabled={saveClient.pending || !clientId.trim()}>
                {app.save}
              </button>
            </ButtonRow>
          </form>
        )}
        <ErrorNotice error={login.error} />
        <ButtonRow>
          {server.auth.type === 'oauth' && (
            <button type="button" className="btn btn-primary" disabled={login.pending || locked || server.auth.needsClientInput} onClick={() => void login.run()}>
              {t.relogin}
            </button>
          )}
          {(server.auth.type === 'header' || server.auth.type === 'none') && !keyFormOpen && (
            <button type="button" className="btn" disabled={locked} onClick={() => setKeyFormOpen(true)}>
              {t.changeKey}
            </button>
          )}
        </ButtonRow>
        {keyFormOpen && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void saveKey.run();
            }}
          >
            <Field label={t.headerName} htmlFor="detail-header-name">
              <input id="detail-header-name" type="text" autoComplete="off" required pattern="[A-Za-z0-9-]{1,64}" value={headerName} onChange={(e) => setHeaderName(e.target.value)} />
            </Field>
            <Field label="키 값" htmlFor="detail-header-value">
              <input id="detail-header-value" type="password" autoComplete="off" required value={headerValue} onChange={(e) => setHeaderValue(e.target.value)} />
            </Field>
            <ErrorNotice error={saveKey.error} />
            <ButtonRow>
              <button type="submit" className="btn btn-primary" disabled={saveKey.pending || !headerValue}>
                {app.save}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setKeyFormOpen(false)}>
                {app.cancel}
              </button>
            </ButtonRow>
          </form>
        )}
      </Section>

      <Section
        title={t.bindings}
        id="bindings"
        actions={
          <button type="button" className="btn btn-ghost" disabled={resync.pending || locked} onClick={() => void resync.run()}>
            {resync.pending ? app.loading : t.resync}
          </button>
        }
      >
        <p className="small muted">{t.bindingsHelp}</p>
        <ErrorNotice error={bindingPatch.error} />
        <ErrorNotice error={resync.error} />
        <AgentToggles
          bindings={server.bindings}
          showDetails
          disabled={locked || server.status === 'pending_approval'}
          busyAgent={busyAgent}
          onToggle={(agent, enabled) => {
            setBusyAgent(agent);
            void bindingPatch.run({ bindings: { [agent]: enabled } }).finally(() => setBusyAgent(null));
          }}
        />
      </Section>

      <Section title={t.settings} id="settings">
        <ErrorNotice error={settingsPatch.error} />
        <div className="stack">
          <Switch
            label={t.enabled}
            description={t.enabledHelp}
            checked={server.status !== 'disabled'}
            disabled={settingsPatch.pending || locked || server.status === 'pending_approval' || server.status === 'needs_auth'}
            onChange={(next) => void settingsPatch.run({ enabled: next })}
          />
          <p className="hint">{t.enabledHelp}</p>
          <Switch
            label={t.cliAutoApprove}
            description={t.cliAutoApproveHelp}
            checked={server.cliAutoApprove}
            disabled={settingsPatch.pending || locked}
            onChange={(next) => void settingsPatch.run({ cliAutoApprove: next })}
          />
          <p className="hint">{t.cliAutoApproveHelp}</p>
        </div>
        <form className="stack" onSubmit={submitSettings}>
          <Field label={t.displayName} htmlFor="detail-display-name">
            <input id="detail-display-name" type="text" maxLength={80} required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label={t.callTimeout} hint={t.callTimeoutHelp} htmlFor="detail-timeout">
            <input id="detail-timeout" type="number" inputMode="numeric" min={5} max={3600} step={1} required value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} />
          </Field>
          <ButtonRow>
            <button type="submit" className="btn" disabled={settingsPatch.pending || locked}>
              {app.save}
            </button>
          </ButtonRow>
        </form>
      </Section>

      <Section title={t.events} id="events">
        {server.recentEvents.length === 0 && <p className="empty">{t.eventsEmpty}</p>}
        <ul className="event-list">
          {server.recentEvents.map((ev) => (
            <EventRow key={ev.id} ev={ev} />
          ))}
        </ul>
      </Section>

      <Section title={t.danger} id="danger">
        <ButtonRow>
          <button type="button" className="btn btn-danger" onClick={() => setDeleteOpen(true)}>
            {t.deleteButton}
          </button>
        </ButtonRow>
      </Section>

      <Dialog
        open={deleteOpen}
        title={t.deleteTitle}
        onClose={() => {
          if (!del.pending) {
            setDeleteOpen(false);
            setConfirmText('');
          }
        }}
      >
        <p>{t.deleteIntro(server.id)}</p>
        <Field label={t.deleteInputLabel} htmlFor="delete-confirm">
          <input id="delete-confirm" type="text" autoComplete="off" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
        </Field>
        <ErrorNotice error={del.error} />
        {deleteResult && (
          <div className="stack">
            <h3>{t.deleteSteps}</h3>
            <ul className="plain steps-list">
              {deleteResult.steps.map((s) => (
                <li key={s.step}>
                  <Badge tone={s.ok ? 'ok' : 'danger'}>{s.ok ? 'OK' : '실패'}</Badge> {t.deleteStepLabels[s.step] ?? s.step}
                  {s.error && <span className="small danger-text"> — {s.error}</span>}
                </li>
              ))}
            </ul>
            {failedStep && <Notice tone="warn">{t.forceDeleteWarning}</Notice>}
          </div>
        )}
        <ButtonRow>
          {!deleteResult || failedStep ? (
            <button type="button" className="btn btn-danger" disabled={del.pending || confirmText !== server.id} onClick={() => void del.run(false)}>
              {del.pending ? t.deleting : deleteResult ? t.deleteRetry : t.deleteConfirm}
            </button>
          ) : null}
          {failedStep && (
            <button type="button" className="btn btn-danger" disabled={del.pending} onClick={() => void del.run(true)}>
              {t.forceDelete}
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            disabled={del.pending}
            onClick={() => {
              setDeleteOpen(false);
              setConfirmText('');
            }}
          >
            {app.close}
          </button>
        </ButtonRow>
      </Dialog>
    </>
  );
}

function EventRow({ ev }: { ev: EventRecord }) {
  let details: string | null = null;
  if (ev.details_json) {
    try {
      details = truncate(prettyJson(JSON.parse(ev.details_json)), 240);
    } catch {
      details = truncate(ev.details_json, 240);
    }
  }
  return (
    <li className="event-item">
      <div className="event-head">
        <span>{eventKindLabels[ev.kind] ?? ev.kind}</span>
        <span className="small muted">
          {formatDateTime(ev.ts)} · {ev.actor}
          {ev.agent && <> · {agentLabels[ev.agent]}</>}
        </span>
      </div>
      {details && <pre className="json small">{details}</pre>}
    </li>
  );
}
