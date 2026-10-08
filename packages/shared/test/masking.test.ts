import { describe, expect, it } from 'vitest';
import { createMasker, maskJson } from '../src/masking.js';

describe('masker', () => {
  it('replaces exact secrets, longest first', () => {
    const m = createMasker(['secret-value-1', 'secret-value-123']);
    expect(m.mask('a secret-value-123 b secret-value-1')).toBe('a *** b ***');
  });
  it('ignores short secrets', () => {
    const m = createMasker(['short']);
    expect(m.mask('short text')).toBe('short text');
    expect(m.size()).toBe(0);
  });
  it('masks bearer tokens, token json fields and omh_ tokens', () => {
    const m = createMasker();
    expect(m.mask('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123')).toBe('Authorization: Bearer ***');
    expect(m.mask('{"access_token":"xyz","other":"keep"}')).toBe('{"access_token":"***","other":"keep"}');
    expect(m.mask('token omh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa here')).toBe('token omh_*** here');
  });
  it('maskJson truncates', () => {
    const m = createMasker(['supersecretvalue']);
    const out = maskJson(m, { a: 'supersecretvalue', b: 'x'.repeat(5000) }, 100);
    expect(out).not.toContain('supersecretvalue');
    expect(out.length).toBeLessThanOrEqual(101);
  });
});
