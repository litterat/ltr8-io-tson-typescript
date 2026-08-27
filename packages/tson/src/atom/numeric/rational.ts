/**
 * Parses and validates against meta-kernel's `rational_type` constructor (§5.6's `rational` atom)
 * -- the port of `atom/RationalParser.java`.
 *
 * Accepts only the `rational` grammar form (§7.6) -- `"2/3"`, always quoted in practice since `/`
 * is outside the unquoted token profile (§7.1). This doesn't check {@link AtomToken.form} itself,
 * matching every other atom here (§5.2: "whether quoting is required is a lexical property of the
 * content, not of the atom").
 *
 * **Not normalised, but compared by value** (`value/types.ts`'s own `Rational` doc, pinned by the
 * conformance suite's `rational-negative-and-unreduced` vector): `numerator`/`denominator` are
 * preserved exactly as written, and every ordering/`multiple_of` check below compares by exact
 * value via cross-multiplication (`a/b` vs `c/d` as `a*d` vs `c*b`), never by first reducing
 * either side -- `-2/4` and `-1/2` compare equal without either being rewritten.
 */

import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import { tryParseRational, type Sign } from '../../base/numberGrammar.js';
import type { RationalType } from '../../schema/meta/atoms-numeric.js';
import type { Rational } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';
import { stripUnderscores } from './decimalMath.js';

/** `-1`/`0`/`1` as `a` is less than, equal to, or greater than `b`, by cross-multiplication (both denominators always positive). */
function compareRational(a: Rational, b: Rational): number {
  const lhs = a.numerator * b.denominator;
  const rhs = b.numerator * a.denominator;
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}

function applySign(sign: Sign | undefined, magnitude: bigint): bigint {
  return sign === 'minus' ? -magnitude : magnitude;
}

/** `numerator/denominator`, exactly as {@link Rational}'s own fields hold it. */
function formatRational(value: Rational): string {
  return `${String(value.numerator)}/${String(value.denominator)}`;
}

/**
 * Builds the `AtomType` for one fully-parameterised `rational_type` instance -- `rational =>
 * !rational_type {}` is the unconstrained case, `createRationalParser('rational', { kind:
 * 'rational_type' })`. See {@link createIntegerParser} for why `typeRef` is required explicitly.
 */
export function createRationalParser(
  typeRef: string,
  constraints: RationalType,
): AtomType<Rational> {
  function read(token: AtomToken): Rational {
    const text = token.text;
    const form = tryParseRational(text);
    if (form === undefined) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid rational -- expected numerator/denominator, e.g. "2/3" (§7.6)`,
        'a rational form',
      );
    }
    const numerator = applySign(form.sign, BigInt(stripUnderscores(form.numerator)));
    const denominator = BigInt(stripUnderscores(form.denominator));
    const value: Rational = { numerator, denominator };
    validate(value, text);
    return value;
  }

  function validate(value: Rational, text: string): void {
    const { min, exclusiveMin, max, exclusiveMax, multipleOf } = constraints;
    if (min !== undefined && compareRational(value, min) < 0) {
      const bound = formatRational(min);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is less than the minimum ${bound}`,
        `>= ${bound}`,
      );
    }
    if (exclusiveMin !== undefined && compareRational(value, exclusiveMin) <= 0) {
      const bound = formatRational(exclusiveMin);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' must be strictly greater than ${bound}`,
        `> ${bound}`,
      );
    }
    if (max !== undefined && compareRational(value, max) > 0) {
      const bound = formatRational(max);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is greater than the maximum ${bound}`,
        `<= ${bound}`,
      );
    }
    if (exclusiveMax !== undefined && compareRational(value, exclusiveMax) >= 0) {
      const bound = formatRational(exclusiveMax);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' must be strictly less than ${bound}`,
        `< ${bound}`,
      );
    }
    if (multipleOf !== undefined) {
      // value / m = (a/b) / (c/d) = (a*d) / (b*c) -- an integer iff (a*d) mod (b*c) == 0 (b*c is
      // always positive, both denominators being positive by construction).
      const lhs = value.numerator * multipleOf.denominator;
      const rhs = value.denominator * multipleOf.numerator;
      if (rhs === 0n || lhs % rhs !== 0n) {
        const of = formatRational(multipleOf);
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' is not a multiple of ${of}`,
          `a multiple of ${of}`,
        );
      }
    }
  }

  return {
    read,
    write: formatRational,
  };
}
