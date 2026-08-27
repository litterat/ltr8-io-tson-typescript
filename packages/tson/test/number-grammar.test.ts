import { describe, expect, it } from 'vitest';
import {
  isHexFloat,
  tryParseComplex,
  tryParseNumber,
  tryParseRational,
  type BasedIntegerForm,
  type FloatForm,
  type IntegerForm,
  type SpecialValueForm,
} from '../src/base/numberGrammar.js';

// §7.6's `number` grammar, recognised in full against a token's complete text (§4.3). The four
// alternatives -- special-value, based-integer, float, integer -- are pairwise disjoint.

/** Narrows `value` away from `undefined`, failing the test with a clear message if it is one. */
function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a value, got undefined');
  }
  return value;
}

describe('integer (§7.6)', () => {
  it('matches a plain unsigned integer', () => {
    const form = tryParseNumber('42') as IntegerForm;
    expect(form.kind).toBe('integer');
    expect(form.sign).toBeUndefined();
    expect(form.digits).toBe('42');
  });

  it('a single zero is valid, but no other leading zero is (§4.3: "no leading zeros")', () => {
    const form = tryParseNumber('0') as IntegerForm;
    expect(form.digits).toBe('0');
    expect(tryParseNumber('007')).toBeUndefined();
    expect(tryParseNumber('00')).toBeUndefined();
    expect(tryParseNumber('01')).toBeUndefined();
  });

  it('accepts an optional leading sign', () => {
    expect((tryParseNumber('+42') as IntegerForm).sign).toBe('plus');
    expect((tryParseNumber('-42') as IntegerForm).sign).toBe('minus');
  });

  it(`underscore separates digits, only between digits (§7.6: 'digits = DIGIT *(["_"] DIGIT)')`, () => {
    expect((tryParseNumber('1_000_000') as IntegerForm).digits).toBe('1_000_000');
    expect(tryParseNumber('1__000')).toBeUndefined();
    expect(tryParseNumber('100_')).toBeUndefined();
    expect(tryParseNumber('_100')).toBeUndefined();
  });

  it('the bare tokens "-", "+", "." do not exist as numbers (§4.4)', () => {
    expect(tryParseNumber('-')).toBeUndefined();
    expect(tryParseNumber('+')).toBeUndefined();
    expect(tryParseNumber('.')).toBeUndefined();
  });
});

describe('based-integer (§7.6)', () => {
  it('recognizes hex, octal, and binary by their lowercase prefix', () => {
    const hex = tryParseNumber('0xFF') as BasedIntegerForm;
    expect(hex.radix).toBe('hex');
    expect(hex.digits).toBe('FF');

    const octal = tryParseNumber('0o755') as BasedIntegerForm;
    expect(octal.radix).toBe('octal');
    expect(octal.digits).toBe('755');

    const binary = tryParseNumber('0b1010') as BasedIntegerForm;
    expect(binary.radix).toBe('binary');
    expect(binary.digits).toBe('1010');
  });

  it('hex digits admit both cases (§7.6: "HEXDIG admits both cases")', () => {
    expect((tryParseNumber('0xFf1a') as BasedIntegerForm).digits).toBe('Ff1a');
  });

  it('the prefix itself is lowercase only (§7.6: "prefixes are lowercase")', () => {
    expect(tryParseNumber('0XFF')).toBeUndefined();
  });

  it('accepts an optional leading sign', () => {
    expect((tryParseNumber('-0x1A') as BasedIntegerForm).sign).toBe('minus');
  });

  it('a radix prefix requires at least one digit of its own', () => {
    expect(tryParseNumber('0x')).toBeUndefined();
    expect(tryParseNumber('0o')).toBeUndefined();
    expect(tryParseNumber('0b')).toBeUndefined();
  });

  it('a consumed prefix is put back when no digit follows, so the decimal alternative still sees the "0"', () => {
    // Without backtracking, "0o9" would scan as the integer 9 with the prefix silently eaten --
    // and the leftover "9" would make it fail the full-token match anyway, but for the wrong
    // reason. Either way it must not match.
    expect(tryParseNumber('0o9')).toBeUndefined();
    expect(tryParseNumber('0b2')).toBeUndefined();
    expect(tryParseNumber('0xG')).toBeUndefined();
  });

  it("§4.3's own trap: hex-shaped identifier data resolves as a number when unquoted", () => {
    expect(tryParseNumber('0x71C7656EC7ab88b098defB751B7401B5f6d8976F')).toBeDefined();
  });
});

