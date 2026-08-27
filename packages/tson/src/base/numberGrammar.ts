/**
 * Recognizes the `number` production of §7.6 against a token's complete text (§4.3: "if and only
 * if its complete text matches the number production"). Pure identification: determines which of
 * the four grammar alternatives (if any) the text matches and extracts the grammar's own
 * structural components as raw substrings — see `numberScanner.ts`'s {@link NumberForm} for why
 * it stops there rather than binding to a host numeric type.
 *
 * The grammar itself is hand-written, one function per ABNF rule, in `numberScanner.ts`; this
 * module is the door and the full-text rule.
 *
 * **Every entry point here requires the whole text**, per §4.3: a scan that stops short of the
 * end is no match, which is what makes `3e` a string rather than a broken float.
 *
 * {@link isHexFloat}, {@link tryParseRational}, and {@link tryParseComplex} recognize §7.6's
 * *extended* forms — not part of `number`, each reachable only through its own built-in
 * vocabulary atom (`float32`/`float64`; `rational`; `complex`). Hex-float is a shape check with
 * no structural record (a caller reads the token's own text); rational and complex decompose
 * into {@link RationalForm}/{@link ComplexForm}.
 */

import {
  createNumberScanner,
  type ComplexForm,
  type NumberForm,
  type RationalForm,
} from './numberScanner.js';

export type {
  BasedIntegerForm,
  ComplexForm,
  ExponentPart,
  FloatForm,
  IntegerForm,
  NumberForm,
  Radix,
  RationalForm,
  Sign,
  SpecialKind,
  SpecialValueForm,
} from './numberScanner.js';

/**
 * Attempts to match `text` against the `number` production in full. `undefined` if it matches
 * none of the four alternatives — callers fall through to string, per §4.4 ("Any unquoted token
 * that does not match null, boolean, or the number production resolves to a string value... There
 * are no exceptions").
 */
export function tryParseNumber(text: string): NumberForm | undefined {
  const scanner = createNumberScanner(text);
  const form = scanner.number();
  return form !== undefined && scanner.atEnd() ? form : undefined;
}

/** See `numberScanner.ts`'s `hexFloat`. Not tried by {@link tryParseNumber} — an extended form, opt-in only. */
export function isHexFloat(text: string): boolean {
  const scanner = createNumberScanner(text);
  return scanner.hexFloat() && scanner.atEnd();
}

/** See `numberScanner.ts`'s `rational`. Not tried by {@link tryParseNumber} — an extended form, opt-in only. */
export function tryParseRational(text: string): RationalForm | undefined {
  const scanner = createNumberScanner(text);
  const form = scanner.rational();
  return form !== undefined && scanner.atEnd() ? form : undefined;
}

/**
 * See `numberScanner.ts`'s `complex`. Not tried by {@link tryParseNumber} — an extended form,
 * opt-in only. Unlike the other three entry points here, `complex` already enforces its own
 * full-text match internally (both of its grammar alternatives fail unless the cursor reaches the
 * end), so there is no separate `atEnd()` check to add at this door.
 */
export function tryParseComplex(text: string): ComplexForm | undefined {
  return createNumberScanner(text).complex();
}
