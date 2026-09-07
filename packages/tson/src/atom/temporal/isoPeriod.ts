/**
 * The `!period` grammar and its inverse (§5.4) -- `P` followed by a `Y` component, an `M`
 * component, or both in that order, and nothing else: no `D`, `W`, `T` part and no fraction, since
 * every one of those belongs to `!duration` (`isoDuration.ts`) instead. An optional leading `-`
 * is admitted, as on a duration. Hand-scanned, no `RegExp`, sharing `durationDigits.ts`'s
 * designator scanner with `isoDuration.ts`.
 *
 * **`P1Y` and `P12M` are one value**, so the value space is a signed count of months and a year is
 * exactly twelve of them -- there is no fixed-length ambiguity here the way there is between a
 * month and a second, since twelve months make a year by definition rather than by
 * approximation. `P0Y`, `P0M` and `-P0M` are one value for the same reason.
 */

import { scanDesignator } from './durationDigits.js';

const CODE_MINUS = 0x2d; // '-'
const CODE_P = 0x50; // 'P'
const CODE_Y = 0x59; // 'Y'
const CODE_M = 0x4d; // 'M'

const MONTHS_PER_YEAR = 12n;

/**
 * Parses `text` as a `!period` token, returning its value as a signed count of months, or
 * `undefined` for anything that doesn't match this grammar at all -- a `D`, `W` or `T` component,
 * a fraction, Y and M out of order, or `P` with neither component present.
 */
export function tryParseIsoPeriod(text: string): bigint | undefined {
  let pos = 0;
  let negative = false;
  if (text.charCodeAt(0) === CODE_MINUS) {
    negative = true;
    pos = 1;
  }
  if (text.charCodeAt(pos) !== CODE_P) return undefined;
  pos += 1;

  let years: bigint | undefined;
  const y = scanDesignator(text, pos, CODE_Y);
  if (y !== undefined) {
    years = y.value;
    pos = y.next;
  }
  let months: bigint | undefined;
  const m = scanDesignator(text, pos, CODE_M);
  if (m !== undefined) {
    months = m.value;
    pos = m.next;
  }

  if (pos !== text.length) return undefined;
  if (years === undefined && months === undefined) return undefined;

  const totalMonths = (years ?? 0n) * MONTHS_PER_YEAR + (months ?? 0n);
  return negative ? -totalMonths : totalMonths;
}

/**
 * `tryParseIsoPeriod`'s inverse: whole years and a remaining months component, the value's own
 * normal form -- `18` writes as `P1Y6M`, never `P18M`, mirroring `java.time.Period.normalized()`.
 * Zero writes as `P0M`, matching this family's own zero value (`P0Y`, `P0M` and `-P0M` are one
 * value; there is no preferring one written zero over another, so this picks a single one).
 */
export function formatIsoPeriod(months: bigint): string {
  if (months === 0n) return 'P0M';
  const negative = months < 0n;
  const magnitude = negative ? -months : months;
  const years = magnitude / MONTHS_PER_YEAR;
  const remainder = magnitude % MONTHS_PER_YEAR;

  let out = negative ? '-P' : 'P';
  if (years !== 0n) out += `${years.toString()}Y`;
  if (remainder !== 0n) out += `${remainder.toString()}M`;
  return out;
}