describe('float (§7.6)', () => {
  it('an integer part with a fraction', () => {
    const f = tryParseNumber('1.5') as FloatForm;
    expect(f.integerPart).toBe('1');
    expect(f.fractionDigits).toBe('5');
    expect(f.exponent).toBeUndefined();
  });

  it('a leading-dot fraction with no integer part (§4.3: "the integer part MAY be omitted")', () => {
    const f = tryParseNumber('.5') as FloatForm;
    expect(f.integerPart).toBeUndefined();
    expect(f.fractionDigits).toBe('5');
  });

  it('a fraction with an exponent, upper- or lowercase e', () => {
    const f = tryParseNumber('6.02e23') as FloatForm;
    expect(f.integerPart).toBe('6');
    expect(f.fractionDigits).toBe('02');
    expect(f.exponent).toEqual({ digits: '23' });
    expect(tryParseNumber('1E10')).toBeDefined();
  });

  it('a signed exponent', () => {
    const f = tryParseNumber('-2e-3') as FloatForm;
    expect(f.sign).toBe('minus');
    expect(f.fractionDigits).toBeUndefined();
    expect(f.exponent).toEqual({ sign: 'minus', digits: '3' });
  });

  it('an integer part with a mandatory exponent and no dot', () => {
    const f = tryParseNumber('1e10') as FloatForm;
    expect(f.integerPart).toBe('1');
    expect(f.fractionDigits).toBeUndefined();
    expect(f.exponent?.digits).toBe('10');
  });

  it('signed zero floats preserve their sign (§4.3: "MUST be preserved")', () => {
    expect((tryParseNumber('+0.0') as FloatForm).sign).toBe('plus');
    expect((tryParseNumber('-0.0') as FloatForm).sign).toBe('minus');
  });

  it('"5." is not a number -- digits MUST follow a decimal point (§4.3)', () => {
    expect(tryParseNumber('5.')).toBeUndefined();
  });

  it('a second dot is rejected (§4.4\'s own example, "1.2.3")', () => {
    expect(tryParseNumber('1.2.3')).toBeUndefined();
  });
});

describe('special-value (§7.6)', () => {
  it('recognizes .inf and .infinity as infinity', () => {
    expect((tryParseNumber('.inf') as SpecialValueForm).special).toBe('infinity');
    expect((tryParseNumber('.infinity') as SpecialValueForm).special).toBe('infinity');
  });

  it('infinity accepts an optional sign', () => {
    expect((tryParseNumber('-.inf') as SpecialValueForm).sign).toBe('minus');
    expect((tryParseNumber('+.infinity') as SpecialValueForm).sign).toBe('plus');
  });

  it('recognizes .nan, and .nan is never signed (concatenation binds tighter than alternation)', () => {
    const f = tryParseNumber('.nan') as SpecialValueForm;
    expect(f.special).toBe('nan');
    expect(f.sign).toBeUndefined();
    expect(tryParseNumber('+.nan')).toBeUndefined();
    expect(tryParseNumber('-.nan')).toBeUndefined();
  });

  it('special-value names are lowercase only', () => {
    expect(tryParseNumber('.Inf')).toBeUndefined();
    expect(tryParseNumber('.NAN')).toBeUndefined();
    expect(tryParseNumber('.Infinity')).toBeUndefined();
  });
});

describe('non-numeric fall-through (§4.4)', () => {
  it('a complex-shaped token does not match the base number grammar', () => {
    // §4.3: complex tokens are expressible unquoted and resolve as strings under base resolution.
    expect(tryParseNumber('3+4i')).toBeUndefined();
  });

  it('plain words, dates, and version-like tokens do not match', () => {
    expect(tryParseNumber('GOLD')).toBeUndefined();
    expect(tryParseNumber('A-100')).toBeUndefined();
    expect(tryParseNumber('2025-03-13')).toBeUndefined();
    expect(tryParseNumber('v1.2.3')).toBeUndefined();
  });

  it('the empty string does not match', () => {
    expect(tryParseNumber('')).toBeUndefined();
  });
});

describe('equivalent representations all recognize (§4.3 requires them equal; recognition alone is checked here)', () => {
  it.each(['255', '0xFF', '6.02e23', '602e21', '.5', '0.5', '1_000', '1000', '+42', '42'])(
    '%s is recognized as a number',
    (text) => {
      expect(tryParseNumber(text)).toBeDefined();
    },
  );
});

