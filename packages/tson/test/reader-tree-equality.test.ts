import { describe, expect, it } from 'vitest';
import { deepEqual, valuesEqual } from '../src/reader/tree/equality.js';
import { atomNode, recordNode } from '../src/tree/nodes.js';

/** `reader/tree/equality.ts` -- the structural comparison `record.ts`'s FIXED-field check needs (§5.2). */

describe('deepEqual', () => {
  it('compares primitives, bigint and Uint8Array structurally', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(1n, 1n)).toBe(true);
    expect(deepEqual(1n, 1)).toBe(false); // a bigint and a number are never the same value here
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
  });

  it('compares plain objects field-by-field, order-independent', () => {
    expect(deepEqual({ unscaled: 1n, exponent: 0 }, { exponent: 0, unscaled: 1n })).toBe(true);
    expect(deepEqual({ unscaled: 1n, exponent: 0 }, { unscaled: 2n, exponent: 0 })).toBe(false);
  });

  it('compares arrays element-wise', () => {
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([1, 2], [1, 3])).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });
});

describe('valuesEqual over Value trees', () => {
  it('two atoms are equal exactly when their host value and typeRef agree', () => {
    expect(valuesEqual(atomNode(42n, 'int32'), atomNode(42n, 'int32'))).toBe(true);
    expect(valuesEqual(atomNode(42n, 'int32'), atomNode(7n, 'int32'))).toBe(false);
  });

  it('two records are equal exactly when their fields agree', () => {
    const a = recordNode(new Map([['x', atomNode(1n)]]), 'point');
    const b = recordNode(new Map([['x', atomNode(1n)]]), 'point');
    const c = recordNode(new Map([['x', atomNode(2n)]]), 'point');
    expect(valuesEqual(a, b)).toBe(true);
    expect(valuesEqual(a, c)).toBe(false);
  });
});
