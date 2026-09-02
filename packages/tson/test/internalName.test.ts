import { describe, expect, it } from 'vitest';

import { MAX_PART, fnv1a32, part } from '../src/compiler/internalName.js';

describe('part', () => {
  it('splices ASCII, §7.7-admitted text verbatim when within the length budget', () => {
    expect(part('order_line')).toBe('order_line');
    expect(part('some-name')).toBe('some-name');
    expect(part('T')).toBe('T');
  });

  it('exactly MAX_PART admitted characters is still spliced whole', () => {
    const exact = 'a'.repeat(MAX_PART);
    expect(part(exact)).toBe(exact);
  });

  it('one character past MAX_PART truncates the readable half and appends a hash', () => {
    const tooLong = 'a'.repeat(MAX_PART + 1);
    const result = part(tooLong);
    expect(result).toMatch(/^a{54}_h[0-9a-f]{8}$/);
    expect(result.length).toBe(MAX_PART);
  });

  it('ASCII text with a character outside the §7.7 profile keeps the admitted characters and appends a hash', () => {
    // Java's own InternalName.part example: "/x" -> readable "x", not "/x".
    expect(part('/x')).toMatch(/^x_h[0-9a-f]{8}$/);
    // A `.` (from a float literal) is not XID_Continue and is not admitted either.
    expect(part('1.0')).toMatch(/^1_0_h[0-9a-f]{8}$/);
  });

  it('collapses a run of non-admitted characters to one `_` and trims the edges', () => {
    // Every character here is punctuation outside the §7.7 profile, so the whole admitted text
    // collapses to nothing and the run-collapsing/trim logic leaves an empty readable half.
    expect(part('///')).toMatch(/^h[0-9a-f]{8}$/);
    expect(part('a///b')).toMatch(/^a_b_h[0-9a-f]{8}$/);
  });

  it('any non-ASCII character means the hash alone, no readable half at all', () => {
    expect(part('путь')).toMatch(/^h[0-9a-f]{8}$/);
    // Mixing an ASCII head with one non-ASCII character still hashes only, not half-and-half.
    expect(part('order_ő')).toMatch(/^h[0-9a-f]{8}$/);
  });

  it('is deterministic: the same text always produces the same part', () => {
    expect(part('/orders/{id}')).toBe(part('/orders/{id}'));
    expect(part('путь')).toBe(part('путь'));
  });

  it('two different texts that sanitise to the same admitted characters still differ, via the hash', () => {
    const a = part('a/b');
    const b = part('a.b');
    expect(a).not.toBe(b);
  });
});

describe('fnv1a32', () => {
  it('is deterministic and produces an unsigned 32-bit integer', () => {
    const hash = fnv1a32('hello');
    expect(fnv1a32('hello')).toBe(hash);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });

  it('differs for different input (no accidental constant)', () => {
    expect(fnv1a32('hello')).not.toBe(fnv1a32('world'));
  });
});
