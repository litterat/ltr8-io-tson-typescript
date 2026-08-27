/**
 * The ISO 8601 `PnYnMnDTnHnMnS` duration grammar, hand-written -- the port of
 * `DurationParser.java`'s own `parseDuration`/`write`, restructured around `duration.ts`'s
 * actual host value: `TsonDuration` (`value/types.ts`), `{ period, clock }`, rather than the
 * paired `java.time.Period`/`java.time.Duration` the Java's own `schema.meta.IsoDuration` record
 * wraps -- no `RegExp`, for the same reason the RFC 3339 grammar in `rfc3339.ts` has none: a
 * token is already fully decoded text by the time an atom sees it, so a hand-scanned character
 * walk is both the simplest and the most auditable way to enforce a grammar this exact, and it
 * keeps this atom family from inheriting whatever ISO 8601 extensions a regex-based or
 * JDK-delegated compiler happens to accept beyond the strict grammar (`CONFORMANCE.md`:
 * `Duration.parse`/`Period.parse` both accept a leading `-` sign and lowercase `p`/`t`, neither
 * of which `PnYnMnDTnHnMnS` shows).
 *
 * **Uppercase designators only, no leading sign** -- `CONFORMANCE.md`'s own duration entry.
 * Scanning ASCII digits and exact-case designator letters one at a time means there's nothing
 * here to accept a sign or a lowercase letter through by accident, the same way `rfc3339.ts`'s
 * hand-scanned year has nothing to leak ISO 8601's extended-year form through.
 *
 * **Not the alternative `PnW` week form.** §5.4's own table gives the accepted format as
 * literally `PnYnMnDTnHnMnS`, with no `W` -- read here as exhaustive rather than illustrative,
 * the same conservative reading `DurationParser.java`'s own Javadoc records as a genuine
 * ambiguity rather than a confident call (`CONFORMANCE.md`, "one open question"). A `W` is
 * simply never one of the letters `scanDesignator`/`scanSecondsDesignator` look for, so a `PnW`
 * token fails as unconsumed trailing text.
 *
 * **Designator digit runs are preserved verbatim, never renormalised.** `{@link TsonDuration}`'s
 * own TSDoc gives its shape as two independently round-trippable ISO 8601 substrings; this
 * module honours that literally -- `P0009D` reads back as `P0009D`, not `P9D` -- the same
 * "preserved as written" precedent `schema/meta`'s `Rational` sets for `!rational` (2/4 stays
 * 2/4). Only the *split itself* is new text this format has to synthesise: `P0D`/`PT0S` mark an
 * absent calendar/clock half, per `TsonDuration`'s own contract.
 */

import type { TsonDuration } from '../../value/types.js';

const CODE_P = 0x50; // 'P'
const CODE_T = 0x54; // 'T'
const CODE_Y = 0x59; // 'Y'
const CODE_M = 0x4d; // 'M'
const CODE_D = 0x44; // 'D'
const CODE_H = 0x48; // 'H'
const CODE_S = 0x53; // 'S'
const CODE_DOT = 0x2e; // '.'
const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;

function isDigit(code: number): boolean {
  return code >= ASCII_ZERO && code <= ASCII_NINE;
}

/** Scans `1*DIGIT letter` at `pos` -- e.g. `scanDesignator(text, pos, CODE_Y)` for `"12Y"`.
 * Returns the matched substring (digits and letter together) and the index just past it, or
 * `undefined` with `pos` conceptually unmoved (the caller simply doesn't advance) when there is
 * no digit run at `pos` at all, or the digit run isn't followed by `letter` -- both are "this
 * designator isn't here", not a hard failure, since ISO 8601 lets any calendar/clock designator
 * be entirely absent. */
function scanDesignator(
  text: string,
  pos: number,
  letter: number,
): { text: string; next: number } | undefined {
  let i = pos;
  while (i < text.length && isDigit(text.charCodeAt(i))) i++;
  if (i === pos) return undefined;
  if (text.charCodeAt(i) !== letter) return undefined;
  return { text: text.slice(pos, i + 1), next: i + 1 };
}

/** `scanDesignator`'s seconds-designator variant: `1*DIGIT ["." 1*DIGIT] "S"`, the one
 * designator whose grammar admits a fractional part. */
