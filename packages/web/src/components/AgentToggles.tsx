import type { Agent, BindingsView } from '@omnicode/shared';
import { agentLabels, detail as t } from '../i18n/ko';
import { ALL_AGENTS, syncLabel, syncTone } from '../lib/status';
import { formatDateTime } from '../lib/format';
import { Dot, Switch } from './ui';

export function AgentToggles({
  bindings,
  onToggle,
  disabled,
  busyAgent,
  showDetails,
}: {
  bindings: BindingsView;
  onToggle: (agent: Agent, enabled: boolean) => void;
  disabled?: boolean;
  busyAgent?: Agent | null;
  showDetails?: boolean;
}) {
  return (
    <ul className={`agent-toggles${showDetails ? ' agent-toggles-detailed' : ''}`}>
      {ALL_AGENTS.map((agent) => {
        const b = bindings[agent];
        const dotLabel = b.enabled ? syncLabel(b.syncStatus) : '꺼짐';
        return (
          <li key={agent} className="agent-toggle">
            <Switch
              checked={b.enabled}
              disabled={disabled || busyAgent === agent}
              onChange={(next) => onToggle(agent, next)}
              label={agentLabels[agent]}
              description={dotLabel}
            />
            <Dot tone={syncTone(b.syncStatus, b.enabled)} label={dotLabel} />
            {showDetails && (
              <div className="agent-toggle-meta small muted">
                <span>{dotLabel}</span>
                {b.syncedAt && (
                  <span>
                    {' · '}
                    {t.syncedAt} {formatDateTime(b.syncedAt)}
                  </span>
                )}
                {b.lastError && (
                  <span className="danger-text">
                    {' · '}
                    {t.syncError}: {b.lastError}
                  </span>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
