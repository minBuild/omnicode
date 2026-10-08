import { describe, expect, it } from 'vitest';
import { detectFormat, JsoncEditError, JsoncParseError, parseJsonc, removeValue, setValue } from '../src/jsonc-edit.js';

const fmt = { indentUnit: '  ', eol: '\n' };

describe('jsonc-edit: removeValue', () => {
  it('removes the last item of a single-line array without corrupting it', () => {
    const t = '{ "a": ["x", "y"] }';
    expect(removeValue(t, ['a', 1])).toBe('{ "a": ["x"] }');
  });
  it('removes the only item', () => {
    expect(removeValue('{ "a": ["x"] }', ['a', 0])).toBe('{ "a": [] }');
    expect(removeValue('{\n  "a": {\n    "k": 1\n  }\n}\n', ['a', 'k'])).toBe('{\n  "a": {}\n}\n');
  });
  it('removes a middle item and keeps a comment that precedes it', () => {
    const t = '[\n  "x",\n  // about y\n  "y",\n  "z"\n]\n';
    expect(removeValue(t, [1])).toBe('[\n  "x",\n  // about y\n  "z"\n]\n');
  });
  it('removes the last item on its own line and keeps the previous trailing comment', () => {
    const t = '{\n  "m": {\n    "a": 1, // a\n    "b": 2\n  }\n}\n';
    expect(removeValue(t, ['m', 'b'])).toBe('{\n  "m": {\n    "a": 1 // a\n  }\n}\n');
  });
  it('keeps a trailing comma style', () => {
    const t = '[\n  "x",\n  "y",\n]\n';
    expect(removeValue(t, [1])).toBe('[\n  "x",\n]\n');
  });
  it('handles CRLF', () => {
    const t = '{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n';
    expect(removeValue(t, ['b'])).toBe('{\r\n  "a": 1\r\n}\r\n');
  });
  it('is a no-op for a missing path', () => {
    const t = '{ "a": 1 }';
    expect(removeValue(t, ['zzz'])).toBe(t);
  });
});

describe('jsonc-edit: setValue', () => {
  it('creates a nested path in an empty document', () => {
    expect(setValue('', ['a', 'b'], { c: 1 }, fmt)).toBe('{\n  "a": {\n    "b": {\n      "c": 1\n    }\n  }\n}\n');
  });
  it('appends to a single-line array inline', () => {
    expect(setValue('{ "a": ["x", "y"] }', ['a', -1], 'z', fmt)).toBe('{ "a": ["x", "y", "z"] }');
  });
  it('appends to a multi-line array on a new line, keeping a trailing line comment', () => {
    const t = '{\n  "a": [\n    "x" // keep\n  ]\n}\n';
    expect(setValue(t, ['a', -1], 'y', fmt)).toBe('{\n  "a": [\n    "x", // keep\n    "y"\n  ]\n}\n');
  });
  it('appends after a trailing comma without adding another', () => {
    const t = '{\n  "a": [\n    "x",\n  ]\n}\n';
    expect(setValue(t, ['a', -1], 'y', fmt)).toBe('{\n  "a": [\n    "x",\n    "y"\n  ]\n}\n');
  });
  it('inserts into an empty multi-line container', () => {
    const t = '{\n  "a": []\n}\n';
    expect(setValue(t, ['a', -1], 'x', fmt)).toBe('{\n  "a": [\n    "x"\n  ]\n}\n');
  });
  it('replaces an existing value in place and renders nested objects with the file indentation', () => {
    const t = '{\n\t"m": {\n\t\t"k": { "old": true }, // c\n\t\t"z": 0\n\t}\n}\n';
    const out = setValue(t, ['m', 'k'], { a: { b: 1 } }, detectFormat(t));
    expect(out).toBe('{\n\t"m": {\n\t\t"k": {\n\t\t\t"a": {\n\t\t\t\t"b": 1\n\t\t\t}\n\t\t}, // c\n\t\t"z": 0\n\t}\n}\n');
  });
  it('creates missing intermediate objects next to existing properties', () => {
    const t = '{\n  "theme": "dark"\n}\n';
    expect(setValue(t, ['m', 'k'], 1, fmt)).toBe('{\n  "theme": "dark",\n  "m": {\n    "k": 1\n  }\n}\n');
  });
  it('rejects a non-object container', () => {
    expect(() => setValue('{ "a": 1 }', ['a', 'b'], 2, fmt)).toThrow(JsoncEditError);
  });
});

describe('jsonc-edit: parse', () => {
  it('reads comments and trailing commas', () => {
    expect(parseJsonc('{\n  // c\n  "a": [1,],\n}\n')).toEqual({ a: [1] });
  });
  it('throws on broken input', () => {
    expect(() => parseJsonc('{ "a": ')).toThrow(JsoncParseError);
  });
  it('detects indentation and eol', () => {
    expect(detectFormat('{\n    "a": 1\n}')).toEqual({ indentUnit: '    ', eol: '\n' });
    expect(detectFormat('{\r\n\t"a": 1\r\n}')).toEqual({ indentUnit: '\t', eol: '\r\n' });
    expect(detectFormat('{}')).toEqual({ indentUnit: '  ', eol: '\n' });
  });
});
