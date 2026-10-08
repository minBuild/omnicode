import { createHash } from 'node:crypto';
import type { ToolDefinition } from './types.js';

/**
 * RFC 8785 (JCS) 정규화. 키는 UTF-16 코드 유닛 순으로 정렬하고, undefined 값은 제거한다.
 * 숫자는 JSON.stringify의 ES6 Number::toString 규칙을 그대로 쓴다 (JCS와 동일).
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v === undefined ? null : v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** SDK의 Tool 객체(또는 임의 JSON)에서 해시 대상 필드만 뽑는다. icons·_meta 등은 버린다. */
export function normalizeToolDefinition(raw: Record<string, unknown>): ToolDefinition {
  const def: ToolDefinition = {
    name: String(raw.name),
    inputSchema: (raw.inputSchema as Record<string, unknown>) ?? { type: 'object' },
  };
  if (typeof raw.title === 'string') def.title = raw.title;
  if (typeof raw.description === 'string') def.description = raw.description;
  if (raw.outputSchema && typeof raw.outputSchema === 'object') def.outputSchema = raw.outputSchema as Record<string, unknown>;
  if (raw.annotations && typeof raw.annotations === 'object') def.annotations = raw.annotations as ToolDefinition['annotations'];
  return def;
}

/** 13장 해시 규칙: sha256(JCS({ name, title, description, inputSchema, outputSchema, annotations })). */
export function toolDefinitionHash(def: ToolDefinition): string {
  const picked = {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    annotations: def.annotations,
  };
  return sha256Hex(canonicalize(picked));
}