function scanSecondsDesignator(
  text: string,
  pos: number,
): { text: string; next: number } | undefined {
  let i = pos;
  while (i < text.length && isDigit(text.charCodeAt(i))) i++;
  if (i === pos) return undefined;
  if (text.charCodeAt(i) === CODE_DOT) {
    let j = i + 1;
    while (j < text.length && isDigit(text.charCodeAt(j))) j++;
    if (j === i + 1) return undefined; // '.' with no fractional digits after it
    i = j;
  }
  if (text.charCodeAt(i) !== CODE_S) return undefined;
  return { text: text.slice(pos, i + 1), next: i + 1 };
}

/**
 * Parses `text` against `P(nY)?(nM)?(nD)?(T(nH)?(nM)?(n[.n]S)?)?`, requiring at least one
 * designator overall and, if `T` is present, at least one clock designator after it (a dangling
 * `T` with nothing following is not itself a designator). Returns `undefined` for anything that
 * doesn't match -- including trailing unconsumed text, so `P3W` fails here precisely because `W`
 * is never a letter either scanner accepts (see this module's own TSDoc).
 */
export function tryParseIsoDuration(text: string): TsonDuration | undefined {
  if (text.charCodeAt(0) !== CODE_P) return undefined;
  let pos = 1;

  let years: string | undefined;
  let months: string | undefined;
  let days: string | undefined;
  const y = scanDesignator(text, pos, CODE_Y);
  if (y !== undefined) {
    years = y.text;
    pos = y.next;
  }
  const m = scanDesignator(text, pos, CODE_M);
  if (m !== undefined) {
    months = m.text;
    pos = m.next;
  }
  const d = scanDesignator(text, pos, CODE_D);
  if (d !== undefined) {
    days = d.text;
    pos = d.next;
  }

  let hours: string | undefined;
  let minutes: string | undefined;
  let seconds: string | undefined;
  if (text.charCodeAt(pos) === CODE_T) {
    pos += 1;
    const h = scanDesignator(text, pos, CODE_H);
    if (h !== undefined) {
      hours = h.text;
      pos = h.next;
    }
    const min = scanDesignator(text, pos, CODE_M);
    if (min !== undefined) {
      minutes = min.text;
      pos = min.next;
    }
    const s = scanSecondsDesignator(text, pos);
    if (s !== undefined) {
      seconds = s.text;
      pos = s.next;
    }
    if (hours === undefined && minutes === undefined && seconds === undefined) return undefined;
  }

  if (pos !== text.length) return undefined;
  if (
    years === undefined &&
    months === undefined &&
    days === undefined &&
    hours === undefined &&
    minutes === undefined &&
    seconds === undefined
  ) {
    return undefined;
  }

  const period =
    years !== undefined || months !== undefined || days !== undefined
      ? `P${years ?? ''}${months ?? ''}${days ?? ''}`
      : 'P0D';
  const clock =
    hours !== undefined || minutes !== undefined || seconds !== undefined
      ? `PT${hours ?? ''}${minutes ?? ''}${seconds ?? ''}`
      : 'PT0S';
  return { period, clock };
}

/**
 * `tryParseIsoDuration`'s inverse: the single combined `PnYnMnDTnHnMnS` token that reads back to
 * `value`. `P0D`/`PT0S` are each read as "this half was absent", the same sentinel
 * `tryParseIsoDuration` writes for a token that had none -- so a purely clock-only value like `{
 * period: "P0D", clock: "PT1H30M" }` writes back as `PT1H30M`, not `P0DT1H30M`. If both halves
 * are the sentinel (a `TsonDuration` built by hand rather than by `tryParseIsoDuration`, which
 * itself never produces both at once -- it requires at least one real designator), the result
 * falls back to `PT0S`, mirroring `DurationParser.java`'s own `write` doing the same for an
 * all-zero value.
 */
export function formatIsoDuration(value: TsonDuration): string {
  const calendarText = value.period === 'P0D' ? '' : value.period.slice(1);
  const clockText = value.clock === 'PT0S' ? '' : value.clock.slice(1);
  const combined = `P${calendarText}${clockText}`;
  return combined === 'P' ? 'PT0S' : combined;
}
