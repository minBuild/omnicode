import type { Agent, SyncOutcome } from '@omnicode/shared';
import { agentLongLabels } from '../i18n/ko';
import { ALL_AGENTS, syncLabel, syncTone } from '../lib/status';
import { formatDateTime } from '../lib/format';
import { Badge } from './ui';

export function SyncResults({ sync }: { sync: Partial<Record<Agent, SyncOutcome | null>> }) {
  return (
    <ul className="sync-results">
      {ALL_AGENTS.map((agent) => {
        const o = sync[agent];
        return (
          <li key={agent} className="sync-result">
            <span className="sync-result-agent">{agentLongLabels[agent]}</span>
            {o ? (
              <>
                <Badge tone={syncTone(o.status, true)}>{syncLabel(o.status)}</Badge>
                {o.at && <span className="small muted">{formatDateTime(o.at)}</span>}
                {o.error && <span className="small danger-text">{o.error}</span>}
                {o.result && (
                  <span className="small muted">
                    추가 {o.result.added.length} · 변경 {o.result.updated.length} · 제거 {o.result.removed.length} · 유지 {o.result.unchanged.length}
                  </span>
                )}
              </>
            ) : (
              <Badge tone="muted">—</Badge>
            )}
          </li>
        );
      })}
    </ul>
  );
}
