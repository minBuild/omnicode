/** 16.6 마스킹 사전 — 알려진 비밀값의 정확한 문자열 치환 + 정규식. */

const PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer ***'],
  [/"(access_token|refresh_token|client_secret|value|token)"\s*:\s*"[^"]*"/g, '"$1":"***"'],
  [/omh_[A-Za-z0-9_-]{20,}/g, 'omh_***'],
];

const MIN_SECRET_LENGTH = 8;

export interface Masker {
  mask(input: string): string;
  add(secret: string | null | undefined): void;
  remove(secret: string): void;
  size(): number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createMasker(initial: Iterable<string> = []): Masker {
  const secrets = new Set<string>();
  let compiled: RegExp | null = null;

  const rebuild = () => {
    if (secrets.size === 0) {
      compiled = null;
      return;
    }
    const sorted = [...secrets].sort((a, b) => b.length - a.length).map(escapeRegExp);
    compiled = new RegExp(sorted.join('|'), 'g');
  };

  const add = (secret: string | null | undefined) => {
    if (!secret || secret.length < MIN_SECRET_LENGTH) return;
    if (!secrets.has(secret)) {
      secrets.add(secret);
      rebuild();
    }
  };
  for (const s of initial) add(s);

  return {
    add,
    remove(secret) {
      if (secrets.delete(secret)) rebuild();
    },
    size: () => secrets.size,
    mask(input) {
      if (typeof input !== 'string' || input.length === 0) return input;
      let out = compiled ? input.replace(compiled, '***') : input;
      for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
      return out;
    },
  };
}

/** 객체를 JSON으로 만든 뒤 마스킹한다. 로그·이벤트 details 용. */
export function maskJson(masker: Masker, value: unknown, maxBytes = 4096): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? 'null';
  } catch {
    s = String(value);
  }
  s = masker.mask(s);
  return s.length > maxBytes ? s.slice(0, maxBytes) + '…' : s;
}
