import type { ToolAnnotations } from '@omnicode/shared';
import { annotationLabels } from '../i18n/ko';
import { Badge } from './ui';

const KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

export function ToolAnnotationChips({ annotations }: { annotations: ToolAnnotations | null }) {
  if (!annotations) return null;
  const chips = KEYS.filter((k) => annotations[k] === true);
  if (chips.length === 0) return null;
  return (
    <span className="chips">
      {chips.map((k) => (
        <Badge key={k} tone={k === 'destructiveHint' ? 'danger' : k === 'openWorldHint' ? 'warn' : 'muted'}>
          {annotationLabels[k]}
        </Badge>
      ))}
    </span>
  );
}
