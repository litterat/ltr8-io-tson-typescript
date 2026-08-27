import { describe, expect, it } from 'vitest';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import { createDecimalParser } from '../src/atom/numeric/decimal.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { DecimalType } from '../src/schema/meta/atoms-numeric.js';

// §5.6's `!number` atom -- the exact tier, defined against §7.6's integer/float productions only.

function token(text: string): AtomToken {
  return { text, form: 'unquoted' };
}

const UNCONSTRAINED: DecimalType = { kind: 'decimal_type' };

describe('§5.6 !number -- exactness', () => {
  it('preserves a trailing zero a lossy float round-trip would normalize away', () => {
    const value = createDecimalParser('number', UNCONSTRAINED).read(token('199.90'));
    expect(value).toEqual({ unscaled: 19990n, exponent: -2 });
  });

  it('a plain integer token is exact too', () => {
    expect(createDecimalParser('number', UNCONSTRAINED).read(token('42'))).toEqual({
      unscaled: 42n,
      exponent: 0,
    });
  });
});

describe('§5.6 !number -- rejected forms (exact, not approximate)', () => {
  it("'!number, being exact, does not accept the special values' -- .inf is rejected, unlike float32/float64", () => {
    expect(() => createDecimalParser('number', UNCONSTRAINED).read(token('.inf'))).toThrow(
      TsonAtomParseError,
    );
  });

  it('does not accept based-integer either, unlike the integer atoms', () => {
    expect(() => createDecimalParser('number', UNCONSTRAINED).read(token('0xFF'))).toThrow(
      TsonAtomParseError,
    );
  });
});

describe('§5.6 !number -- decimal_type constraints', () => {
  it('min/max/multiple_of validate against the exact value', () => {
    const bounded: DecimalType = {
      kind: 'decimal_type',
      min: { unscaledValue: 0n, scale: 0 },
      max: { unscaledValue: 100n, scale: 0 },
      multipleOf: { unscaledValue: 5n, scale: 0 },
    };
    const parser = createDecimalParser('bounded', bounded);
    expect(parser.read(token('15'))).toEqual({ unscaled: 15n, exponent: 0 });
    expect(() => parser.read(token('-5'))).toThrow(TsonAtomValidationError);
    expect(() => parser.read(token('101'))).toThrow(TsonAtomValidationError);
    expect(() => parser.read(token('7'))).toThrow(TsonAtomValidationError);
  });

  it('total_digits bounds the significant digit count', () => {
    const limited: DecimalType = { kind: 'decimal_type', totalDigits: 3 };
    const parser = createDecimalParser('limited', limited);
    expect(parser.read(token('123'))).toEqual({ unscaled: 123n, exponent: 0 });
    expect(() => parser.read(token('1234'))).toThrow(TsonAtomValidationError);
  });

  it('fraction_digits bounds digits after the decimal point, clamped at 0 for a positive-exponent value', () => {
    const limited: DecimalType = { kind: 'decimal_type', fractionDigits: 2 };
    const parser = createDecimalParser('limited', limited);
    expect(parser.read(token('1.23'))).toEqual({ unscaled: 123n, exponent: -2 });
    expect(() => parser.read(token('1.234'))).toThrow(TsonAtomValidationError);
    // 1E+2 has scale -2 (exponent 2) -- a whole number with no fraction digits at all, not -2 of
    // them, so it must not be rejected by a fraction_digits: 2 bound.
    expect(parser.read(token('100'))).toEqual({ unscaled: 100n, exponent: 0 });
  });
});

describe('§5.6 !number -- write round-trips through read', () => {
  it('writes plain decimal notation that re-parses to an equal exact value', () => {
    const parser = createDecimalParser('number', UNCONSTRAINED);
    for (const text of ['199.90', '-0.005', '12300', '0']) {
      const value = parser.read(token(text));
      expect(parser.read(token(parser.write(value)))).toEqual(value);
    }
  });
});
