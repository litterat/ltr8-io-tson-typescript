/**
 * The `!duration` grammar and its inverse (§5.4) -- RFC 3339 Appendix A's `dur-date`/`dur-time`/
 * `dur-week`, restricted to the components a fixed length gives a total order over: no `Y` or
 * month-`M` component (a calendar span with neither is `!period`, `isoPeriod.ts`), an optional
 * leading `-`, and a fraction confined to the seconds component. Hand-scanned, no `RegExp`, for
 * the same reason `rfc3339.ts`'s own top note gives, sharing `durationDigits.ts`'s designator
 * scanner with `isoPeriod.ts`.
 *
 * **The week form stands alone.** `"P" (dur-date / dur-time / dur-week)` is an alternation, so a
 * week never combines with a day/time component -- `P1W2D` and `P1WT1H` both fail here precisely
 * because the week branch below requires nothing but `W` to follow the digits and the whole token
 * to end there; anything else falls through to the day/time branch, where `W` is never a letter
 * either designator scan accepts.
 *
 * **A week is exactly 7 days and a day exactly 86400 s.** Both are folded into a nanosecond count
 * at parse time (`SECONDS_PER_WEEK`/`SECONDS_PER_DAY` below), which is what makes `P2W`, `P14D`
 * and `PT336H` the same value with no canonical-spelling question to answer: the value space is
 * nanoseconds, not a written form, so there is nothing to prefer between them.
 *
 * **Uppercase designators only, no lowercase, no leading `+`.** Scanning exact-case ASCII letters
 * one at a time means there is nothing here to let `java.time.Duration.parse`'s own leniency (a
 * lowercase `p`/`t`) through by accident -- `CONFORMANCE.md`'s own duration entry.
 *
 * **A fractional second past nine digits is rejected inside the scan itself**, not truncated --
 * `scanSeconds` below refuses a fractional run of zero or more than nine digits the same way
 * `rfc3339.ts`'s `readFullTime` does for `full-time`/`date-time`, so all three of this family's
 * fractional-second productions share one ceiling (§5.4).
 */

import { isDigit, scanDesignator } from './durationDigits.js';
import { fractionDigits } from './rfc3339.js';

const CODE_MINUS = 0x2d; // '-'
const CODE_P = 0x50; // 'P'
const CODE_T = 0x54; // 'T'
const CODE_W = 0x57; // 'W'
const CODE_D = 0x44; // 'D'
const CODE_H = 0x48; // 'H'
const CODE_M = 0x4d; // 'M'
const CODE_S = 0x53; // 'S'
const CODE_DOT = 0x2e; // '.'

const NANOS_PER_SECOND = 1_000_000_000n;
const SECONDS_PER_MINUTE = 60n;
const SECONDS_PER_HOUR = 3_600n;
const SECONDS_PER_DAY = 86_400n;
const SECONDS_PER_WEEK = 604_800n;

/** `1*DIGIT ["." 1*9DIGIT] "S"` at `pos` -- the one designator whose grammar admits a fraction,
 * capped at nine digits per this module's own top note. Returns the whole-seconds count and the
 * fraction as an exact nanosecond count (`0` when there is no fractional part), or `undefined`
 * when there is no seconds designator at `pos` at all, or its fraction is malformed or too long. */
function scanSeconds(
  text: string,
  pos: number,
): { readonly seconds: bigint; readonly fractionNanos: bigint; readonly next: number } | undefined {
  let i = pos;
  while (i < text.length && isDigit(text.charCodeAt(i))) i++;
  if (i === pos) return undefined;
  const seconds = BigInt(text.slice(pos, i));

  let fractionNanos = 0n;
  if (text.charCodeAt(i) === CODE_DOT) {
    let j = i + 1;
    let digits = 0;
    while (j < text.length && isDigit(text.charCodeAt(j))) {
      digits++;
      j++;
    }
    if (digits === 0 || digits > 9) return undefined;
    fractionNanos = BigInt(text.slice(i + 1, j)) * 10n ** BigInt(9 - digits);
    i = j;
  }

  if (text.charCodeAt(i) !== CODE_S) return undefined;
  return { seconds, fractionNanos, next: i + 1 };
}

