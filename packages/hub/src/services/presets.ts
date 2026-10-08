/** 9.1 / 16.7 프리셋 로더. 레포의 presets/*.json 을 읽고 PresetSchema 로 검증한다. */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PresetSchema, type Preset } from '@omnicode/shared';
import type { Logger } from '../contracts.js';

export interface PresetLoadResult {
  presets: Preset[];
  problems: Array<{ file: string; error: string }>;
}

export function loadPresets(dir: string, logger?: Logger): PresetLoadResult {
  const out: PresetLoadResult = { presets: [], problems: [] };
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'schema.json');
  } catch (e) {
    logger?.warn({ dir, err: String(e) }, 'presets dir not readable');
    return out;
  }
  for (const f of files.sort()) {
    const file = join(dir, f);
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const parsed = PresetSchema.safeParse(raw);
      if (!parsed.success) {
        out.problems.push({ file, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
        continue;
      }
      if (parsed.data.id !== basename(f, '.json')) {
        out.problems.push({ file, error: `id '${parsed.data.id}' != filename` });
        continue;
      }
      out.presets.push(parsed.data);
    } catch (e) {
      out.problems.push({ file, error: String(e) });
    }
  }
  for (const p of out.problems) logger?.warn(p, 'preset rejected');
  return out;
}
