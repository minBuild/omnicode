/** scope 문자열 도우미 (설계 10.3 scope step-up: 합집합, 중복 제거, 순서 유지). */

export function parseScope(scope: string | null | undefined): string[] {
  if (!scope) return [];
  return scope.split(/\s+/).filter((s) => s.length > 0);
}

/** 기존 scope 뒤에 새 scope를 덧붙인 합집합. 중복은 제거하고 처음 본 순서를 유지한다. 비어 있으면 null. */
export function unionScope(existing: string | null | undefined, incoming: string | null | undefined): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...parseScope(existing), ...parseScope(incoming)]) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.length > 0 ? out.join(' ') : null;
}
