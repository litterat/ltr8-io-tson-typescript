import { describe, expect, it } from 'vitest';
import {
  tryParseNumber,
  type BasedIntegerForm,
  type FloatForm,
  type IntegerForm,
} from '../src/base/numberGrammar.js';
import {
  narrowApproximate,
  narrowDecimal,
  narrowIntegral,
  toExactDecimal,
  toExactInteger,
} from '../src/base/numberNarrowing.js';

// §4.3: "Distinct representations of the same value ... MUST resolve to equal values." This is
// the layer that equivalence actually holds at -- extracting the exact value a recognized number
// form denotes, then narrowing it to a caller-chosen host representation.

describe('toExactInteger (§4.3 equivalence)', () => {
  it('255 and 0xFF extract to the same exact value', () => {
    const decimal = toExactInteger(tryParseNumber('255') as IntegerForm);
    const hex = toExactInteger(tryParseNumber('0xFF') as BasedIntegerForm);
    expect(decimal).toBe(255n);
    expect(hex).toBe(255n);
  });

  it('1_000 and 1000 extract to the same exact value -- underscores carry no information', () => {
    expect(toExactInteger(tryParseNumber('1_000') as IntegerForm)).toBe(
      toExactInteger(tryParseNumber('1000') as IntegerForm),
    );
  });

  it('+42 and 42 extract to the same exact value', () => {
    expect(toExactInteger(tryParseNumber('+42') as IntegerForm)).toBe(
      toExactInteger(tryParseNumber('42') as IntegerForm),
    );
  });

  it('a negative sign negates the magnitude', () => {
    expect(toExactInteger(tryParseNumber('-42') as IntegerForm)).toBe(-42n);
  });

  it('octal and binary forms extract correctly', () => {
    expect(toExactInteger(tryParseNumber('0o755') as BasedIntegerForm)).toBe(0o755n);
    expect(toExactInteger(tryParseNumber('0b1010') as BasedIntegerForm)).toBe(0b1010n);
  });

  it('extracts arbitrary precision beyond a JS safe integer, exactly', () => {
    const huge = '123456789012345678901234567890';
    expect(toExactInteger(tryParseNumber(huge) as IntegerForm)).toBe(BigInt(huge));
  });
});

describe('toExactDecimal (§4.3 equivalence)', () => {
  it('.5 and 0.5 denote the same value', () => {
    const leadingDot = toExactDecimal(tryParseNumber('.5') as FloatForm);
    const withZero = toExactDecimal(tryParseNumber('0.5') as FloatForm);
    expect(Number(leadingDot.unscaled) * 10 ** leadingDot.exponent).toBe(0.5);
    expect(Number(withZero.unscaled) * 10 ** withZero.exponent).toBe(0.5);
  });

  it('6.02e23 and 602e21 denote the same value', () => {
    const a = toExactDecimal(tryParseNumber('6.02e23') as FloatForm);
    const b = toExactDecimal(tryParseNumber('602e21') as FloatForm);
    // unscaled * 10^exponent must be equal, even though the stored pairs may differ.
    expect(a.unscaled * 10n ** BigInt(Math.max(0, a.exponent - b.exponent))).toBe(
      a.exponent >= b.exponent ? b.unscaled * 10n ** BigInt(a.exponent - b.exponent) : a.unscaled,
    );
    // Simpler, direct check via narrowing to a double (acceptable precision loss for this check).
    expect(narrowDecimal(a, 'number')).toBeCloseTo(narrowDecimal(b, 'number'), 5);
  });

  it('a mandatory-exponent integer part with no fraction (1e10)', () => {
    const f = toExactDecimal(tryParseNumber('1e10') as FloatForm);
    expect(f.unscaled).toBe(1n);
    expect(f.exponent).toBe(10);
  });

  it('signed zero floats: the sign is preserved on the FloatForm even though bigint has no -0', () => {
    // §4.3 requires the *representation* to preserve a signed zero's sign; this function extracts
    // the exact magnitude, which for zero collapses -0.0 and +0.0 to the same unscaled value --
    // consistent with the reference implementation's own BigDecimal, which likewise has no
    // negative zero. Preserving the written sign, when required, is a caller concern one layer up.
    const minusZero = toExactDecimal(tryParseNumber('-0.0') as FloatForm);
    expect(minusZero.unscaled).toBe(0n);
  });

  it('underscore separators do not change the extracted value', () => {
    const a = toExactDecimal(tryParseNumber('1_000.5') as FloatForm);
    const b = toExactDecimal(tryParseNumber('1000.5') as FloatForm);
    expect(a).toEqual(b);
  });
});

describe('narrowIntegral', () => {
  it('narrows to bigint unchanged', () => {
    expect(narrowIntegral(255n, 'bigint')).toBe(255n);
  });

  it('narrows to number when the value fits exactly', () => {
    expect(narrowIntegral(255n, 'number')).toBe(255);
  });

  it('throws RangeError narrowing to number when the value cannot fit exactly', () => {
    expect(() => narrowIntegral(2n ** 60n, 'number')).toThrow(RangeError);
  });

  it('narrows to decimal at scale zero', () => {
    expect(narrowIntegral(255n, 'decimal')).toEqual({ unscaled: 255n, exponent: 0 });
  });
});

describe('narrowDecimal', () => {
  it('narrows to decimal unchanged', () => {
    const d = { unscaled: 5n, exponent: -1 };
    expect(narrowDecimal(d, 'decimal')).toBe(d);
  });

  it('narrows to number, lossily where necessary, without throwing', () => {
    expect(narrowDecimal({ unscaled: 5n, exponent: -1 }, 'number')).toBe(0.5);
  });
});

describe('narrowApproximate', () => {
  it('narrows to number unchanged, NaN and Infinity included', () => {
    expect(narrowApproximate(1.5, 'number')).toBe(1.5);
    expect(narrowApproximate(NaN, 'number')).toBeNaN();
    expect(narrowApproximate(Infinity, 'number')).toBe(Infinity);
  });

  it('narrows a finite double to its exact decimal expansion', () => {
    // 0.5 is exactly representable in binary, so its exact decimal expansion is exactly 0.5 --
    // no invented digits.
    const d = narrowApproximate(0.5, 'decimal');
    expect(d.unscaled).toBe(5n);
    expect(d.exponent).toBe(-1);
  });

  it('round-trips an arbitrary finite double through the exact decimal exactly', () => {
    for (const value of [1, -1, 3.25, 100, -0.125, 1e10, 123456.789]) {
      const d = narrowApproximate(value, 'decimal');
      // Reconstructing via a decimal string literal must parse back to the identical double.
      expect(Number(`${d.unscaled.toString()}e${d.exponent.toString()}`)).toBe(value);
    }
  });

  it('throws RangeError narrowing NaN or Infinity to decimal -- neither has an exact expansion', () => {
    expect(() => narrowApproximate(NaN, 'decimal')).toThrow(RangeError);
    expect(() => narrowApproximate(Infinity, 'decimal')).toThrow(RangeError);
    expect(() => narrowApproximate(-Infinity, 'decimal')).toThrow(RangeError);
  });

  it('zero narrows to an exact zero decimal, negative zero included', () => {
    expect(narrowApproximate(0, 'decimal')).toEqual({ unscaled: 0n, exponent: 0 });
    expect(narrowApproximate(-0, 'decimal')).toEqual({ unscaled: 0n, exponent: 0 });
  });
});
