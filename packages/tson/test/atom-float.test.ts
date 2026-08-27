import { describe, expect, it } from 'vitest';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import { createFloatParser } from '../src/atom/numeric/float.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { FloatType } from '../src/schema/meta/atoms-numeric.js';

// §5.6's float32/float64 atoms -- IEEE 754-2019's two built-in-annotated formats, defined against
// §7.6's integer/float/hex-float/special-value productions.

function token(text: string): AtomToken {
  return { text, form: 'unquoted' };
}

const UNCONSTRAINED_FLOAT: Omit<FloatType, 'format'> = {
  kind: 'float_type',
  allowNan: true,
  allowInfinity: true,
  allowSubnormal: true,
  allowNegativeZero: true,
};

const FLOAT32: FloatType = { ...UNCONSTRAINED_FLOAT, format: 'BINARY32' };
const FLOAT64: FloatType = { ...UNCONSTRAINED_FLOAT, format: 'BINARY64' };

describe('§5.6 float atoms -- accepted forms', () => {
  it('accepts a bare integer token', () => {
    expect(createFloatParser('float64', FLOAT64).read(token('42'))).toBe(42);
  });

  it('12.5 (= 12 + 2^-1) is exactly representable on the binary64 grid', () => {
    expect(createFloatParser('float64', FLOAT64).read(token('12.5'))).toBe(12.5);
  });

  it('-3.5 (= -(3 + 2^-1)) is exactly representable on the binary32 grid', () => {
    expect(createFloatParser('float32', FLOAT32).read(token('-3.5'))).toBe(-3.5);
  });

  it('0x1.8p3 = 1.5 * 2^3 = 12.0 (hex-float, only reachable through the float atoms)', () => {
    expect(createFloatParser('float64', FLOAT64).read(token('0x1.8p3'))).toBe(12);
  });

  it("0x.8p1 = 0.5 * 2^1 = 1.0 (hex-float's no-integer-part alternative)", () => {
    expect(createFloatParser('float32', FLOAT32).read(token('0x.8p1'))).toBe(1);
  });

  it('rejects a based-integer token -- accepted forms are integer/float/hex-float/special-value, not based-integer', () => {
    expect(() => createFloatParser('float64', FLOAT64).read(token('0xFF'))).toThrow(
      TsonAtomParseError,
    );
  });

  it('rejects a non-numeric token', () => {
    expect(() => createFloatParser('float32', FLOAT32).read(token('twelve'))).toThrow(
      TsonAtomParseError,
    );
  });
});

describe('§5.6 float atoms -- special values (§7.6, unlike !number)', () => {
  it('.nan, +.inf, -.inf resolve to their IEEE 754 host values', () => {
    const float64 = createFloatParser('float64', FLOAT64);
    expect(Number.isNaN(float64.read(token('.nan')))).toBe(true);
    expect(float64.read(token('+.inf'))).toBe(Number.POSITIVE_INFINITY);
    expect(float64.read(token('-.inf'))).toBe(Number.NEGATIVE_INFINITY);
  });

  it('allow_nan: false rejects .nan', () => {
    const noNan: FloatType = { ...FLOAT64, allowNan: false };
    expect(() => createFloatParser('float64', noNan).read(token('.nan'))).toThrow(
      TsonAtomValidationError,
    );
  });

  it('allow_infinity: false rejects +.inf', () => {
    const noInf: FloatType = { ...FLOAT64, allowInfinity: false };
    expect(() => createFloatParser('float64', noInf).read(token('+.inf'))).toThrow(
      TsonAtomValidationError,
    );
  });

  it('allow_negative_zero: false rejects -0.0 but not +0.0', () => {
    const noNegZero: FloatType = { ...FLOAT64, allowNegativeZero: false };
    const parser = createFloatParser('float64', noNegZero);
    expect(() => parser.read(token('-0.0'))).toThrow(TsonAtomValidationError);
    expect(parser.read(token('0.0'))).toBe(0);
  });

  it('allow_subnormal: false rejects a subnormal binary32 value', () => {
    const noSubnormal: FloatType = { ...FLOAT32, allowSubnormal: false };
    // 2^-140 is far below binary32's minimum normal (2^-126).
    expect(() => createFloatParser('float32', noSubnormal).read(token('0x1p-140'))).toThrow(
      TsonAtomValidationError,
    );
  });
});

describe('§5.6 float atoms -- bounds', () => {
  it('min/max reject values outside the declared range', () => {
    const bounded: FloatType = {
      ...FLOAT64,
      min: { unscaledValue: 0n, scale: 0 },
      max: { unscaledValue: 100n, scale: 0 },
    };
    const parser = createFloatParser('float64', bounded);
    expect(parser.read(token('50'))).toBe(50);
    expect(() => parser.read(token('-1'))).toThrow(TsonAtomValidationError);
    expect(() => parser.read(token('101'))).toThrow(TsonAtomValidationError);
  });
});

describe('§5.6 float atoms -- write round-trips through read', () => {
  it('a written non-finite/negative-zero/finite value re-parses to the same bits', () => {
    const parser = createFloatParser('float64', FLOAT64);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 1.5]) {
      const text = parser.write(value);
      const roundTripped = parser.read(token(text));
      if (Number.isNaN(value)) {
        expect(Number.isNaN(roundTripped)).toBe(true);
      } else {
        expect(Object.is(roundTripped, value)).toBe(true);
      }
    }
  });
});
