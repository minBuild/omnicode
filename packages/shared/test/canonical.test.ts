import { describe, expect, it } from 'vitest';
import { canonicalize, normalizeToolDefinition, toolDefinitionHash } from '../src/canonical.js';

describe('canonicalize (JCS)', () => {
  it('sorts keys and drops undefined', () => {
    expect(canonicalize({ b: 1, a: [2, { d: undefined, c: null }] })).toBe('{"a":[2,{"c":null}],"b":1}');
  });
  it('is whitespace and key-order independent', () => {
    const a = canonicalize(JSON.parse('{"x": {"y": 1, "z": "s"}, "w": [1,2]}'));
    const b = canonicalize({ w: [1, 2], x: { z: 's', y: 1 } });
    expect(a).toBe(b);
  });
});

describe('toolDefinitionHash', () => {
  const base = {
    name: 'tts',
    description: 'make speech',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { destructiveHint: false },
  };
  it('ignores icons/_meta and key order', () => {
    const h1 = toolDefinitionHash(normalizeToolDefinition({ ...base, icons: [{ src: 'x' }], _meta: { a: 1 } }));
    const h2 = toolDefinitionHash(normalizeToolDefinition({ annotations: base.annotations, inputSchema: base.inputSchema, description: base.description, name: base.name }));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes when the description changes by one character', () => {
    const h1 = toolDefinitionHash(normalizeToolDefinition(base));
    const h2 = toolDefinitionHash(normalizeToolDefinition({ ...base, description: 'make speech!' }));
    expect(h1).not.toBe(h2);
  });
  it('includes outputSchema', () => {
    const h1 = toolDefinitionHash(normalizeToolDefinition(base));
    const h2 = toolDefinitionHash(normalizeToolDefinition({ ...base, outputSchema: { type: 'object' } }));
    expect(h1).not.toBe(h2);
  });
});
