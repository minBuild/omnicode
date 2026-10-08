#!/usr/bin/env node
// tsc 는 .sql 을 dist 로 복사하지 않는다. 빌드 뒤에 레지스트리 마이그레이션 파일을 dist 에 넣는다 (설계 19.2.1).
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'packages/hub/src/registry/migrations');
const dst = join(root, 'packages/hub/dist/registry/migrations');
mkdirSync(dst, { recursive: true });
const files = readdirSync(src).filter((f) => f.endsWith('.sql'));
for (const f of files) copyFileSync(join(src, f), join(dst, f));
console.log(`copy-migrations: ${files.length} file(s) → ${dst}`);