/**
 * Parses `text` as a `!duration` token, returning its value as a signed exact count of
 * nanoseconds (unchecked against the family's own magnitude ceiling -- `duration.ts`'s own job),
 * or `undefined` for anything that doesn't match this grammar at all, including a `PnW` mixed with
 * any other component and trailing unconsumed text.
 */
export function tryParseIsoDuration(text: string): bigint | undefined {
  let pos = 0;
  let negative = false;
  if (text.charCodeAt(0) === CODE_MINUS) {
    negative = true;
    pos = 1;
  }
  if (text.charCodeAt(pos) !== CODE_P) return undefined;
  pos += 1;

  const week = scanDesignator(text, pos, CODE_W);
  if (week?.next === text.length) {
    const nanoseconds = week.value * SECONDS_PER_WEEK * NANOS_PER_SECOND;
    return negative ? -nanoseconds : nanoseconds;
  }

  let days: bigint | undefined;
  const d = scanDesignator(text, pos, CODE_D);
  if (d !== undefined) {
    days = d.value;
    pos = d.next;
  }

  let hours: bigint | undefined;
  let minutes: bigint | undefined;
  let seconds: bigint | undefined;
  let fractionNanos = 0n;
  if (text.charCodeAt(pos) === CODE_T) {
    pos += 1;
    const h = scanDesignator(text, pos, CODE_H);
    if (h !== undefined) {
      hours = h.value;
      pos = h.next;
    }
    const m = scanDesignator(text, pos, CODE_M);
    if (m !== undefined) {
      minutes = m.value;
      pos = m.next;
    }
    const s = scanSeconds(text, pos);
    if (s !== undefined) {
      seconds = s.seconds;
      fractionNanos = s.fractionNanos;
      pos = s.next;
    }
    if (hours === undefined && minutes === undefined && seconds === undefined) return undefined;
  }

  if (pos !== text.length) return undefined;
  if (days === undefined && hours === undefined && minutes === undefined && seconds === undefined) {
    return undefined;
  }

  const totalSeconds =
    (days ?? 0n) * SECONDS_PER_DAY +
    (hours ?? 0n) * SECONDS_PER_HOUR +
    (minutes ?? 0n) * SECONDS_PER_MINUTE +
    (seconds ?? 0n);
  const nanoseconds = totalSeconds * NANOS_PER_SECOND + fractionNanos;
  return negative ? -nanoseconds : nanoseconds;
}

/**
 * `tryParseIsoDuration`'s inverse, in the one canonical form this family ever writes:
 * `[-]PTnHnMnS`, hours and minutes omitted when zero, the seconds designator itself omitted only
 * when both the whole-seconds count and the fraction are zero. Written in the form `java.time.
 * Duration` itself uses -- a day is not a distinct unit of the value, so hours carry it -- since a
 * writer cannot recover whether `value` was written in weeks, days, or already this form (§5.4:
 * "a text encoding emits `PTnHnMnS` and nothing else").
 */
export function formatIsoDuration(nanoseconds: bigint): string {
  if (nanoseconds === 0n) return 'PT0S';
  const negative = nanoseconds < 0n;
  const magnitude = negative ? -nanoseconds : nanoseconds;
  const totalSeconds = magnitude / NANOS_PER_SECOND;
  const fractionNanos = magnitude % NANOS_PER_SECOND;
  const hours = totalSeconds / SECONDS_PER_HOUR;
  const minutes = (totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE;
  const seconds = totalSeconds % SECONDS_PER_MINUTE;

  let out = negative ? '-PT' : 'PT';
  if (hours !== 0n) out += `${hours.toString()}H`;
  if (minutes !== 0n) out += `${minutes.toString()}M`;
  if (seconds !== 0n || fractionNanos !== 0n) {
    out += seconds.toString();
    if (fractionNanos !== 0n) out += `.${fractionDigits(Number(fractionNanos))}`;
    out += 'S';
  }
  return out;
}
