/**
 * Two related jobs that share this module because every caller of the second needs the first:
 *
 * 1. **Exact extraction** ({@link toExactInteger}, {@link toExactDecimal}) — turning a recognized
 *    {@link NumberForm} into the exact value it denotes, as `bigint` (integers, based integers)
 *    or {@link TsonDecimal} (floats). This is the one canonicalization step every consumer of a
 *    recognized number form needs regardless of what host type it eventually binds to (§4.3's
 *    required equivalence between representations — `255`/`0xFF`, `1_000`/`1000` — holds at this
 *    exact-intermediate step and nowhere else). The reference implementation keeps this as a
 *    separate `NumberForms` class; here it folds into the narrowing module that is its only
 *    reason to exist, since TypeScript has no `BigInteger`/`BigDecimal` split to mirror.
 *
 * 2. **Narrowing** ({@link narrowIntegral}, {@link narrowDecimal}, {@link narrowApproximate}) — the
 *    exact value adapted to a caller-chosen representation. Both an untyped §4 number (bound
 *    mode, where the target field is the only source of width information) and a numeric atom
 *    (§5, where the atom's own declared width narrows first and this only adapts the
 *    already-validated value to whatever representation the caller asked for) need the identical
 *    target-matching logic, so it lives here once rather than once per caller.
 *
 * **The target is a closed string union (`'number' | 'bigint' | 'decimal'`), not a reflected
 * class token.** The reference implementation dispatches on `Class<?>` because Java's own numeric
 * ladder (`byte`/`short`/`int`/`long`/`float`/`double`/boxed/`BigInteger`/`BigDecimal`) has no
 * single idiomatic TypeScript counterpart to preserve — this port's frozen host types
 * (`value/types.ts`) collapse that ladder to exactly three representations, so the target is
 * named the idiomatic way a closed choice is named here: a string literal union, checked by the
 * compiler at every call site rather than discovered at the first bad cast.
 *
 * **Errors are native `RangeError`/`TypeError`, not this library's own error types**, matching the
 * reference implementation's own choice to throw plain JDK exceptions here rather than a
 * module-specific one: "my target is too narrow/wrong" is the caller's problem to classify and
 * report, not a §5.2 parse/validation concern about the atom itself.
 */

import { TsonInternalError } from '../core/errors.js';
import type { TsonDecimal } from '../value/types.js';
import type { BasedIntegerForm, FloatForm, IntegerForm } from './numberGrammar.js';

/** Strips the grammar's digit-separator underscores, without a regex. */
function stripUnderscores(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    const ch = digits.charAt(i);
    if (ch !== '_') out += ch;
  }
  return out;
}

/**
 * The exact magnitude an {@link IntegerForm} or {@link BasedIntegerForm} denotes.
 *
 * `BigInt`'s own `0x`/`0o`/`0b` prefix parsing does the radix conversion — this is ordinary use
 * of the host bigint constructor, not a regex, and every digit reaching it has already been
 * validated by the scanner that produced the form.
 */
export function toExactInteger(form: IntegerForm | BasedIntegerForm): bigint {
  const digits = stripUnderscores(form.digits);
  const value =
    form.kind === 'integer'
      ? BigInt(digits)
      : BigInt((form.radix === 'hex' ? '0x' : form.radix === 'octal' ? '0o' : '0b') + digits);
  return form.sign === 'minus' ? -value : value;
}

/**
 * The exact value a {@link FloatForm} denotes, as `unscaled * 10^exponent` (§4.3's required
 * equivalence — `.5`/`0.5`, `6.02e23`/`602e21` — holds at this representation).
 */
export function toExactDecimal(form: FloatForm): TsonDecimal {
  const integerDigits = stripUnderscores(form.integerPart ?? '0');
  const fractionDigits = stripUnderscores(form.fractionDigits ?? '');
  let unscaled = BigInt(integerDigits + fractionDigits);
  let exponent = -fractionDigits.length;
  if (form.exponent !== undefined) {
    const magnitude = BigInt(stripUnderscores(form.exponent.digits));
    exponent += Number(form.exponent.sign === 'minus' ? -magnitude : magnitude);
  }
  if (form.sign === 'minus') unscaled = -unscaled;
  return { unscaled, exponent };
}

/** The three host representations an exact number can be narrowed to. */
export type NumberTarget = 'number' | 'bigint' | 'decimal';

const MIN_SAFE_INTEGER = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Narrows an exact integral value to `target`.
 *
 * @throws {@link RangeError} narrowing to `'number'` when `value` falls outside the ±2^53 range a
 *   JS number can hold exactly — the `bigint`/`decimal` targets never throw, since both are
 *   exact at any width.
 */
