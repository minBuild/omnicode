import type { ServerStatus } from '@omnicode/shared';
import { statusLabel, statusTone } from '../lib/status';
import { Badge } from './ui';

export function StatusBadge({ status, scopeStepUp, label }: { status: ServerStatus; scopeStepUp?: boolean; label?: string }) {
  return <Badge tone={statusTone(status)}>{label ?? statusLabel(status, { scopeStepUp })}</Badge>;
}
