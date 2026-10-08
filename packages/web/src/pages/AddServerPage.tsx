import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Agent, ApproveResult, PresetView, ServerDetail, SyncOutcome } from '@omnicode/shared';
import { mcpApi, type CreateServerInput } from '../api/mcp';
import { useAsync, useResource } from '../api/hooks';
import { isApiClientError } from '../api/client';
import { add as t, app, agentLabels, authTypeLabels, clientModeLabels, eraLabels, transportLabels, detail as dt } from '../i18n/ko';
import { ALL_AGENTS, defaultAgentSelection, defaultToolSelection, isDestructive, isHttpsUrl, isValidServerId, needsMoreScope } from '../lib/status';
import { StatusBadge } from '../components/StatusBadge';
import { SyncResults } from '../components/SyncResults';
import { ToolAnnotationChips } from '../components/ToolAnnotationChips';
import { Badge, ButtonRow, ErrorNotice, Field, Loading, Notice, Section, Tabs } from '../components/ui';

type Step = 'input' | 'probe' | 'auth' | 'review' | 'done';

const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'input', label: '입력' },
  { key: 'probe', label: t.stepProbe },
  { key: 'auth', label: t.stepAuth },
  { key: 'review', label: t.stepReview },
  { key: 'done', label: t.stepDone },
];

export function stepFor(server: ServerDetail): Step {
  switch (server.status) {
    case 'needs_auth':
      return 'auth';
    case 'pending_approval':
      return 'review';
    case 'draft':
    case 'error':
      return 'probe';
    default:
      return 'done';
  }
}

