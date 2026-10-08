import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Agent, ServerSummary } from '@omnicode/shared';
import { mcpApi } from '../api/mcp';
import { useResource } from '../api/hooks';
import { app, list as t } from '../i18n/ko';
import { extraBadgeLabels, summaryStatusLabel } from '../lib/status';
import { formatRelative } from '../lib/format';
import { AgentToggles } from '../components/AgentToggles';
import { StatusBadge } from '../components/StatusBadge';
import { Badge, ErrorNotice, Loading, Notice } from '../components/ui';

export function ServerListPage() {
  const servers = useResource((signal) => mcpApi.listServers(signal), []);
  const hub = useResource((signal) => mcpApi.hubStatus(signal), []);
  const [busy, setBusy] = useState<{ id: string; agent: Agent } | null>(null);
  const [toggleError, setToggleError] = useState<unknown>(undefined);

  async function toggle(server: ServerSummary, agent: Agent, enabled: boolean) {
    setBusy({ id: server.id, agent });
    setToggleError(undefined);
    try {
      const updated = await mcpApi.patchServer(server.id, { bindings: { [agent]: enabled } });
      servers.setData((prev) => prev?.map((s) => (s.id === server.id ? updated : s)));
    } catch (e: unknown) {
      setToggleError(e);
    } finally {
      setBusy(null);
    }
  }

  const privateHosts = hub.data?.allowPrivateHosts ?? [];

  return (
    <>
      <div className="page-head">
        <h1>{t.heading}</h1>
        <Link to="/mcp/add" className="btn btn-primary">
          {t.add}
        </Link>
      </div>

      {privateHosts.length > 0 && (
        <Notice tone="warn">
          <strong>{t.privateHostsBanner}</strong>
          <p className="small">{t.privateHostsDetail(privateHosts)}</p>
        </Notice>
      )}

      <p className="links-row">
        <Link to="/mcp/hub">{t.hubLink}</Link>
        <Link to="/mcp/audit">{t.auditLink}</Link>
      </p>

      <ErrorNotice error={toggleError} />
      {servers.loading && !servers.data && <Loading />}
      <ErrorNotice error={servers.error} onRetry={() => void servers.refetch()} />

      {servers.data && servers.data.length === 0 && <p className="empty">{t.empty}</p>}

      <ul className="card-list">
        {servers.data?.map((s) => {
          const extras = extraBadgeLabels(s.badges);
          const togglesDisabled = s.status === 'deleting' || s.status === 'draft';
          return (
            <li key={s.id} className="card server-card">
              <div className="server-card-head">
                <div>
                  <h2 className="server-name">
                    <Link to={`/mcp/servers/${encodeURIComponent(s.id)}`}>{s.displayName}</Link>
                  </h2>
                  <p className="mono small muted">{s.id}</p>
                </div>
                <div className="badges">
                  <StatusBadge status={s.status} label={summaryStatusLabel(s)} />
                  {extras.map((b) => (
                    <Badge key={b} tone="info">
                      {b}
                    </Badge>
                  ))}
                </div>
              </div>

              <p className="small muted">
                {s.approvedToolCount !== s.toolCount ? t.approvedToolCount(s.approvedToolCount, s.toolCount) : t.toolCount(s.toolCount)}
                {s.changedToolCount > 0 && <> · {t.changedToolCount(s.changedToolCount)}</>}
                {' · '}
                {t.updatedAt} {formatRelative(s.updatedAt)}
              </p>
              {s.lastError && (
                <p className="small danger-text">
                  {t.lastError}: {s.lastError}
                </p>
              )}

              <fieldset className="agent-fieldset">
                <legend className="sr-only">
                  {s.displayName} {t.agentsLegend}
                </legend>
                <AgentToggles
                  bindings={s.bindings}
                  disabled={togglesDisabled}
                  busyAgent={busy?.id === s.id ? busy.agent : null}
                  onToggle={(agent, enabled) => void toggle(s, agent, enabled)}
                />
              </fieldset>
              {s.status === 'pending_approval' && (
                <p className="small">
                  <Link to={`/mcp/add?server=${encodeURIComponent(s.id)}`}>{app.confirm} · 도구 검토·승인</Link>
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
