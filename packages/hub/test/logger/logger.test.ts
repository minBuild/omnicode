import { describe, expect, it } from 'vitest';
import { createMasker } from '@omnicode/shared';
import { createLogger, maskDeep } from '../../src/logger.js';

const SECRET = 'sk-live-super-secret-value-9876';
const OMH = 'omh_' + 'a'.repeat(43);

function capture() {
  const lines: string[] = [];
  return { lines, stream: { write: (msg: string) => void lines.push(msg) } };
}

describe('maskDeep', () => {
  it('masks strings anywhere, converts errors, guards cycles', () => {
    const m = createMasker([SECRET]);
    const err = new Error(`failed with ${SECRET}`);
    const cyc: Record<string, unknown> = { s: SECRET };
    cyc.self = cyc;
    const out = maskDeep(m, { a: SECRET, list: [SECRET, { deep: SECRET }], err, cyc, n: 1, d: new Date(0), map: new Map([[SECRET, SECRET]]) }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.a).toBe('***');
    expect((out.err as Error).message).toBe('failed with ***');
    expect(out.err).toBeInstanceOf(Error);
    expect((out.err as Error).stack ?? '').not.toContain(SECRET);
    class Custom extends Error {
      code = SECRET;
      constructor() {
        super(SECRET);
        this.name = 'Custom';
      }
    }
    const custom = maskDeep(m, new Custom()) as Custom;
    expect(custom).toBeInstanceOf(Custom);
    expect(custom).toMatchObject({ name: 'Custom', message: '***', code: '***' });
    expect((out.cyc as { self: unknown }).self).toBe('[Circular]');
    expect(out.n).toBe(1);
    expect(out.d).toBeInstanceOf(Date);
  });
});

describe('createLogger', () => {
  it('never writes a known secret, in any argument position', () => {
    const masker = createMasker([SECRET]);
    const { lines, stream } = capture();
    const log = createLogger(masker, { destination: stream, level: 'debug', base: null });

    log.info(SECRET);
    log.info('token is %s', SECRET);
    log.info({ token: SECRET, nested: { list: [SECRET] } }, 'with object');
    log.warn({ err: new Error(`boom ${SECRET}`) }, 'with error');
    log.error(new Error(`top-level error ${SECRET}`));
    log.child({ serverId: 'fish', secret: SECRET }).info('child');
    log.child({ a: 1 }).child({ b: SECRET }).debug({ c: SECRET }, `msg ${SECRET}`);
    log.info({ header: `Authorization: Bearer ${'x'.repeat(30)}`, hub: OMH, body: `{"access_token":"${'q'.repeat(20)}"}` }, 'patterns');
    log.info({ quoted: `${SECRET}"with"quotes\\and\\backslashes` }, 'escapes');

    expect(lines.length).toBe(9);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(OMH);
      expect(line).not.toContain('x'.repeat(30));
      expect(line).not.toContain('q'.repeat(20));
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const objLine = JSON.parse(lines[2] ?? '{}') as Record<string, unknown>;
    expect(objLine).toMatchObject({ token: '***', nested: { list: ['***'] }, msg: 'with object' });
    const errLine = JSON.parse(lines[3] ?? '{}') as { err: { message: string; type: string; stack?: string } };
    expect(errLine.err.message).toBe('boom ***');
    expect(errLine.err.type).toBe('Error');
    expect(errLine.err.stack ?? '').not.toContain(SECRET);
    const childLine = JSON.parse(lines[5] ?? '{}') as Record<string, unknown>;
    expect(childLine).toMatchObject({ serverId: 'fish', secret: '***', msg: 'child' });
    expect(JSON.parse(lines[7] ?? '{}')).toMatchObject({ hub: 'omh_***', header: 'Authorization: Bearer ***' });
  });

  it('masks secrets added after the logger was created and respects level', () => {
    const masker = createMasker();
    const { lines, stream } = capture();
    const log = createLogger(masker, { destination: stream, level: 'info', name: 'hub' });
    log.debug({ s: SECRET }, 'dropped');
    log.info({ s: SECRET }, 'before add'); // 아직 모르는 값 — 사전에 없으면 가릴 수 없다
    masker.add(SECRET);
    log.info({ s: SECRET }, 'after add');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(SECRET);
    expect(lines[1]).not.toContain(SECRET);
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ name: 'hub', level: 30, s: '***' });
  });
});