export function AddServerPage() {
  const [params, setParams] = useSearchParams();
  const serverParam = params.get('server');
  const [tab, setTab] = useState('url');
  const [server, setServer] = useState<ServerDetail | null>(null);
  const [preset, setPreset] = useState<PresetView | null>(null);
  const [approveResult, setApproveResult] = useState<ApproveResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(undefined);
  const [loadingServer, setLoadingServer] = useState(false);

  // ?server=<id> — OAuth 리다이렉트 뒤나 목록에서 이어서 하기
  useEffect(() => {
    if (!serverParam || server?.id === serverParam) return;
    let cancelled = false;
    setLoadingServer(true);
    setLoadError(undefined);
    mcpApi
      .getServer(serverParam)
      .then((d) => {
        if (!cancelled) setServer(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e);
      })
      .finally(() => {
        if (!cancelled) setLoadingServer(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverParam, server?.id]);

  const create = useAsync(async (input: CreateServerInput, p: PresetView | null) => {
    const d = await mcpApi.createServer(input);
    setPreset(p);
    setServer(d);
    setNotice(null);
    setParams({ server: d.id }, { replace: true });
    return d;
  });

  const probe = useAsync(async (id: string) => {
    const d = await mcpApi.probe(id);
    setServer(d);
    return d;
  });

  async function reloadServer(id: string) {
    const d = await mcpApi.getServer(id);
    setServer(d);
    return d;
  }

  const step: Step = create.pending ? 'probe' : approveResult ? 'done' : server ? stepFor(server) : 'input';

  return (
    <>
      <div className="page-head">
        <h1>{t.heading}</h1>
        <Link to="/mcp" className="btn btn-ghost">
          {app.goToList}
        </Link>
      </div>

      <ol className="steps" aria-label="진행 단계">
        {STEPS.map((s, i) => (
          <li key={s.key} className={s.key === step ? 'step-current' : STEPS.findIndex((x) => x.key === step) > i ? 'step-done' : undefined} aria-current={s.key === step ? 'step' : undefined}>
            {s.label}
          </li>
        ))}
      </ol>

      {loadingServer && <Loading />}
      <ErrorNotice error={loadError} />
      {notice && <Notice tone="warn">{notice}</Notice>}
      {server && serverParam && !create.result && <p className="muted small">{t.continueFrom(server.displayName)}</p>}

      {step === 'input' && (
        <InputStep
          tab={tab}
          onTab={setTab}
          pending={create.pending}
          error={create.error}
          onCreate={(input, p) => void create.run(input, p)}
        />
      )}

      {step === 'probe' && create.pending && <Loading label={t.probing} />}

      {server && step !== 'input' && !create.pending && <ServerSummary server={server} />}

      {step === 'probe' && server && !create.pending && (
        <Section title={t.stepProbe}>
          <Notice tone="danger">{server.status === 'error' ? t.statusError : t.statusDraft}</Notice>
          {server.lastError && <p className="small danger-text">{server.lastError}</p>}
          <ErrorNotice error={probe.error} />
          <ButtonRow>
            <button type="button" className="btn btn-primary" disabled={probe.pending} onClick={() => void probe.run(server.id)}>
              {probe.pending ? dt.probing : t.reprobe}
            </button>
            <Link className="btn" to={`/mcp/servers/${encodeURIComponent(server.id)}`}>
              {t.goDetail}
            </Link>
          </ButtonRow>
        </Section>
      )}

      {step === 'auth' && server && (
        <AuthStep server={server} preset={preset} onUpdated={setServer} />
      )}

      {step === 'review' && server && (
        <ReviewStep
          key={server.toolsSyncedAt ?? server.tools.map((x) => x.schemaHash).join(',')}
          server={server}
          preset={preset}
          onApproved={(r) => setApproveResult(r)}
          onStale={async () => {
            await reloadServer(server.id);
            setNotice(t.staleTools);
          }}
        />
      )}

      {step === 'done' && server && <DoneStep server={server} result={approveResult} />}
    </>
  );
}

function InputStep({
  tab,
  onTab,
  pending,
  error,
  onCreate,
}: {
  tab: string;
  onTab: (k: string) => void;
  pending: boolean;
  error: unknown;
  onCreate: (input: CreateServerInput, preset: PresetView | null) => void;
}) {
  const [url, setUrl] = useState('');
  const [id, setId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const presets = useResource((signal) => mcpApi.presets(signal), []);

  function submitUrl(e: FormEvent) {
    e.preventDefault();
    const u = url.trim();
    if (!isHttpsUrl(u)) {
      setFormError(t.urlHelp);
      return;
    }
    if (id && !isValidServerId(id)) {
      setFormError(t.idHelp);
      return;
    }
    setFormError(null);
    onCreate({ source: 'url', url: u, ...(id ? { id } : {}), ...(displayName.trim() ? { displayName: displayName.trim() } : {}) }, null);
  }

  return (
    <>
      <Tabs
        ariaLabel="추가 경로"
        active={tab}
        onChange={onTab}
        items={[
          { key: 'url', label: t.tabs.url },
          { key: 'preset', label: t.tabs.preset },
          { key: 'json', label: t.tabs.json, disabled: true, note: t.jsonPhase },
          { key: 'search', label: t.tabs.search, disabled: true, note: t.searchPhase },
        ]}
      />
      <p className="small muted">
        {t.jsonPhase} {t.searchPhase}
      </p>
      <ErrorNotice error={error} />

      {tab === 'url' && (
        <form className="card" onSubmit={submitUrl} aria-label={t.tabs.url}>
          <Field label={t.urlLabel} hint={t.urlHelp} htmlFor="add-url">
            <input id="add-url" type="url" inputMode="url" autoComplete="off" required placeholder={t.urlPlaceholder} value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field label={t.idLabel} hint={t.idHelp} htmlFor="add-id">
            <input id="add-id" type="text" autoComplete="off" pattern="[a-z0-9-]{1,40}" value={id} onChange={(e) => setId(e.target.value)} />
          </Field>
          <Field label={t.displayNameLabel} htmlFor="add-name">
            <input id="add-name" type="text" autoComplete="off" maxLength={80} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          {formError && (
            <p className="danger-text small" role="alert">
              {formError}
            </p>
          )}
          <ButtonRow>
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending ? t.probing : t.submitUrl}
            </button>
          </ButtonRow>
        </form>
      )}

      {tab === 'preset' && (
        <div>
          {presets.loading && <Loading label={t.presetsLoading} />}
          <ErrorNotice error={presets.error} onRetry={() => void presets.refetch()} />
          {presets.data && presets.data.length === 0 && <p className="empty">{t.presetsEmpty}</p>}
          <ul className="card-list">
            {presets.data?.map((p) => (
              <li key={p.id} className="card">
                <h2 className="server-name">{p.displayName}</h2>
                <p className="mono small muted">{p.id}</p>
                {p.description && <p>{p.description}</p>}
                <p className="mono small wrap">{p.url}</p>
                <p className="small muted">
                  {t.presetAuth}: {authTypeLabels[p.auth.type]}
                  {p.auth.headerName && <> ({p.auth.headerName})</>}
                  {' · '}
                  {transportLabels[p.transport]}
                  {p.defaultAgents && p.defaultAgents.length > 0 && (
                    <>
                      {' · '}
                      {t.presetDefaultAgents}: {p.defaultAgents.map((a) => agentLabels[a]).join(', ')}
                    </>
                  )}
                </p>
                <ButtonRow>
                  {p.docs && isHttpsUrl(p.docs) && (
                    <a className="btn btn-ghost" href={p.docs} target="_blank" rel="noopener noreferrer">
                      {t.presetDocs}
                    </a>
                  )}
                  <button type="button" className="btn btn-primary" disabled={pending} onClick={() => onCreate({ source: 'preset', presetId: p.id }, p)}>
                    {pending ? t.probing : t.presetUse}
                  </button>
                </ButtonRow>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function ServerSummary({ server }: { server: ServerDetail }) {
  const scope = needsMoreScope(server.auth, server.status);
  return (
    <section className="card" aria-label="서버 정보">
      <div className="server-card-head">
        <div>
          <h2 className="server-name">{server.displayName}</h2>
          <p className="mono small muted">{server.id}</p>
        </div>
        <StatusBadge status={server.status} scopeStepUp={scope} />
      </div>
      {server.url && <p className="mono small wrap">{server.url}</p>}
      <p className="small muted">
        {t.era}: {server.protocol.era ? eraLabels[server.protocol.era] : app.unknown}
        {' · '}
        {t.transport}: {transportLabels[server.transport]}
        {server.protocol.version && (
          <>
            {' · '}
            {t.protocolVersion}: {server.protocol.version}
          </>
        )}
      </p>
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
    </section>
  );
}

export function startOAuthLogin(id: string, assign: (url: string) => void = (u) => window.location.assign(u)) {
  return async () => {
    const r = await mcpApi.startOAuth(id);
    // 16.3: 서버가 검증했더라도 화면이 스킴을 다시 확인한 뒤 window.location으로만 이동한다.
    if (!isHttpsUrl(r.authorizationUrl)) throw new Error(t.loginUrlRejected);
    assign(r.authorizationUrl);
    return r;
  };
}

export function AuthStep({ server, preset, onUpdated }: { server: ServerDetail; preset: PresetView | null; onUpdated: (d: ServerDetail) => void }) {
  const auth = server.auth;
  const showOAuth = auth.type === 'oauth' || auth.issuer !== null;
  const showHeader = auth.type === 'header' || (auth.type === 'none' && !showOAuth);
  const scope = needsMoreScope(auth, server.status);

  const login = useAsync(startOAuthLogin(server.id));
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const saveClient = useAsync(async () => {
    await mcpApi.setOAuthClient(server.id, clientId.trim(), clientSecret.trim() || undefined);
    onUpdated(await mcpApi.getServer(server.id));
  });

  const [headerName, setHeaderName] = useState(auth.headerName ?? preset?.auth.headerName ?? 'Authorization');
  const [headerValue, setHeaderValue] = useState('');
  const saveKey = useAsync(async () => {
    await mcpApi.putCredentials(server.id, headerName.trim(), headerValue);
    setHeaderValue('');
    onUpdated(await mcpApi.probe(server.id));
  });

  return (
    <Section title={t.needsAuthTitle}>
      {scope && <Notice tone="warn">{dt.scopeBanner}</Notice>}
      {showOAuth && (
        <div className="stack">
          <p>{t.needsAuthOauth}</p>
          <p className="small muted">
            {auth.issuer && (
              <>
                {dt.issuer}: <span className="mono">{auth.issuer}</span>
              </>
            )}
            {auth.clientMode && <> · {clientModeLabels[auth.clientMode]}</>}
            {auth.requestedScope && (
              <>
                {' · '}
                scope: <span className="mono">{auth.requestedScope}</span>
              </>
            )}
          </p>
          {auth.needsClientInput ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveClient.run();
              }}
            >
              <Notice tone="info">{t.needsClientInput}</Notice>
              <Field label={t.clientIdLabel} htmlFor="oauth-client-id">
                <input id="oauth-client-id" type="text" autoComplete="off" required value={clientId} onChange={(e) => setClientId(e.target.value)} />
              </Field>
              <Field label={t.clientSecretLabel} htmlFor="oauth-client-secret">
                <input id="oauth-client-secret" type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
              </Field>
              <ErrorNotice error={saveClient.error} />
              <ButtonRow>
                <button type="submit" className="btn btn-primary" disabled={saveClient.pending || !clientId.trim()}>
                  {t.saveClient}
                </button>
              </ButtonRow>
            </form>
          ) : (
            <>
              <ErrorNotice error={login.error} />
              <ButtonRow>
                <button type="button" className="btn btn-primary" disabled={login.pending} onClick={() => void login.run()}>
                  {login.pending ? t.loginStarting : t.login(server.displayName)}
                </button>
              </ButtonRow>
              <p className="small muted">{t.afterAuthHint}</p>
            </>
          )}
        </div>
      )}
      {showHeader && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void saveKey.run();
          }}
        >
          <p>{t.needsAuthHeader}</p>
          <Field label={t.headerNameLabel} htmlFor="cred-header">
            <input id="cred-header" type="text" autoComplete="off" required pattern="[A-Za-z0-9-]{1,64}" value={headerName} onChange={(e) => setHeaderName(e.target.value)} />
          </Field>
          <Field label={t.headerValueLabel} htmlFor="cred-value">
            <input id="cred-value" type="password" autoComplete="off" required value={headerValue} onChange={(e) => setHeaderValue(e.target.value)} />
          </Field>
          <ErrorNotice error={saveKey.error} />
          <ButtonRow>
            <button type="submit" className="btn btn-primary" disabled={saveKey.pending || !headerValue || !headerName.trim()}>
              {saveKey.pending ? t.probing : t.saveCredentials}
            </button>
          </ButtonRow>
        </form>
      )}
    </Section>
  );
}

function ReviewStep({
  server,
  preset,
  onApproved,
  onStale,
}: {
  server: ServerDetail;
  preset: PresetView | null;
  onApproved: (r: ApproveResult) => void;
  onStale: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>(() => defaultToolSelection(server.tools));
  const [agents, setAgents] = useState<Record<Agent, boolean>>(() => defaultAgentSelection(preset?.defaultAgents, server.bindings));
  const anyAgent = ALL_AGENTS.some((a) => agents[a]);

  const approve = useAsync(async () => {
    try {
      const r = await mcpApi.approve(server.id, {
        tools: server.tools.map((tool) => ({ name: tool.name, schemaHash: tool.schemaHash, enabled: selected[tool.name] === true })),
        bindings: { claude: agents.claude, codex: agents.codex, gemini: agents.gemini },
      });
      onApproved(r);
      return r;
    } catch (e: unknown) {
      if (isApiClientError(e) && e.code === 'stale_tool_hash') {
        await onStale();
        return undefined;
      }
      throw e;
    }
  });

  function setAll(v: boolean) {
    const next: Record<string, boolean> = {};
    for (const tool of server.tools) next[tool.name] = v;
    setSelected(next);
  }

  const selectedCount = server.tools.filter((x) => selected[x.name]).length;

  return (
    <>
      <Section
        title={t.stepReview}
        actions={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setAll(true)}>
              {t.selectAll}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setAll(false)}>
              {t.selectNone}
            </button>
          </>
        }
      >
        <p className="small muted">{t.reviewIntro}</p>
        {server.tools.length === 0 && <p className="empty">{t.noTools}</p>}
        <ul className="tool-list">
          {server.tools.map((tool) => {
            const destructive = isDestructive(tool.annotations);
            return (
              <li key={tool.name} className={`tool-item${destructive ? ' tool-destructive' : ''}`}>
                <label className="check tool-check">
                  <input type="checkbox" checked={selected[tool.name] === true} onChange={(e) => setSelected((prev) => ({ ...prev, [tool.name]: e.target.checked }))} />
                  <span className="tool-head">
                    <span className="mono tool-name">{tool.name}</span>
                    {tool.title && <span className="muted"> — {tool.title}</span>}
                  </span>
                </label>
                <div className="tool-meta">
                  {destructive && <Badge tone="danger">{t.destructiveFlag}</Badge>}
                  <ToolAnnotationChips annotations={tool.annotations} />
                </div>
                {tool.description && <p className="tool-desc">{tool.description}</p>}
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title={t.agentsTitle}>
        <fieldset className="checks">
          <legend className="sr-only">{t.agentsTitle}</legend>
          {ALL_AGENTS.map((a) => (
            <label key={a} className="check">
              <input type="checkbox" checked={agents[a]} onChange={(e) => setAgents((prev) => ({ ...prev, [a]: e.target.checked }))} />
              {agentLabels[a]}
            </label>
          ))}
        </fieldset>
        {!anyAgent && <p className="hint">{t.approveNeedsAgent}</p>}
        <ErrorNotice error={approve.error} />
        <ButtonRow>
          <button type="button" className="btn btn-primary" disabled={approve.pending || !anyAgent} onClick={() => void approve.run()}>
            {approve.pending ? t.approving : `${t.approve} (${selectedCount}/${server.tools.length})`}
          </button>
        </ButtonRow>
      </Section>
    </>
  );
}

function DoneStep({ server, result }: { server: ServerDetail; result: ApproveResult | null }) {
  const [sync, setSync] = useState<Record<Agent, SyncOutcome> | null>(null);
  const retry = useAsync(async () => {
    const r = await mcpApi.syncAll();
    setSync(r);
    return r;
  });
  const shown = sync ?? result?.sync ?? null;
  const anyFailed = shown ? ALL_AGENTS.some((a) => shown[a]?.status === 'failed') : false;
  return (
    <Section title={t.doneTitle}>
      {result ? <Notice tone="ok">{t.doneApproved(result.approved.length)}</Notice> : <Notice tone="info">{t.alreadyActive}</Notice>}
      {shown && (
        <>
          <h3>{t.syncTitle}</h3>
          <SyncResults sync={shown} />
          <ErrorNotice error={retry.error} />
          {anyFailed && (
            <ButtonRow>
              <button type="button" className="btn" disabled={retry.pending} onClick={() => void retry.run()}>
                {retry.pending ? app.loading : t.retrySync}
              </button>
            </ButtonRow>
          )}
        </>
      )}
      <ButtonRow>
        <Link className="btn btn-primary" to={`/mcp/servers/${encodeURIComponent(server.id)}`}>
          {t.goDetail}
        </Link>
        <Link className="btn" to="/mcp">
          {t.goList}
        </Link>
      </ButtonRow>
    </Section>
  );
}
