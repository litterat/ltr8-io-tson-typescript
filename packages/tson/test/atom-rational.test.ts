import { describe, expect, it } from 'vitest';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import { createRationalParser } from '../src/atom/numeric/rational.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { RationalType } from '../src/schema/meta/atoms-numeric.js';

// §5.6's `!rational` atom, defined against §7.6's `rational = [sign] decimal-natural "/"
// denominator` production.

function token(text: string): AtomToken {
  // Rational content contains '/', outside the unquoted profile (§7.1) -- always quoted in
  // practice, i.e. a single-line token; the parser doesn't consult `form` itself (§5.2).
  return { text, form: 'single-line' };
}

const UNCONSTRAINED: RationalType = { kind: 'rational_type' };

describe('§7.6 rational -- parsing', () => {
  it('parses numerator/denominator, sign on the numerator', () => {
    expect(createRationalParser('rational', UNCONSTRAINED).read(token('-2/3'))).toEqual({
      numerator: -2n,
      denominator: 3n,
    });
  });

  it('denominator = nonzero-digit ... -- a zero denominator fails the grammar itself, a parse error', () => {
    expect(() => createRationalParser('rational', UNCONSTRAINED).read(token('1/0'))).toThrow(
      TsonAtomParseError,
    );
  });

  it("!rational's accepted form is rational only -- a based-integer token is rejected", () => {
    expect(() => createRationalParser('rational', UNCONSTRAINED).read(token('0xFF'))).toThrow(
      TsonAtomParseError,
    );
  });
});

describe('§5.6 rational -- value equality, not representation equality', () => {
  it('meta.tn: rational tokens are not normalized (-2/4 round-trips as -2/4), but equality operates on the value', () => {
    const parser = createRationalParser('rational', UNCONSTRAINED);
    const value = parser.read(token('-2/4'));
    // The stored representation is exactly as written -- not silently reduced.
    expect(value).toEqual({ numerator: -2n, denominator: 4n });
    // But it compares equal (by value, cross-multiplication) to -1/2 for bound checking.
    const boundedAtMinusHalf: RationalType = {
      kind: 'rational_type',
      min: { numerator: -1n, denominator: 2n },
      max: { numerator: -1n, denominator: 2n },
    };
    expect(() =>
      createRationalParser('rational', boundedAtMinusHalf).read(token('-2/4')),
    ).not.toThrow();
  });
});

describe('§5.6 rational -- rational_type constraints', () => {
  it('min/max/multiple_of validate by exact value', () => {
    const bounded: RationalType = {
      kind: 'rational_type',
      min: { numerator: 0n, denominator: 1n },
      max: { numerator: 1n, denominator: 1n },
      multipleOf: { numerator: 1n, denominator: 6n },
    };
    const parser = createRationalParser('bounded', bounded);
    expect(parser.read(token('1/2'))).toEqual({ numerator: 1n, denominator: 2n });
    expect(() => parser.read(token('-1/2'))).toThrow(TsonAtomValidationError);
    expect(() => parser.read(token('2/1'))).toThrow(TsonAtomValidationError);
    expect(() => parser.read(token('1/4'))).toThrow(TsonAtomValidationError);
  });
});

describe('§5.6 rational -- write round-trips through read', () => {
  it('numerator/denominator, exactly as stored', () => {
    const parser = createRationalParser('rational', UNCONSTRAINED);
    expect(parser.write({ numerator: -2n, denominator: 4n })).toBe('-2/4');
    expect(parser.read(token(parser.write({ numerator: -2n, denominator: 4n })))).toEqual({
      numerator: -2n,
      denominator: 4n,
    });
  });
});
