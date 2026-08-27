/**
 * Parses and validates against meta-kernel's `decimal_type` constructor (§5.6's `number` atom --
 * SQL's exact tier, ISO/IEC 11404 `scaled`) -- the port of `atom/DecimalParser.java`.
 *
 * Accepts only `integer`/`float` forms (§7.6) -- unlike {@link createIntegerParser}, no
 * `based-integer` either, and unlike {@link createFloatParser}, no `hex-float` or
 * `special-value`: "`!number`, being exact, does not accept the special values" (§5.6). The value
 * is preserved exactly as written, never rounded -- {@link TsonDecimal} (`value/types.ts`) is
 * this atom's own host shape, chosen for exactly this reason.
 */

import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import { toExactDecimal, toExactInteger } from '../../base/numberNarrowing.js';
import { tryParseNumber } from '../../base/numberGrammar.js';
import type { DecimalType } from '../../schema/meta/atoms-numeric.js';
import type { TsonDecimal } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';
import {
  compareDecimal,
  decimalFractionDigits,
  decimalOf,
  decimalPrecision,
  isDecimalMultiple,
  writeDecimal,
} from './decimalMath.js';

export { writeDecimal };

/**
 * Builds the `AtomType` for one fully-parameterised `decimal_type` instance -- `number =>
 * !decimal_type {}` is the unconstrained case, `createDecimalParser('number', { kind:
 * 'decimal_type' })`. See {@link createIntegerParser} for why `typeRef` is required explicitly.
 */
export function createDecimalParser(
  typeRef: string,
  constraints: DecimalType,
): AtomType<TsonDecimal> {
  function readExact(token: AtomToken): TsonDecimal {
    const text = token.text;
    const form = tryParseNumber(text);
    if (form === undefined || (form.kind !== 'integer' && form.kind !== 'float')) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid exact number -- only integer and float forms are accepted (§5.6); !number does not accept based-integer or the special values`,
        'an integer or float form',
      );
    }
    const exact: TsonDecimal =
      form.kind === 'integer'
        ? { unscaled: toExactInteger(form), exponent: 0 }
        : toExactDecimal(form);
    validate(exact, text);
    return exact;
  }

  function validate(value: TsonDecimal, text: string): void {
    const { min, exclusiveMin, max, exclusiveMax, multipleOf, totalDigits, fractionDigits } =
      constraints;
    if (min !== undefined && compareDecimal(value, decimalOf(min)) < 0) {
      const bound = writeDecimal(decimalOf(min));
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is less than the minimum ${bound}`,
        `>= ${bound}`,
      );
    }
    if (exclusiveMin !== undefined && compareDecimal(value, decimalOf(exclusiveMin)) <= 0) {
      const bound = writeDecimal(decimalOf(exclusiveMin));
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' must be strictly greater than ${bound}`,
        `> ${bound}`,
      );
    }
    if (max !== undefined && compareDecimal(value, decimalOf(max)) > 0) {
      const bound = writeDecimal(decimalOf(max));
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is greater than the maximum ${bound}`,
        `<= ${bound}`,
      );
    }
    if (exclusiveMax !== undefined && compareDecimal(value, decimalOf(exclusiveMax)) >= 0) {
      const bound = writeDecimal(decimalOf(exclusiveMax));
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' must be strictly less than ${bound}`,
        `< ${bound}`,
      );
    }
    if (multipleOf !== undefined && !isDecimalMultiple(value, decimalOf(multipleOf))) {
      const of = writeDecimal(decimalOf(multipleOf));
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is not a multiple of ${of}`,
        `a multiple of ${of}`,
      );
    }
    if (totalDigits !== undefined && decimalPrecision(value.unscaled) > totalDigits) {
      const limit = String(totalDigits);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' has more than the maximum ${limit} total significant digits`,
        `at most ${limit} total significant digits`,
      );
    }
    if (fractionDigits !== undefined && decimalFractionDigits(value) > fractionDigits) {
      const limit = String(fractionDigits);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' has more than the maximum ${limit} digits after the decimal point`,
        `at most ${limit} digits after the decimal point`,
      );
    }
  }

  return {
    read: readExact,
    write: writeDecimal,
  };
}
