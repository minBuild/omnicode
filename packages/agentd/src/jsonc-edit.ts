/**
 * 주석·형식을 보존하는 JSONC 부분 편집 (설계 12.1 "형식 보존", P11).
 *
 * jsonc-parser의 `parseTree`/`findNodeAtLocation`/`createScanner`로 편집 범위를 계산하고
 * `applyEdits`로 적용한다. `modify()`를 쓰지 않는 이유:
 *  - 한 줄짜리 배열의 마지막 항목을 지우면 텍스트가 깨진다 (`["a", "b"]` → `["a""] } }`).
 *  - 삽입·삭제 지점이 있는 줄 전체를 다시 포맷해 이웃 항목(다른 서버)의 형식과 줄 끝 주석이 바뀐다.
 * 여기서는 바뀌는 항목의 바이트만 건드리고 나머지는 그대로 둔다.
 */
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  parse,
  parseTree,
  printParseErrorCode,
  SyntaxKind,
  type Edit,
  type JSONPath,
  type Node,
  type ParseError,
} from 'jsonc-parser';

export interface JsonFormat {
  /** 들여쓰기 한 단계 (예: 두 칸, 탭) */
  indentUnit: string;
  eol: string;
}

export class JsoncParseError extends Error {
  constructor(readonly errors: ParseError[]) {
    super(
      `invalid JSON: ${errors
        .slice(0, 3)
        .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
        .join(', ')}`,
    );
    this.name = 'JsoncParseError';
  }
}

export class JsoncEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsoncEditError';
  }
}

const PARSE_OPTIONS = { allowTrailingComma: true, allowEmptyContent: true } as const;

/** 기존 파일의 들여쓰기·개행 문자를 알아낸다. 없으면 두 칸·LF. */
export function detectFormat(text: string): JsonFormat {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = /^([ \t]+)\S/m.exec(text);
  return { indentUnit: m?.[1] ?? '  ', eol };
}

/** 주석·후행 쉼표를 허용해 값만 읽는다. 오류가 있으면 던진다 (덮어쓰지 않기 위해). */
export function parseJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, PARSE_OPTIONS);
  if (errors.length > 0) throw new JsoncParseError(errors);
  return value;
}

function parseTreeStrict(text: string): Node | undefined {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, PARSE_OPTIONS);
  if (errors.length > 0) throw new JsoncParseError(errors);
  return root;
}

function lineStart(text: string, offset: number): number {
  let i = offset;
  while (i > 0 && text[i - 1] !== '\n') i--;
  return i;
}

/** offset이 속한 줄의 앞쪽 공백 */
function lineIndent(text: string, offset: number): string {
  const start = lineStart(text, offset);
  const m = /^[ \t]*/.exec(text.slice(start, offset));
  return m?.[0] ?? '';
}

function render(value: unknown, fmt: JsonFormat, baseIndent: string, inline: boolean): string {
  if (inline) return JSON.stringify(value);
  return JSON.stringify(value, null, fmt.indentUnit).split('\n').join(fmt.eol + baseIndent);
}

function wrap(path: JSONPath, value: unknown): unknown {
  return path.reduceRight<unknown>((acc, seg) => (typeof seg === 'string' ? { [seg]: acc } : [acc]), value);
}

/** 컨테이너의 첫 항목이 여는 괄호와 다른 줄에 있으면 여러 줄 스타일 */
function isMultiline(text: string, container: Node): boolean {
  const first = container.children?.[0];
  if (!first) return false;
  return text.slice(container.offset, first.offset).includes('\n');
}

function isTrivia(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.Trivia ||
    kind === SyntaxKind.LineBreakTrivia ||
    kind === SyntaxKind.LineCommentTrivia ||
    kind === SyntaxKind.BlockCommentTrivia
  );
}

/** from부터 공백·주석을 건너뛴 다음 토큰이 쉼표면 그 위치 */
function findComma(text: string, from: number, limit: number): number | undefined {
  const scanner = createScanner(text, false);
  scanner.setPosition(from);
  for (;;) {
    const kind = scanner.scan();
    if (kind === SyntaxKind.EOF || scanner.getTokenOffset() >= limit) return undefined;
    if (isTrivia(kind)) continue;
    return kind === SyntaxKind.CommaToken ? scanner.getTokenOffset() : undefined;
  }
}

/** from부터 같은 줄에 공백·주석만 있으면 그 줄의 개행 시작 위치, 다른 토큰이 있으면 undefined */
function findLineBreak(text: string, from: number, limit: number): number | undefined {
  const scanner = createScanner(text, false);
  scanner.setPosition(from);
  for (;;) {
    const kind = scanner.scan();
    const offset = scanner.getTokenOffset();
    if (kind === SyntaxKind.EOF || offset >= limit) return undefined;
    if (kind === SyntaxKind.LineBreakTrivia) return offset;
    if (!isTrivia(kind)) return undefined;
  }
}

