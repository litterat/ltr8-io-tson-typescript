/**
 * Value-comparison functions for every host shape an atom family's bounds are typed with in
 * `schema/meta` — plain totals for `bigint`/`number`, exact cross-multiplication/common-scale
 * comparison for {@link Rational}/{@link Decimal} (matching each type's own doc: "equality and
 * constraints operate on the value, not the written form"), and exact integer instant
 * comparison for the RFC 3339 shapes, so a bound written at one UTC offset compares correctly
 * against one written at another with no floating-point rounding.
 */
import type { Decimal, Rational } from '../schema/meta/algebra.js';
import type { CalendarDate, OffsetDateTime, OffsetTime } from '../schema/meta/atoms-temporal.js';

export function compareBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareNumber(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `Decimal.value = unscaledValue * 10^-scale` (§5.6's `number`) — compared at their common (larger) scale. */
export function compareDecimal(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const av = a.unscaledValue * 10n ** BigInt(scale - a.scale);
  const bv = b.unscaledValue * 10n ** BigInt(scale - b.scale);
  return compareBigint(av, bv);
}

/** `2/4` compares equal to `1/2` (§5.6's `rational`) — denominators are always strictly positive, so cross-multiplication preserves order. */
export function compareRational(a: Rational, b: Rational): number {
  return compareBigint(a.numerator * b.denominator, b.numerator * a.denominator);
}

/** Floor division for a `bigint` divisor, needed because BigInt's own `/` truncates toward zero. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/**
 * Proleptic-Gregorian day number (days since 1970-01-01), Howard Hinnant's `days_from_civil`
 * algorithm — exact integer arithmetic, correct for any year including years before 1 CE, unlike
 * `Date.UTC` (which is IEEE-754 `double`-based and drifts for very large years).
 */
function daysFromCivil(year: number, month: number, day: number): bigint {
  const y = BigInt(month <= 2 ? year - 1 : year);
  const era = floorDiv(y >= 0n ? y : y - 399n, 400n);
  const yoe = y - era * 400n;
  const m = BigInt(month);
  const doy = floorDiv(153n * (m + (month > 2 ? -3n : 9n)) + 2n, 5n) + BigInt(day) - 1n;
  const doe = yoe * 365n + floorDiv(yoe, 4n) - floorDiv(yoe, 100n) + doy;
  return era * 146097n + doe - 719468n;
}

export function compareCalendarDate(a: CalendarDate, b: CalendarDate): number {
  return compareBigint(
    daysFromCivil(a.year, a.month, a.day),
    daysFromCivil(b.year, b.month, b.day),
  );
}

/** Nanoseconds since the Unix epoch instant, normalised for the UTC offset — the shared axis every RFC 3339 bound compares on. */
function timeOfDayNanos(
  hour: number,
  minute: number,
  second: number,
  nanosecond: number,
  offsetSeconds: number,
): bigint {
  const localSeconds = BigInt(hour) * 3600n + BigInt(minute) * 60n + BigInt(second);
  return (localSeconds - BigInt(offsetSeconds)) * 1_000_000_000n + BigInt(nanosecond);
}

/** Compares two times-of-day as instants on a shared (arbitrary, but identical) day — correct regardless of which offset either was written in. */
export function compareOffsetTime(a: OffsetTime, b: OffsetTime): number {
  return compareBigint(
    timeOfDayNanos(a.time.hour, a.time.minute, a.time.second, a.time.nanosecond, a.offsetSeconds),
    timeOfDayNanos(b.time.hour, b.time.minute, b.time.second, b.time.nanosecond, b.offsetSeconds),
  );
}

export function compareOffsetDateTime(a: OffsetDateTime, b: OffsetDateTime): number {
  const ai =
    daysFromCivil(a.date.year, a.date.month, a.date.day) * 86_400_000_000_000n +
    timeOfDayNanos(a.time.hour, a.time.minute, a.time.second, a.time.nanosecond, a.offsetSeconds);
  const bi =
    daysFromCivil(b.date.year, b.date.month, b.date.day) * 86_400_000_000_000n +
    timeOfDayNanos(b.time.hour, b.time.minute, b.time.second, b.time.nanosecond, b.offsetSeconds);
  return compareBigint(ai, bi);
}