describe('extended forms are not part of `number` (§7.6: "reachable only through the type vocabulary")', () => {
  it('hex-float, rational, and complex all fail the base number grammar', () => {
    expect(tryParseNumber('0x1.8p3')).toBeUndefined();
    expect(tryParseNumber('2/3')).toBeUndefined();
    expect(tryParseNumber('3+4i')).toBeUndefined();
  });
});

describe('hex-float (§7.6, extended form)', () => {
  it('recognizes the mandatory p-exponent forms', () => {
    expect(isHexFloat('0x1.8p3')).toBe(true);
    expect(isHexFloat('0x.8p1')).toBe(true);
    expect(isHexFloat('-0x1p-1074')).toBe(true);
  });

  it('rejects a based-integer with no p-exponent, and a plain decimal float', () => {
    expect(isHexFloat('0xFF')).toBe(false);
    expect(isHexFloat('1.5')).toBe(false);
  });
});

describe('rational (§7.6, extended form)', () => {
  it('splits into numerator and denominator, sign applying to the numerator only', () => {
    const f = tryParseRational('2/3');
    expect(f).toEqual({ numerator: '2', denominator: '3' });

    const signed = tryParseRational('-2/3');
    expect(signed).toEqual({ sign: 'minus', numerator: '2', denominator: '3' });
  });

  it('the numerator may be zero, but the denominator never can (no "0" alternative)', () => {
    expect(tryParseRational('0/5')?.numerator).toBe('0');
    expect(tryParseRational('1/0')).toBeUndefined();
    expect(tryParseRational('1/05')).toBeUndefined();
  });

  it('the denominator cannot itself be signed', () => {
    expect(tryParseRational('1/-3')).toBeUndefined();
  });

  it('the denominator accepts underscore separators like any other digit run', () => {
    expect(tryParseRational('1/1_000')?.denominator).toBe('1_000');
  });
});

describe('complex (§7.6, extended form)', () => {
  it('the two-part form', () => {
    const f = must(tryParseComplex('3+4i'));
    expect(f.realSign).toBeUndefined();
    expect(f.realMagnitude).toBe('3');
    expect(f.imaginarySign).toBe('plus');
    expect(f.imaginaryMagnitude).toBe('4');
  });

  it('the two-part form with a negative real part and a re-signed exponent-bearing imaginary part', () => {
    const f = must(tryParseComplex('-3.5-2e1j'));
    expect(f.realSign).toBe('minus');
    expect(f.realMagnitude).toBe('3.5');
    expect(f.imaginarySign).toBe('minus');
    expect(f.imaginaryMagnitude).toBe('2e1');
  });

  it('the middle sign is mandatory -- no separator at all does not match', () => {
    expect(tryParseComplex('3 4i')).toBeUndefined();
  });

  it('a magnitude may be zero-led, in either alternative', () => {
    expect(tryParseComplex('0.5i')?.imaginaryMagnitude).toBe('0.5');
    expect(tryParseComplex('0e3j')?.imaginaryMagnitude).toBe('0e3');
    const twoPart = must(tryParseComplex('0.5-0.25i'));
    expect(twoPart.realMagnitude).toBe('0.5');
    expect(twoPart.imaginaryMagnitude).toBe('0.25');
  });

  it('the imaginary-only form, with the real part implicitly absent (not zero)', () => {
    const f = must(tryParseComplex('4i'));
    expect(f.realSign).toBeUndefined();
    expect(f.realMagnitude).toBeUndefined();
    expect(f.imaginarySign).toBeUndefined();
    expect(f.imaginaryMagnitude).toBe('4');
  });

  it('the imaginary-only form carries a sign on the magnitude itself', () => {
    const f = must(tryParseComplex('-2.5j'));
    expect(f.realMagnitude).toBeUndefined();
    expect(f.imaginarySign).toBe('minus');
    expect(f.imaginaryMagnitude).toBe('2.5');
  });

  it('a magnitude with no trailing imag-unit does not match at all', () => {
    expect(tryParseComplex('3+4')).toBeUndefined();
  });

  it('magnitude accepts a bare natural number with no dot or exponent, unlike base float', () => {
    const f = must(tryParseComplex('3+4i'));
    expect(f.realMagnitude).toBe('3');
    expect(f.imaginaryMagnitude).toBe('4');
  });
});
