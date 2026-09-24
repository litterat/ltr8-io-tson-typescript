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

describe('deepEqual -- value identity, not spelling ([TSON-DATA] §2.6, §5.2; [TSON-SCHEMA] §5.5, §7.5)', () => {
  it('§5.6: scale is a spelling -- 1, 1.0 and 1.00 are one exact-decimal value', () => {
    expect(deepEqual({ unscaled: 1n, exponent: 0 }, { unscaled: 10n, exponent: -1 })).toBe(true);
    expect(deepEqual({ unscaled: 1n, exponent: 0 }, { unscaled: 100n, exponent: -2 })).toBe(true);
    expect(deepEqual({ unscaled: 10n, exponent: -1 }, { unscaled: 100n, exponent: -2 })).toBe(true);
  });

  it('§5.6: 199.90 and 199.9 are one decimal value', () => {
    expect(deepEqual({ unscaled: 19990n, exponent: -2 }, { unscaled: 1999n, exponent: -1 })).toBe(
      true,
    );
  });

  it('§5.6: a different exact value is still unequal once scale is normalised away', () => {
    expect(deepEqual({ unscaled: 1n, exponent: 0 }, { unscaled: 2n, exponent: 0 })).toBe(false);
    expect(deepEqual({ unscaled: 1n, exponent: 0 }, { unscaled: 11n, exponent: -1 })).toBe(false);
  });

  it('§5.4: 10:00:00+01:00 and 09:00:00Z are one datetime -- offset is a spelling, not identity', () => {
    const a = {
      date: { year: 2026, month: 1, day: 1 },
      time: { hour: 10, minute: 0, second: 0, nanosecond: 0, offset: { totalMinutes: 60 } },
    };
    const b = {
      date: { year: 2026, month: 1, day: 1 },
      time: { hour: 9, minute: 0, second: 0, nanosecond: 0, offset: { totalMinutes: 0 } },
    };
    expect(deepEqual(a, b)).toBe(true);
  });

  // §5.4's "-00:00 (offset unknown) is the same instant as Z" is a parser-level guarantee, not
  // one this module can test: `UtcOffset.totalMinutes` (`value/types.ts`) already represents both
  // spellings as `0` by the time a value reaches this module, so there is no distinguishable input
  // left here to compare -- the parse from `-00:00` to `totalMinutes: 0` is where that rule lives.

  it('§5.4: a datetime a day apart in UTC instant is unequal, whatever the local wall-clock reads', () => {
    const a = {
      date: { year: 2026, month: 1, day: 1 },
      time: { hour: 23, minute: 0, second: 0, nanosecond: 0, offset: { totalMinutes: 0 } },
    };
    const b = {
      date: { year: 2026, month: 1, day: 2 },
      time: { hour: 23, minute: 0, second: 0, nanosecond: 0, offset: { totalMinutes: 0 } },
    };
    expect(deepEqual(a, b)).toBe(false);
  });

  it('§5.4: a bare time-of-day compares as UTC time-of-day, wrapping across the day boundary -- 23:30:00-02:00 is 01:30:00Z', () => {
    const a = { hour: 23, minute: 30, second: 0, nanosecond: 0, offset: { totalMinutes: -120 } };
    const b = { hour: 1, minute: 30, second: 0, nanosecond: 0, offset: { totalMinutes: 0 } };
    expect(deepEqual(a, b)).toBe(true);
  });

  it('§5.4: a bare time with no offset difference at all compares equal, and a genuinely different time-of-day does not', () => {
    const a = { hour: 10, minute: 0, second: 0, nanosecond: 0, offset: { totalMinutes: 60 } };
    const b = { hour: 9, minute: 0, second: 0, nanosecond: 0, offset: { totalMinutes: 0 } };
    const c = { hour: 9, minute: 1, second: 0, nanosecond: 0, offset: { totalMinutes: 0 } };
    expect(deepEqual(a, b)).toBe(true);
    expect(deepEqual(a, c)).toBe(false);
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
