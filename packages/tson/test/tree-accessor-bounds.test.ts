import { describe, expect, it } from 'vitest';
import { atomNode } from '../src/tree/nodes.js';
import { asInt, asLong } from '../src/tree/accessors.js';

/**
 * A decimal's exponent comes from the document and is very cheap to write. `1E20000000` is eleven
 * bytes and denotes a twenty-million-digit integer, so materialising it before checking whether it
 * could ever fit is an amplification out of all proportion to the input — and past a point BigInt
 * throws `RangeError`, which would break these accessors' contract of never throwing.
 */
describe('numeric accessors are bounded by work, not just by range', () => {
  it('answers a hostile positive exponent quickly instead of materialising it', () => {
    const started = Date.now();
    expect(asLong(atomNode({ unscaled: 1n, exponent: 20_000_000 }))).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('does not throw where BigInt itself would', () => {
    // 10n ** 1000000000n throws RangeError: Maximum BigInt size exceeded.
    expect(() => asLong(atomNode({ unscaled: 1n, exponent: 1_000_000_000 }))).not.toThrow();
    expect(asLong(atomNode({ unscaled: 1n, exponent: 1_000_000_000 }))).toBeUndefined();
    expect(asInt(atomNode({ unscaled: 1n, exponent: 1_000_000_000 }))).toBeUndefined();
  });

  it('answers a hostile negative exponent without computing the divisor', () => {
    const started = Date.now();
    expect(asLong(atomNode({ unscaled: 1n, exponent: -1_000_000_000 }))).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('still returns zero at any scale, since zero is exactly integral everywhere', () => {
    expect(asLong(atomNode({ unscaled: 0n, exponent: 1_000_000_000 }))).toBe(0n);
    expect(asLong(atomNode({ unscaled: 0n, exponent: -1_000_000_000 }))).toBe(0n);
    expect(asInt(atomNode({ unscaled: 0n, exponent: 500 }))).toBe(0);
  });

  it('keeps answering ordinary values exactly', () => {
    expect(asLong(atomNode({ unscaled: 1n, exponent: 100 }))).toBe(10n ** 100n);
    expect(asLong(atomNode({ unscaled: 23456n, exponent: 2 }))).toBe(2345600n);
    expect(asLong(atomNode({ unscaled: 1230n, exponent: -1 }))).toBe(123n);
    expect(asInt(atomNode({ unscaled: 42n, exponent: 0 }))).toBe(42);
  });

  it('still rejects a genuinely fractional value', () => {
    expect(asLong(atomNode({ unscaled: 3456n, exponent: -1 }))).toBeUndefined();
    expect(asLong(atomNode({ unscaled: 1n, exponent: -1 }))).toBeUndefined();
  });
});
