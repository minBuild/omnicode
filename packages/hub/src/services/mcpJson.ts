/**
 * README 등에 흔한 MCP 서버 설정 JSON 을 읽는다 (9.1 JSON 붙여넣기, handoff C2).
 *
 * 받는 형태:
 *   { "mcpServers": { "<이름>": { ... } } }   Claude Code·Cursor·Gemini CLI
 *   { "servers":    { "<이름>": { ... } } }   VS Code
 *   { "<이름>": { ... }, ... }                 감싸는 키 없이
 *   { "url": "...", ... }                      항목 하나 (이름은 URL 호스트)
 * 항목 필드: type(http|streamable_http|streamable-http|sse|stdio), url | httpUrl(Gemini) | serverUrl(Windsurf),
 *           headers, command, args, env.
 * 값(헤더·env)은 반환하지만 로그·오류 메시지에는 넣지 않는다.
 */
import { ApiError } from '@omnicode/shared';

export interface McpJsonHttpEntry {
  name: string;
  kind: 'http';
  url: string;
  /** 'sse' 면 레거시 HTTP+SSE 로 표시된 항목. 실제 전송은 탐지가 정한다 (11.1) */
  transportHint: 'streamable_http' | 'sse';
  headers: Record<string, string>;
}

export interface McpJsonStdioEntry {
  name: string;
  kind: 'stdio';
  command: string;
  args: string[];
  envKeys: string[];
}

export type McpJsonEntry = McpJsonHttpEntry | McpJsonStdioEntry;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const ENTRY_KEYS = ['url', 'httpUrl', 'serverUrl', 'command'];
const looksLikeEntry = (x: unknown): x is Record<string, unknown> => isRecord(x) && ENTRY_KEYS.some((k) => typeof x[k] === 'string');

function bad(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError('validation_error', message, details);
}

function stringRecord(x: unknown, what: string, name: string): Record<string, string> {
  if (x === undefined) return {};
  if (!isRecord(x)) throw bad(`'${name}' 항목의 ${what}는 객체여야 합니다.`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(x)) {
    if (typeof v !== 'string') throw bad(`'${name}' 항목의 ${what} '${k}' 값은 문자열이어야 합니다.`);
    out[k] = v;
  }
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'server';
  }
}

function parseEntry(name: string, raw: Record<string, unknown>): McpJsonEntry {
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined;
  if (type !== undefined && !['http', 'streamable_http', 'streamable-http', 'sse', 'stdio'].includes(type)) {
    throw bad(`'${name}' 항목의 type '${raw.type as string}'을(를) 알 수 없습니다.`);
  }
  const command = typeof raw.command === 'string' ? raw.command.trim() : undefined;
  if (type === 'stdio' || (command && type === undefined && typeof raw.url !== 'string' && typeof raw.httpUrl !== 'string')) {
    if (!command) throw bad(`'${name}' 항목은 stdio 인데 command 가 없습니다.`);
    const args = raw.args === undefined ? [] : raw.args;
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw bad(`'${name}' 항목의 args 는 문자열 배열이어야 합니다.`);
    return { name, kind: 'stdio', command, args: args as string[], envKeys: Object.keys(stringRecord(raw.env, 'env', name)) };
  }
  // Gemini 는 httpUrl = Streamable HTTP, url = SSE 다. 다른 도구는 url + type 으로 구분한다
  const url = typeof raw.httpUrl === 'string' ? raw.httpUrl : typeof raw.url === 'string' ? raw.url : typeof raw.serverUrl === 'string' ? raw.serverUrl : undefined;
  if (!url) throw bad(`'${name}' 항목에 url 이 없습니다.`);
  // 힌트일 뿐이다. 실제 전송·세대는 탐지가 정한다 (11.1)
  const transportHint = type === 'sse' ? 'sse' : 'streamable_http';
  return { name, kind: 'http', url: url.trim(), transportHint, headers: stringRecord(raw.headers, 'headers', name) };
}

export function parseMcpServersJson(text: string): McpJsonEntry[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw bad('JSON 형식이 올바르지 않습니다.', { reason: e instanceof Error ? e.message.slice(0, 120) : 'parse error' });
  }
  if (!isRecord(doc)) throw bad('JSON 최상위는 객체여야 합니다.');

  let map: Record<string, unknown>;
  if (isRecord(doc.mcpServers)) map = doc.mcpServers;
  else if (isRecord(doc.servers)) map = doc.servers;
  else if (looksLikeEntry(doc)) {
    const url = (doc.httpUrl ?? doc.url ?? doc.serverUrl) as string | undefined;
    const name = typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : url ? hostOf(url) : String(doc.command);
    return [parseEntry(name, doc)];
  } else map = doc;

  const entries: McpJsonEntry[] = [];
  for (const [name, raw] of Object.entries(map)) {
    if (!isRecord(raw)) continue;
    entries.push(parseEntry(name, raw));
  }
  if (entries.length === 0) throw bad('MCP 서버 항목을 찾지 못했습니다. "mcpServers" 블록을 붙여 넣으세요.');
  return entries;
}

/** 헤더 값이 ${VAR} · $VAR 같은 환경변수 자리표시자인가 — 그렇다면 값을 따로 입력받는다 */
export function isEnvPlaceholder(value: string): boolean {
  return /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(value) || /<[^>]+>/.test(value) || /YOUR[_-]?(API[_-]?)?KEY/i.test(value);
}

/** 항목 이름 → 서버 ID 후보 ([a-z0-9-]{1,40}) */
export function idFromEntryName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}
