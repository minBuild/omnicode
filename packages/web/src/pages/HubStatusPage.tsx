import { useState, type ReactNode } from 'react';
import type { Agent } from '@omnicode/shared';
import { mcpApi } from '../api/mcp';
import { useAsync, useResource } from '../api/hooks';
import { isApiClientError } from '../api/client';
import { agentLabels, agentLongLabels, hub as t } from '../i18n/ko';
import { ALL_AGENTS } from '../lib/status';
import { formatDateTime, formatUptime } from '../lib/format';
import { SyncResults } from '../components/SyncResults';
import { Badge, ButtonRow, ErrorNotice, KeyValue, Loading, Notice, Section } from '../components/ui';

export function HubStatusPage() {
  const status = useResource((signal) => mcpApi.hubStatus(signal), []);
  const sync = useAsync(async () => {
    const r = await mcpApi.syncAll();
    await status.refetch();
    return r;
  });
  const [rotateAgents, setRotateAgents] = useState<Record<Agent, boolean>>({ claude: true, codex: true, gemini: true });
  const rotate = useAsync(async (agents: Agent[]) => {
    const r = await mcpApi.rotateTokens(agents);
    await status.refetch();
    return r;
  });
  const selectedAgents = ALL_AGENTS.filter((a) => rotateAgents[a]);
  const reauth = isApiClientError(rotate.error) && rotate.error.code === 'reauth_required';

  const s = status.data;
  return (
    <>
      <div className="page-head">
        <h1>{t.heading}</h1>
      </div>
      {status.loading && !s && <Loading />}
      <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />
      {s && (
        <>
          <Section title="Hub" id="hub-info">
            <KeyValue
              rows={[
                [t.version, s.version],
                [t.uptime, formatUptime(s.uptimeSec)],
                [t.endpoint, <span className="mono">{`${s.hub.host}:${s.hub.port}`}</span>],
                [t.sessions, `${t.sessionsLegacy} ${s.downstreamSessions.legacy} · ${t.sessionsModern} ${s.downstreamSessions.modern}`],
                [t.privateHosts, s.allowPrivateHosts.length > 0 ? <span className="mono">{s.allowPrivateHosts.join(', ')}</span> : t.off],
                [t.httpLoopback, s.allowHttpLoopback ? t.on : t.off],
              ]}
            />
          </Section>

          <Section title={t.agentd} id="hub-agentd">
            <KeyValue
              rows={[
                ['상태', <Badge tone={s.agentd.ok ? 'ok' : 'danger'}>{s.agentd.ok ? t.agentdOk : t.agentdDown}</Badge>],
                [t.agentdVersion, s.agentd.version ?? '—'],
                ...(s.agentd.error ? ([['오류', <span className="danger-text">{s.agentd.error}</span>]] as Array<[string, ReactNode]>) : []),
              ]}
            />
            <h3>{t.cliVersions}</h3>
            <KeyValue
              rows={ALL_AGENTS.map((a) => [agentLongLabels[a], s.agentd.cli?.[a] ?? <span className="muted">{t.cliMissing}</span>])}
            />
          </Section>

          <Section
            title={t.lastSync}
            id="hub-sync"
            actions={
              <button type="button" className="btn btn-primary" disabled={sync.pending} onClick={() => void sync.run()}>
                {sync.pending ? t.resyncing : t.resyncAll}
              </button>
            }
          >
            <SyncResults sync={s.lastSync} />
            <ErrorNotice error={sync.error} />
            {sync.result && (
              <>
                <h3>{t.resyncResult}</h3>
                <SyncResults sync={sync.result} />
              </>
            )}
          </Section>

          <Section title={t.tokens} id="hub-tokens">
            <KeyValue
              rows={ALL_AGENTS.map((a) => [
                agentLongLabels[a],
                <span className="small">
                  {t.rotatedAt} {formatDateTime(s.tokens[a].rotatedAt)}
                  {s.tokens[a].graceUntil && (
                    <>
                      {' · '}
                      {t.graceUntil} {formatDateTime(s.tokens[a].graceUntil)}
                    </>
                  )}
                </span>,
              ])}
            />
            <Notice tone="warn">{t.rotateNotice}</Notice>
            <fieldset className="checks">
              <legend>{t.rotateAgents}</legend>
              {ALL_AGENTS.map((a) => (
                <label key={a} className="check">
                  <input
                    type="checkbox"
                    checked={rotateAgents[a]}
                    onChange={(e) => setRotateAgents((prev) => ({ ...prev, [a]: e.target.checked }))}
                  />
                  {agentLabels[a]}
                </label>
              ))}
            </fieldset>
            {selectedAgents.length === 0 && <p className="hint">{t.rotateNeedsAgent}</p>}
            <ButtonRow>
              <button
                type="button"
                className="btn btn-danger"
                disabled={rotate.pending || selectedAgents.length === 0}
                onClick={() => void rotate.run(selectedAgents)}
              >
                {rotate.pending ? t.rotating : t.rotate}
              </button>
            </ButtonRow>
            {reauth ? <Notice tone="danger">{t.reauthNotice}</Notice> : <ErrorNotice error={rotate.error} />}
            {rotate.result && <Notice tone="ok">{t.rotateDone(formatDateTime(rotate.result.rotatedAt), formatDateTime(rotate.result.graceUntil))}</Notice>}
          </Section>
        </>
      )}
    </>
  );
}
