/**
 * [TSON-DATA] §4.3's numeric equivalence, applied wherever an entry's identity is derived from a
 * token that may be a number: radix, digit separators and a redundant sign fall away
 * (`255`/`0xFF`/`0b1111_1111`/`+255`), and a float's written scale does too (`.5`/`0.5`,
 * `1.0`/`1e0`). Without this, two spellings of one number would mint two entries for one type, and
 * §5.4 would then admit a choice whose "distinct" variants are actually the same type twice.
 *
 * **The base type itself never falls away**: `1` is an integer and `1.0` a float under §4's own
 * resolution order, so `kind` keeps them apart even though one magnitude covers both.
 *
 * Shared by `derivedName.ts`'s two families (a binding record's scalar fields, an application's
 * value arguments) so a number's identity is computed once rather than by two independent copies.
 */
import { tryParseNumber, type NumberForm } from '../base/numberGrammar.js';
import { toExactDecimal, toExactInteger } from '../base/numberNarrowing.js';
import type { TsonDecimal } from '../value/types.js';

/**
 * A number's identity: the base-type `kind` it resolves to (`'#i'` integer, `'#f'` float, `'#s'`
 * special), and the one `text` every spelling of its magnitude reduces to.
 */
export interface CanonicalNumber {
  readonly kind: string;
  readonly text: string;
}

/**
 * `text` reduced to its numeric identity, or `undefined` when it should be compared as written —
 * including every quoted token, since §4.4 makes a quoted token never a number.
 */
export function canonicalNumber(text: string, unquoted: boolean): CanonicalNumber | undefined {
  if (!unquoted) {
    return undefined;
  }
  const form = tryParseNumber(text);
  if (form === undefined) {
    return undefined;
  }
  switch (form.kind) {
    case 'integer':
    case 'based-integer':
      return { kind: '#i', text: toExactInteger(form).toString() };
    case 'float':
      return { kind: '#f', text: floatText(form) };
    case 'special-value':
      return { kind: '#s', text: specialText(form) };
  }
}

/** `text` reduced to its canonical spelling where it is a number, and returned unchanged where it is not. */
export function numericTextOf(text: string, unquoted: boolean): string {
  const canonical = canonicalNumber(text, unquoted);
  return canonical === undefined ? text : canonical.text;
}

/**
 * One spelling per magnitude whether it was written with a scale or an exponent — `1.0`, `1.00`
 * and `1e0` are one number, so trailing zeros are stripped before the text is taken. The point is
 * then put back where stripping removed it: without it a float reads alongside an integer
 * argument as if the two shared a kind tag, two readable halves that would differ only in their
 * hash.
 */
function floatText(form: Extract<NumberForm, { kind: 'float' }>): string {
  const text = decimalPlainString(toExactDecimal(form));
  return text.includes('.') ? text : `${text}.0`;
}

/** An exact decimal, stripped of trailing zeros, rendered as a plain (never scientific) string. */
function decimalPlainString(decimal: TsonDecimal): string {
  let unscaled = decimal.unscaled;
  let exponent = decimal.exponent;
  const negative = unscaled < 0n;
  if (negative) {
    unscaled = -unscaled;
  }
  if (unscaled === 0n) {
    return '0';
  }
  while (unscaled % 10n === 0n) {
    unscaled /= 10n;
    exponent += 1;
  }
  const digits = unscaled.toString();
  let out: string;
  if (exponent >= 0) {
    out = digits + '0'.repeat(exponent);
  } else {
    const fractionDigits = -exponent;
    out =
      digits.length > fractionDigits
        ? `${digits.slice(0, digits.length - fractionDigits)}.${digits.slice(digits.length - fractionDigits)}`
        : `0.${'0'.repeat(fractionDigits - digits.length)}${digits}`;
  }
  return negative ? `-${out}` : out;
}

/**
 * `.nan`, `.inf`, `.infinity` are one value each, and a `+` on either infinity spelling is
 * redundant — §4.3's special values carry the same equivalence the magnitudes do. `.nan` is never
 * signed by the grammar, so it needs no sign case of its own.
 */
function specialText(form: Extract<NumberForm, { kind: 'special-value' }>): string {
  if (form.special === 'nan') {
    return 'nan';
  }
  return form.sign === 'minus' ? '-inf' : 'inf';
}
