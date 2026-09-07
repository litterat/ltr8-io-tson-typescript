/**
 * The digit-run scanning primitive `isoDuration.ts` and `isoPeriod.ts` both build their grammars
 * from -- `1*DIGIT letter`, ISO 8601's designator shape shared by every component of both `!duration`
 * and `!period` (a year, a week, a day, an hour, a plain minute-or-month, a second). Factored out
 * once rather than duplicated twice, since the two grammars differ only in *which* designators they
 * accept and in what order, never in how one designator is recognised.
 *
 * Hand-scanned, no `RegExp` -- matching `rfc3339.ts`'s own top note: a token is already fully
 * decoded text by the time an atom sees it, so a character walk is both the simplest and the most
 * auditable way to enforce a grammar this exact.
 */

const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;

export function isDigit(code: number): boolean {
  return code >= ASCII_ZERO && code <= ASCII_NINE;
}

/** One designator's scanned value and the index just past it. */
export interface Designator {
  readonly value: bigint;
  readonly next: number;
}

/**
 * Scans `1*DIGIT letter` at `pos` -- e.g. `scanDesignator(text, pos, CODE_Y)` for `"12Y"`, giving
 * `{ value: 12n, next }`. Returns `undefined` -- `pos` conceptually unmoved -- when there is no
 * digit run at `pos` at all, or the digit run isn't immediately followed by `letter`: both mean
 * "this designator isn't here", never a hard failure, since every designator in both grammars may
 * be entirely absent.
 */
export function scanDesignator(text: string, pos: number, letter: number): Designator | undefined {
  let i = pos;
  while (i < text.length && isDigit(text.charCodeAt(i))) i++;
  if (i === pos) return undefined;
  if (text.charCodeAt(i) !== letter) return undefined;
  return { value: BigInt(text.slice(pos, i)), next: i + 1 };
}
