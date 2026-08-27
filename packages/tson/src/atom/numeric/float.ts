/**
 * Parses and validates against meta-kernel's `float_type` constructor (§5.6's `float32`/`float64`
 * atoms -- SQL's approximate tier, IEEE 754-2019) -- the port of `atom/FloatParser.java`.
 *
 * Accepts `integer`/`float`/`hex-float`/`special-value` forms (§7.6) -- the integer atoms'
 * `based-integer` is *not* accepted here, and `hex-float` *is*, the reverse of
 * {@link createIntegerParser}'s/{@link createDecimalParser}'s accepted-forms sets.
 *
 * **Host representation is a plain `number` at both widths** -- JS has one floating-point type,
 * so `binary32`'s narrower grid is enforced by rounding *through* it (`Math.fround`), not by a
 * distinct host type the way Java's `Float`/`Double` split demands.
 *
 * **Known, accepted host-parser gap (mirrors `CONFORMANCE.md`'s own "accepted, unfixable gap"
 * entries).** The reference implementation parses `binary32` text directly via
 * `Float.parseFloat`, a single correctly-rounded text-to-binary32 conversion. JS has no such
 * primitive -- only a text-to-`double` parser (`Number(text)`, correctly rounded) and a
 * double-to-`float32` rounder (`Math.fround`). Composing them is therefore *two* roundings where
 * Java does one, which can rarely (at a binary32 halfway case that also isn't a binary64 halfway
 * case) land one ULP away from the true single-rounding result -- "double rounding". Writing a
 * from-scratch correctly-rounded decimal/hex-float-to-binary32 converter to close this is judged
 * not worth it at this stage, the same call `CONFORMANCE.md` makes for `!uri`'s RFC-revision gap
 * and `!time`'s leap-second gap.
 */

import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import { narrowDecimal } from '../../base/numberNarrowing.js';
import { isHexFloat, tryParseNumber } from '../../base/numberGrammar.js';
import type { FloatFormat, FloatType } from '../../schema/meta/atoms-numeric.js';
import type { AtomToken, AtomType } from '../contract.js';
import { decimalOf, stripUnderscores } from './decimalMath.js';

const FLOAT32_MIN_NORMAL = 2 ** -126;
const FLOAT64_MIN_NORMAL = 2 ** -1022;

/** Rounds `value` onto `format`'s IEEE 754-2019 grid -- a no-op for `BINARY64`, `number`'s own grid. */
function roundToFormat(value: number, format: FloatFormat): number {
  return format === 'BINARY32' ? Math.fround(value) : value;
}

/**
 * The exact value `mantissa * 2^exp2` denotes, as the nearest `number` -- built as a decimal
 * scientific-notation string handed to the host's own correctly-rounded parser, exactly the
 * technique `base/numberNarrowing.ts`'s `exactDecimalOfDouble` uses in reverse: `2^-n = 5^n *
 * 10^-n` rewrites a negative binary exponent as an exact power of ten by supplying the missing
 * factors of five, so the only rounding happening anywhere in this function is the single,
 * correctly-rounded string-to-`number` conversion at the end.
 */
function hexMantissaToNumber(mantissa: bigint, exp2: number): number {
  if (mantissa === 0n) return 0;
  if (exp2 >= 0) {
    return Number(mantissa << BigInt(exp2));
  }
  const scaled = mantissa * 5n ** BigInt(-exp2);
  return Number(`${scaled.toString()}e${String(exp2)}`);
}

function isHexDigit(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

/**
 * `hex-float`'s value, once `isHexFloat` has already confirmed the shape (§7.6: `[sign] "0x" (
 * hex-digits ["." hex-digits] / "." hex-digits ) ("p"|"P") [sign] digits`). Re-scans by hand,
 * hand-written like every other production this port's numeric grammar touches (CLAUDE.md), not
 * a second copy of `numberScanner.ts`'s own boolean-only shape check -- that one has nothing to
 * extract (`base/numberGrammar.ts`'s own doc: "a shape check with no structural record").
 */
function parseHexFloatText(text: string): number {
  let at = 0;
  let negative = false;
  if (text.charAt(at) === '+') {
    at += 1;
  } else if (text.charAt(at) === '-') {
    negative = true;
    at += 1;
  }
  at += 2; // the already-validated "0x"/"0X" prefix -- radixPrefix() is lowercase-only, so exactly "0x".

  let integerDigits = '';
  while (at < text.length && isHexDigit(text.charAt(at))) {
    integerDigits += text.charAt(at);
    at += 1;
  }
  let fractionDigits = '';
  if (text.charAt(at) === '.') {
    at += 1;
    while (at < text.length && isHexDigit(text.charAt(at))) {
      fractionDigits += text.charAt(at);
      at += 1;
    }
  }
  at += 1; // "p"/"P"
  let exponentNegative = false;
  if (text.charAt(at) === '+') {
    at += 1;
  } else if (text.charAt(at) === '-') {
    exponentNegative = true;
    at += 1;
  }
  let exponentDigits = '';
  while (at < text.length && text.charAt(at) >= '0' && text.charAt(at) <= '9') {
    exponentDigits += text.charAt(at);
    at += 1;
  }

  const mantissaHex = integerDigits + fractionDigits || '0';
  const mantissa = BigInt(`0x${mantissaHex}`);
  const binaryExponent = exponentNegative ? -Number(exponentDigits) : Number(exponentDigits);
  const exp2 = binaryExponent - 4 * fractionDigits.length;
  const magnitude = hexMantissaToNumber(mantissa, exp2);
  return negative ? -magnitude : magnitude;
}

/** §7.6's `special-value` (`.nan`, `[sign] .inf`/`.infinity`) as the `number` it denotes. */
function specialToNumber(special: {
  readonly sign?: 'plus' | 'minus';
  readonly special: 'nan' | 'infinity';
}): number {
  if (special.special === 'nan') {
    return Number.NaN;
  }
  return special.sign === 'minus' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
}

function parseAtFormatPrecision(text: string, format: FloatFormat, typeRef: string): number {
  const form = tryParseNumber(text);
  if (form !== undefined) {
    if (form.kind === 'based-integer') {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' (a based-integer/hex/octal/binary whole number) is not accepted here -- only integer, float, hex-float, and special-value forms are (§5.6)`,
        'an integer, float, hex-float or special-value form',
      );
    }
    if (form.kind === 'special-value') {
      return specialToNumber(form);
    }
    // integer or float -- plain decimal text, parsed directly at this atom's own precision
    // rather than through an exact intermediate (see this module's own TSDoc for why: there is
    // no representation-equivalence requirement to preserve here, and `BigDecimal`-style routing
    // would lose the sign of a signed zero).
    return roundToFormat(Number(stripUnderscores(text)), format);
  }
  if (isHexFloat(text)) {
    return roundToFormat(parseHexFloatText(text), format);
  }
  throw new TsonAtomParseError(
    typeRef,
    `'${text}' does not match integer, float, hex-float, or special-value (§5.6)`,
    'an integer, float, hex-float or special-value form',
  );
}