function insertIntoContainer(text: string, container: Node, key: string | undefined, value: unknown, fmt: JsonFormat): string {
  const open = container.offset;
  const close = container.offset + container.length - 1;
  const children = container.children ?? [];
  const entry = (indent: string, inline: boolean): string =>
    (key === undefined ? '' : `${JSON.stringify(key)}: `) + render(value, fmt, indent, inline);

  if (children.length === 0) {
    const containerIndent = lineIndent(text, open);
    const multiline = text.includes('\n') || container.parent === undefined;
    const inner = text.slice(open + 1, close);
    if (!multiline) {
      return applyEdits(text, [{ offset: open + 1, length: close - open - 1, content: ` ${entry('', true)} ` }]);
    }
    const entryIndent = containerIndent + fmt.indentUnit;
    if (inner.trim() === '') {
      const content = fmt.eol + entryIndent + entry(entryIndent, false) + fmt.eol + containerIndent;
      return applyEdits(text, [{ offset: open + 1, length: close - open - 1, content }]);
    }
    // 괄호 안에 주석만 있는 경우: 여는 괄호 바로 뒤에 넣고 주석은 둔다
    return applyEdits(text, [{ offset: open + 1, length: 0, content: fmt.eol + entryIndent + entry(entryIndent, false) }]);
  }

  const last = children[children.length - 1]!;
  const lastEnd = last.offset + last.length;
  const trailingComma = findComma(text, lastEnd, close);
  const afterLast = trailingComma === undefined ? lastEnd : trailingComma + 1;

  if (isMultiline(text, container)) {
    // 마지막 항목 줄의 개행 직전에 새 줄을 끼운다 — 그 줄의 끝 주석은 그대로 남는다
    const lineBreak = findLineBreak(text, afterLast, close);
    if (lineBreak !== undefined) {
      const indent = lineIndent(text, last.offset);
      const line = fmt.eol + indent + entry(indent, false);
      const edits: Edit[] = [];
      if (trailingComma !== undefined) edits.push({ offset: lineBreak, length: 0, content: line });
      else if (lineBreak === lastEnd) edits.push({ offset: lastEnd, length: 0, content: ',' + line });
      else edits.push({ offset: lastEnd, length: 0, content: ',' }, { offset: lineBreak, length: 0, content: line });
      return applyEdits(text, edits);
    }
  }
  const content = (trailingComma === undefined ? ', ' : ' ') + entry('', true);
  return applyEdits(text, [{ offset: afterLast, length: 0, content }]);
}

/**
 * 경로의 값을 바꾸거나 만든다. 중간 객체가 없으면 함께 만든다.
 * 배열에는 `-1`(또는 길이) 인덱스로 끝에 추가할 수 있다.
 */
export function setValue(text: string, path: JSONPath, value: unknown, fmt: JsonFormat): string {
  const root = text.trim() === '' ? undefined : parseTreeStrict(text);
  if (!root) {
    return render(wrap(path, value), fmt, '', false) + fmt.eol;
  }
  for (let depth = path.length; depth >= 0; depth--) {
    const node = findNodeAtLocation(root, path.slice(0, depth));
    if (!node) continue;
    if (depth === path.length) {
      // 기존 값 교체
      const holder = node.parent?.type === 'property' ? node.parent : node;
      const container = holder.parent;
      const inline = container ? !isMultiline(text, container) : false;
      const content = render(value, fmt, lineIndent(text, holder.offset), inline);
      return applyEdits(text, [{ offset: node.offset, length: node.length, content }]);
    }
    const seg = path[depth]!;
    const toInsert = wrap(path.slice(depth + 1), value);
    if (typeof seg === 'string') {
      if (node.type !== 'object') throw new JsoncEditError(`${describePath(path.slice(0, depth))} is not an object`);
      return insertIntoContainer(text, node, seg, toInsert, fmt);
    }
    if (node.type !== 'array') throw new JsoncEditError(`${describePath(path.slice(0, depth))} is not an array`);
    const len = node.children?.length ?? 0;
    if (seg !== -1 && seg !== len) throw new JsoncEditError(`array index ${seg} out of range (length ${len})`);
    return insertIntoContainer(text, node, undefined, toInsert, fmt);
  }
  throw new JsoncEditError('document has no root value');
}

/** 경로의 속성(또는 배열 항목)을 지운다. 없으면 그대로 돌려준다. 이웃 항목의 바이트는 건드리지 않는다. */
export function removeValue(text: string, path: JSONPath): string {
  if (text.trim() === '') return text;
  const root = parseTreeStrict(text);
  if (!root) return text;
  const node = findNodeAtLocation(root, path);
  if (!node) return text;
  const target = node.parent?.type === 'property' ? node.parent : node;
  const container = target.parent;
  if (!container) throw new JsoncEditError('cannot remove the document root');
  const children = container.children ?? [];
  const idx = children.indexOf(target);
  const open = container.offset;
  const close = container.offset + container.length - 1;

  if (children.length === 1) {
    return applyEdits(text, [{ offset: open + 1, length: close - open - 1, content: '' }]);
  }
  if (idx < children.length - 1) {
    // 중간 항목: 다음 항목 시작까지 (쉼표 포함) 지운다
    const next = children[idx + 1]!;
    return applyEdits(text, [{ offset: target.offset, length: next.offset - target.offset, content: '' }]);
  }
  // 마지막 항목: 앞 항목 뒤의 쉼표와 항목 자신을 지운다
  const prev = children[idx - 1]!;
  const prevEnd = prev.offset + prev.length;
  const comma = findComma(text, prevEnd, target.offset);
  const targetEnd = target.offset + target.length;
  const edits: Edit[] = [];
  if (comma !== undefined) edits.push({ offset: comma, length: 1, content: '' });
  const start = lineStart(text, target.offset);
  const ownLine = start > 0 && text.slice(start, target.offset).trim() === '' && start > (comma ?? prevEnd);
  if (ownLine) {
    // 줄 전체를 앞 개행과 함께 지운다 → 앞 줄의 끝 주석과 들여쓰기는 그대로
    const eolStart = text[start - 2] === '\r' ? start - 2 : start - 1;
    edits.push({ offset: eolStart, length: targetEnd - eolStart, content: '' });
  } else {
    const from = comma === undefined ? prevEnd : comma + 1;
    edits.push({ offset: from, length: targetEnd - from, content: '' });
  }
  return applyEdits(text, edits);
}

function describePath(path: JSONPath): string {
  return path.length === 0 ? '<root>' : path.map(String).join('.');
}