export function narrowIntegral(value: bigint, target: 'number'): number;
export function narrowIntegral(value: bigint, target: 'bigint'): bigint;
export function narrowIntegral(value: bigint, target: 'decimal'): TsonDecimal;
export function narrowIntegral(value: bigint, target: NumberTarget): number | bigint | TsonDecimal {
  switch (target) {
    case 'bigint':
      return value;
    case 'decimal':
      return { unscaled: value, exponent: 0 };
    case 'number':
      if (value < MIN_SAFE_INTEGER || value > MAX_SAFE_INTEGER) {
        throw new RangeError(`${value.toString()} does not fit exactly in a JS number`);
      }
      return Number(value);
    default: {
      const exhaustive: never = target;
      throw new TsonInternalError(`unreachable numeric target: ${String(exhaustive)}`);
    }
  }
}

/**
 * Narrows an exact decimal value to `target`.
 *
 * There is no integral target here, unlike {@link narrowIntegral} — the reference implementation
 * rejects one at runtime ("write it as an integer token if an exact integral type is intended");
 * this port rejects it at compile time instead, by giving {@link NumberTarget}'s `'bigint'` member
 * no overload at all. Narrowing to `'number'` is always lossy for a value with more significant
 * digits than a JS number can hold and never throws, matching `BigDecimal.doubleValue()`'s own
 * unchecked narrowing — there is no "exact fit" concept for an approximate target the way there is
 * for an integral one.
 */
export function narrowDecimal(value: TsonDecimal, target: 'number'): number;
export function narrowDecimal(value: TsonDecimal, target: 'decimal'): TsonDecimal;
export function narrowDecimal(
  value: TsonDecimal,
  target: 'number' | 'decimal',
): number | TsonDecimal {
  switch (target) {
    case 'decimal':
      return value;
    case 'number':
      return Number(value.unscaled) * 10 ** value.exponent;
    default: {
      const exhaustive: never = target;
      throw new TsonInternalError(`unreachable numeric target: ${String(exhaustive)}`);
    }
  }
}

/**
 * Narrows an already-rounded approximate value (a JS `number`, at whatever precision its source
 * atom actually rounded to — `float32`/`float64` both round through here uniformly, since a
 * float-precision value widens to a JS `number` losslessly) to `target`, including
 * `NaN`/`Infinity`, which {@link narrowIntegral}/{@link narrowDecimal} never see.
 *
 * Narrowing to `'decimal'` reproduces the exact binary value the double bit pattern holds — the
 * same thing `new BigDecimal(double)` does in the reference implementation, and deliberately not
 * the "nicest" decimal that round-trips through `toString()` (that would silently invent digits
 * the source double never had).
 *
 * @throws {@link RangeError} narrowing `NaN` or `±Infinity` to `'decimal'` — neither has an exact
 *   decimal expansion.
 */
export function narrowApproximate(value: number, target: 'number'): number;
export function narrowApproximate(value: number, target: 'decimal'): TsonDecimal;
export function narrowApproximate(
  value: number,
  target: 'number' | 'decimal',
): number | TsonDecimal {
  switch (target) {
    case 'number':
      return value;
    case 'decimal':
      if (Number.isNaN(value) || !Number.isFinite(value)) {
        const label = Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity';
        throw new RangeError(`cannot represent ${label} as an exact decimal`);
      }
      return exactDecimalOfDouble(value);
    default: {
      const exhaustive: never = target;
      throw new TsonInternalError(`unreachable numeric target: ${String(exhaustive)}`);
    }
  }
}

/**
 * Decomposes a finite, non-NaN IEEE 754 double into the exact decimal its bit pattern denotes.
 *
 * `value = mantissa * 2^exp2` (53-bit mantissa, implicit leading bit restored for a normal
 * double, subnormals handled by their own fixed exponent). A non-negative binary exponent is
 * already an exact integer (`unscaled = mantissa << exp2`, `exponent = 0`); a negative one is
 * rewritten as an exact power of ten by supplying the missing factors of five
 * (`unscaled = mantissa * 5^-exp2`, `exponent = exp2`), since `2^-n = 5^-n * 10^-n`.
 */
function exactDecimalOfDouble(value: number): TsonDecimal {
  if (value === 0) {
    return { unscaled: 0n, exponent: 0 };
  }

  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  const high = view.getUint32(0);
  const low = view.getUint32(4);

  const negative = high >>> 31 === 1;
  const biasedExponent = (high >>> 20) & 0x7ff;
  const mantissaHigh = BigInt(high & 0xfffff);
  let mantissa = (mantissaHigh << 32n) | BigInt(low);
  let exp2: number;
  if (biasedExponent === 0) {
    // Subnormal: no implicit leading bit, fixed exponent.
    exp2 = -1074;
  } else {
    mantissa |= 1n << 52n;
    exp2 = biasedExponent - 1075;
  }

  // Shed trailing zero mantissa bits into the exponent, so the stored magnitude is minimal.
  while (mantissa !== 0n && mantissa % 2n === 0n) {
    mantissa >>= 1n;
    exp2 += 1;
  }

  let unscaled: bigint;
  let exponent: number;
  if (exp2 >= 0) {
    unscaled = mantissa << BigInt(exp2);
    exponent = 0;
  } else {
    unscaled = mantissa * 5n ** BigInt(-exp2);
    exponent = exp2;
  }
  return { unscaled: negative ? -unscaled : unscaled, exponent };
}