/**
 * §7.6's `special-value` spelling (`.nan`/`+.inf`/`-.inf`) for the non-finite cases, `-0`/`0` for
 * signed zero (JS's own `(-0).toString()` drops the sign, unlike `Float.toString()`/
 * `Double.toString()`, so zero needs its own case), and `String(value)` otherwise -- already the
 * shortest decimal that reads back to the exact same `number`, which is what a round trip needs;
 * see this module's own TSDoc for why matching `Float.toString()`'s narrower binary32-shortest
 * text is not attempted here.
 */
function writeFloat(value: number): string {
  if (Number.isNaN(value)) {
    return '.nan';
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? '+.inf' : '-.inf';
  }
  if (value === 0) {
    return Object.is(value, -0) ? '-0' : '0';
  }
  return String(value);
}

function isSubnormal(value: number, format: FloatFormat): boolean {
  const magnitude = Math.abs(value);
  if (magnitude === 0) return false;
  return magnitude < (format === 'BINARY32' ? FLOAT32_MIN_NORMAL : FLOAT64_MIN_NORMAL);
}

/**
 * Builds the `AtomType` for one fully-parameterised `float_type` instance -- e.g. `float32 =>
 * !float_type { format: BINARY32 }`. See {@link createIntegerParser} for why `typeRef` is
 * required explicitly rather than derived the way `FloatParser.java`'s own `typeName()` derives
 * it from `format` -- kept uniform across every numeric factory in this directory rather than
 * exploiting the one field that happens to be available here.
 */
export function createFloatParser(typeRef: string, constraints: FloatType): AtomType<number> {
  function validate(value: number, text: string): void {
    if (Number.isNaN(value)) {
      if (!constraints.allowNan) {
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' is NaN, not permitted (allow_nan: false)`,
          'not NaN',
        );
      }
      return;
    }
    if (!Number.isFinite(value)) {
      if (!constraints.allowInfinity) {
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' is infinite, not permitted (allow_infinity: false)`,
          'a finite value',
        );
      }
      return;
    }
    if (!constraints.allowNegativeZero && Object.is(value, -0)) {
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is negative zero, not permitted (allow_negative_zero: false)`,
        'not negative zero',
      );
    }
    if (!constraints.allowSubnormal && isSubnormal(value, constraints.format)) {
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is a subnormal value, not permitted (allow_subnormal: false)`,
        'not a subnormal value',
      );
    }
    if (constraints.min !== undefined) {
      const bound = narrowDecimal(decimalOf(constraints.min), 'number');
      if (value < bound) {
        const b = String(bound);
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' is less than the minimum ${b}`,
          `>= ${b}`,
        );
      }
    }
    if (constraints.exclusiveMin !== undefined) {
      const bound = narrowDecimal(decimalOf(constraints.exclusiveMin), 'number');
      if (value <= bound) {
        const b = String(bound);
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' must be strictly greater than ${b}`,
          `> ${b}`,
        );
      }
    }
    if (constraints.max !== undefined) {
      const bound = narrowDecimal(decimalOf(constraints.max), 'number');
      if (value > bound) {
        const b = String(bound);
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' is greater than the maximum ${b}`,
          `<= ${b}`,
        );
      }
    }
    if (constraints.exclusiveMax !== undefined) {
      const bound = narrowDecimal(decimalOf(constraints.exclusiveMax), 'number');
      if (value >= bound) {
        const b = String(bound);
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' must be strictly less than ${b}`,
          `< ${b}`,
        );
      }
    }
  }

  return {
    read(token: AtomToken) {
      const value = parseAtFormatPrecision(token.text, constraints.format, typeRef);
      validate(value, token.text);
      return value;
    },
    write: writeFloat,
  };
}
