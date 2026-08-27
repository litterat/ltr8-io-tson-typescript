/**
 * Exact-decimal arithmetic shared by every numeric atom that carries a `!number`-shaped bound or
 * value: {@link DecimalParser} itself, and {@link FloatParser}/{@link ComplexParser}'s use of the
 * same {@link TsonDecimal} host shape for bounds and components. Kept as one small module rather
 * than duplicated per caller, mirroring `java.math.BigDecimal`'s role in the reference
 * implementation -- `value/types.ts`'s own doc records why a plain `number` cannot stand in for
 * it (binary floating point cannot represent most decimal fractions exactly, and an integer past
 * 2^53 silently loses precision).
 *
 * Every operation here works by aligning two {@link TsonDecimal}s to their shared minimum
 * exponent first, exactly `BigDecimal.compareTo`/`BigDecimal.remainder`'s own strategy: both
 * values are integers once so aligned, so ordinary `bigint` comparison and truncating remainder
 * decide the exact-decimal question without any rounding.
 */

import type { Decimal } from '../../schema/meta/algebra.js';
import type { TsonDecimal } from '../../value/types.js';

/** `schema/meta`'s `Decimal` (`unscaledValue x 10^-scale`) as this package's own {@link TsonDecimal}. */
export function decimalOf(bound: Decimal): TsonDecimal {
  return { unscaled: bound.unscaledValue, exponent: -bound.scale };
}

/** Scales `a` and `b` to their shared minimum exponent, both as exact `bigint`s. */
function alignedPair(a: TsonDecimal, b: TsonDecimal): readonly [bigint, bigint] {
  const exponent = Math.min(a.exponent, b.exponent);
  const scaledA = a.unscaled * 10n ** BigInt(a.exponent - exponent);
  const scaledB = b.unscaled * 10n ** BigInt(b.exponent - exponent);
  return [scaledA, scaledB];
}

/** `-1`/`0`/`1` as `a` is less than, equal to, or greater than `b`, comparing exact value, not representation. */
export function compareDecimal(a: TsonDecimal, b: TsonDecimal): number {
  const [scaledA, scaledB] = alignedPair(a, b);
  if (scaledA < scaledB) return -1;
  if (scaledA > scaledB) return 1;
  return 0;
}

/** Whether `value` is an exact integer multiple of `of`, by exact value (not by matching scale). */
export function isDecimalMultiple(value: TsonDecimal, of: TsonDecimal): boolean {
  const [scaledValue, scaledOf] = alignedPair(value, of);
  return scaledValue % scaledOf === 0n;
}

/**
 * `BigDecimal.precision()`'s equivalent: the count of significant digits in `unscaled`, ignoring
 * sign -- `0` has precision `1` (a single significant digit), matching `BigDecimal`'s own
 * definition, which `DecimalType.totalDigits` bounds against.
 */
export function decimalPrecision(unscaled: bigint): number {
  const magnitude = unscaled < 0n ? -unscaled : unscaled;
  return magnitude === 0n ? 1 : magnitude.toString().length;
}

/**
 * `BigDecimal.scale()`'s equivalent, clamped at `0` the way `DecimalParser.validate`'s own
 * `fraction_digits` check does: `1E+2` has `exponent = 2` (scale `-2`, a whole number with no
 * fraction digits at all, not "-2 of them"), so a positive exponent contributes zero digits after
 * the point, never a negative count.
 */
export function decimalFractionDigits(value: TsonDecimal): number {
  return Math.max(-value.exponent, 0);
}

/**
 * `value.toString()`'s equivalent: `unscaled x 10^exponent` rendered as plain decimal notation
 * (`integer` or `float` grammar, §7.6) -- never scientific notation, so the result is always
 * exactly what {@link decimalOf}'s own `unscaled`/`exponent` pair denotes, expanded rather than
 * abbreviated. A deliberate simplification from `BigDecimal.toString()`, which switches to
 * scientific notation past certain scale/precision thresholds: correctness (an exact round trip
 * through {@link tryParseNumber}) does not need that, only the number grammar accepting the
 * result, which plain notation always satisfies.
 */
export function writeDecimal(value: TsonDecimal): string {
  const { unscaled, exponent } = value;
  const negative = unscaled < 0n;
  const digits = (negative ? -unscaled : unscaled).toString();
  const sign = negative ? '-' : '';
  if (exponent === 0) {
    return sign + digits;
  }
  if (exponent > 0) {
    return sign + digits + '0'.repeat(exponent);
  }
  const fractionLength = -exponent;
  if (digits.length > fractionLength) {
    const splitAt = digits.length - fractionLength;
    return sign + digits.slice(0, splitAt) + '.' + digits.slice(splitAt);
  }
  return sign + '0.' + '0'.repeat(fractionLength - digits.length) + digits;
}

/** Strips the grammar's digit-separator underscores from arbitrary token text, without a regex. */
export function stripUnderscores(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch !== '_') out += ch;
  }
  return out;
}
