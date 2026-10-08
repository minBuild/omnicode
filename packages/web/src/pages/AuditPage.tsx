import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Agent, AuditEntry } from '@omnicode/shared';
import { mcpApi } from '../api/mcp';
import { useAsync, useResource } from '../api/hooks';
import { agentLabels, audit as t, outcomeLabels } from '../i18n/ko';
import { ALL_AGENTS } from '../lib/status';
import { formatDateTime, formatDuration } from '../lib/format';
import { Badge, ErrorNotice, Loading } from '../components/ui';

type Outcome = AuditEntry['outcome'];
const PAGE = 50;

export function AuditPage() {
  const [serverId, setServerId] = useState('');
  const [agent, setAgent] = useState<'' | Agent>('');
  const [outcome, setOutcome] = useState<'' | Outcome>('');
  const servers = useResource((signal) => mcpApi.listServers(signal), []);

  const query = {
    ...(serverId ? { serverId } : {}),
    ...(agent ? { agent } : {}),
    ...(outcome ? { outcome } : {}),
    limit: PAGE,
  };
  const first = useResource((signal) => mcpApi.audit(query, signal), [serverId, agent, outcome]);
  const [extra, setExtra] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);

  useEffect(() => {
    setExtra([]);
    setCursor(first.data?.nextCursor ?? null);
  }, [first.data]);

  const more = useAsync(async () => {
    if (cursor === null) return;
    const page = await mcpApi.audit({ ...query, cursor });
    setExtra((prev) => [...prev, ...page.items]);
    setCursor(page.nextCursor);
  });

  const items = [...(first.data?.items ?? []), ...extra];

  return (
    <>
      <div className="page-head">
        <h1>{t.heading}</h1>
      </div>

      <form className="filters" onSubmit={(e) => e.preventDefault()} aria-label="필터">
        <label>
          {t.filterServer}
          <select value={serverId} onChange={(e) => setServerId(e.target.value)}>
            <option value="">{t.all}</option>
            {servers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName} ({s.id})
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.filterAgent}
          <select value={agent} onChange={(e) => setAgent(e.target.value as '' | Agent)}>
            <option value="">{t.all}</option>
            {ALL_AGENTS.map((a) => (
              <option key={a} value={a}>
                {agentLabels[a]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.filterOutcome}
          <select value={outcome} onChange={(e) => setOutcome(e.target.value as '' | Outcome)}>
            <option value="">{t.all}</option>
            {(Object.keys(outcomeLabels) as Outcome[]).map((o) => (
              <option key={o} value={o}>
                {outcomeLabels[o]}
              </option>
            ))}
          </select>
        </label>
      </form>

      {first.loading && !first.data && <Loading />}
      <ErrorNotice error={first.error} onRetry={() => void first.refetch()} />

      {first.data && items.length === 0 && <p className="empty">{t.empty}</p>}

      {items.length > 0 && (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">{t.cols.time}</th>
              <th scope="col">{t.cols.agent}</th>
              <th scope="col">{t.cols.jobId}</th>
              <th scope="col">{t.cols.server}</th>
              <th scope="col">{t.cols.tool}</th>
              <th scope="col">{t.cols.outcome}</th>
              <th scope="col">{t.cols.duration}</th>
              <th scope="col">{t.cols.error}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id}>
                <td data-label={t.cols.time}>{formatDateTime(e.ts)}</td>
                <td data-label={t.cols.agent}>{agentLabels[e.agent]}</td>
                <td data-label={t.cols.jobId} className="mono">
                  {e.job_id ?? '—'}
                </td>
                <td data-label={t.cols.server}>
                  <Link to={`/mcp/servers/${encodeURIComponent(e.server_id)}`}>{e.server_id}</Link>
                </td>
                <td data-label={t.cols.tool} className="mono">
                  {e.tool ?? e.method}
                </td>
                <td data-label={t.cols.outcome}>
                  <Badge tone={e.outcome === 'ok' ? 'ok' : e.outcome === 'blocked' ? 'warn' : 'danger'}>{outcomeLabels[e.outcome]}</Badge>
                </td>
                <td data-label={t.cols.duration}>{formatDuration(e.duration_ms)}</td>
                <td data-label={t.cols.error} className="small">
                  {e.error ?? (e.error_code !== null ? String(e.error_code) : '—')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ErrorNotice error={more.error} />
      {cursor !== null && (
        <div className="btn-row">
          <button type="button" className="btn" disabled={more.pending} onClick={() => void more.run()}>
            {more.pending ? t.loadingMore : t.more}
          </button>
        </div>
      )}
    </>
  );
}
