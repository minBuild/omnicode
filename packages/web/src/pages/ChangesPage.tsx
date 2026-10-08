import { Link, useParams } from 'react-router-dom';
import type { ToolView } from '@omnicode/shared';
import { mcpApi } from '../api/mcp';
import { useAsync, useResource } from '../api/hooks';
import { changes as t } from '../i18n/ko';
import { isDestructive } from '../lib/status';
import { prettyJson } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';
import { ToolAnnotationChips } from '../components/ToolAnnotationChips';
import { Badge, ButtonRow, ErrorNotice, JsonBlock, Loading, Notice, Section } from '../components/ui';

/** approvedDefinition(Record<string, unknown>)에서 설명·입력 스키마만 안전하게 꺼낸다. */
export function pickDefinition(def: Record<string, unknown> | null): { description: string | null; inputSchema: unknown } {
  if (!def) return { description: null, inputSchema: null };
  const description = typeof def['description'] === 'string' ? (def['description'] as string) : null;
  const inputSchema = def['inputSchema'] ?? null;
  return { description, inputSchema };
}

export function ChangesPage() {
  const { id = '' } = useParams();
  const res = useResource((signal) => mcpApi.getServer(id, signal), [id]);
  const server = res.data;

  const approve = useAsync(async (tools: ToolView[]) => {
    const r = await mcpApi.approve(id, {
      tools: tools.map((tool) => ({ name: tool.name, schemaHash: tool.schemaHash, enabled: tool.pendingApproval && !tool.changed ? !isDestructive(tool.annotations) : tool.enabled })),
    });
    await res.refetch();
    return r;
  });
  const disable = useAsync(async (name: string) => {
    const d = await mcpApi.patchServer(id, { tools: [{ name, enabled: false }] });
    res.setData(d);
    return d;
  });

  if (res.loading && !server) return <Loading />;
  if (res.error && !server) return <ErrorNotice error={res.error} onRetry={() => void res.refetch()} />;
  if (!server) return null;

  const changed = server.tools.filter((x) => x.changed);
  const added = server.tools.filter((x) => x.pendingApproval && !x.changed);
  const all = [...changed, ...added];
  const detailPath = `/mcp/servers/${encodeURIComponent(server.id)}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t.heading}</h1>
          <p className="small muted">
            <Link to={detailPath}>{server.displayName}</Link> · <span className="mono">{server.id}</span>
          </p>
        </div>
        <StatusBadge status={server.status} />
      </div>
      <p className="small muted">{t.intro}</p>
      <ErrorNotice error={approve.error} />
      <ErrorNotice error={disable.error} />
      {approve.result && <Notice tone="ok">{t.reapproved}</Notice>}

      {all.length === 0 && (
        <div className="card">
          <p className="empty">{t.none}</p>
          <Link to={detailPath} className="btn">
            {t.backToDetail}
          </Link>
        </div>
      )}

      {all.length > 0 && (
        <ButtonRow>
          <button type="button" className="btn btn-primary" disabled={approve.pending} onClick={() => void approve.run(all)}>
            {t.reapproveAll} ({all.length})
          </button>
          <Link to={detailPath} className="btn btn-ghost">
            {t.backToDetail}
          </Link>
        </ButtonRow>
      )}

      {changed.map((tool) => {
        const prev = pickDefinition(tool.approvedDefinition);
        return (
          <Section key={tool.name} title={tool.name} id={`tool-${tool.name}`}>
            <div className="tool-meta">
              <Badge tone="warn">변경됨</Badge>
              {!tool.enabled && <Badge tone="muted">꺼짐</Badge>}
              <ToolAnnotationChips annotations={tool.annotations} />
            </div>
            <div className="compare">
              <div className="compare-col compare-prev">
                <h3>{t.previous}</h3>
                <h4>{t.description}</h4>
                <p className="tool-desc">{prev.description ?? t.noDescription}</p>
                <h4>{t.inputSchema}</h4>
                <JsonBlock value={prettyJson(prev.inputSchema)} label={`${tool.name} ${t.previous} ${t.inputSchema}`} />
              </div>
              <div className="compare-col compare-cur">
                <h3>{t.current}</h3>
                <h4>{t.description}</h4>
                <p className="tool-desc">{tool.description ?? t.noDescription}</p>
                <h4>{t.inputSchema}</h4>
                <JsonBlock value={prettyJson(tool.inputSchema)} label={`${tool.name} ${t.current} ${t.inputSchema}`} />
              </div>
            </div>
            <ButtonRow>
              <button type="button" className="btn btn-primary" disabled={approve.pending} onClick={() => void approve.run([tool])}>
                {t.reapprove}
              </button>
              <button type="button" className="btn btn-danger" disabled={disable.pending || !tool.enabled} onClick={() => void disable.run(tool.name)}>
                {t.disableTool}
              </button>
            </ButtonRow>
          </Section>
        );
      })}

      {added.length > 0 && (
        <Section title={t.newTools} id="new-tools">
          <p className="small muted">{t.newToolHint}</p>
          <ul className="tool-list">
            {added.map((tool) => (
              <li key={tool.name} className={`tool-item${isDestructive(tool.annotations) ? ' tool-destructive' : ''}`}>
                <div className="tool-head">
                  <span className="mono tool-name">{tool.name}</span>
                  {tool.title && <span className="muted"> — {tool.title}</span>}
                </div>
                <div className="tool-meta">
                  <Badge tone="info">승인 대기</Badge>
                  <ToolAnnotationChips annotations={tool.annotations} />
                </div>
                {tool.description && <p className="tool-desc">{tool.description}</p>}
                <JsonBlock value={prettyJson(tool.inputSchema)} label={`${tool.name} ${t.inputSchema}`} />
                <ButtonRow>
                  <button type="button" className="btn btn-primary" disabled={approve.pending} onClick={() => void approve.run([tool])}>
                    {t.reapprove}
                  </button>
                </ButtonRow>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
