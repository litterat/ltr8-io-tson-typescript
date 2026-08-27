/**
 * Hand-written RFC 3339 `full-date`/`full-time` grammar, shared by {@link ../date.js},
 * {@link ../time.js} and {@link ../datetime.js} (§5.4). No `RegExp` and no host `Date` --
 * per this package's hard constraints, the number grammar's "one function per ABNF rule, no
 * regex" discipline (`CLAUDE.md`) extends here for the same reason it applies there: a token is
 * already fully decoded text by the time an atom sees it, so a hand-scanned character walk is
 * both the simplest and the most auditable way to enforce a grammar this exact.
 *
 * **Deliberately stricter than a JDK delegate, per `CONFORMANCE.md`.** `LocalDate`/`OffsetTime`/
 * `OffsetDateTime.parse()` all accept ISO 8601's "extended year" form -- a leading sign, or a
 * year of more than four digits -- which RFC 3339's `full-date = date-fullyear "-" date-month
 * "-" date-mday` (`date-fullyear = 4DIGIT`, no sign) does not permit. Because this grammar is
 * hand-scanned from scratch rather than delegated to any host parser, that leniency has nothing
 * to leak in through: `readYear` reads exactly four digit characters and stops, never a `+`/`-`
 * lead-in and never a fifth digit.
 *
 * `readFullDate`/`readFullTime` each take a start offset and return the value together with the
 * index just past what they consumed, rather than requiring the whole string -- `datetime.ts`
 * needs to parse a `full-date`, check for the `"T"`/`"t"` separator itself, and then parse a
 * `full-time` starting mid-string. `date.ts`/`time.ts` each require the returned index to equal
 * `text.length` (nothing trails what they parsed); `datetime.ts` does that same full-consumption
 * check only on the trailing `full-time` half.
 */

/** A calendar date, matching {@link PlainDate}'s (`value/types.ts`) and `schema/meta`'s
 * `CalendarDate`'s (`schema/meta/atoms-temporal.ts`) shared field shape -- deliberately untyped
 * against either import, so this module stays a pure grammar with no dependency on the value or
 * schema layers. */
export interface DateFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** A time-of-day with its offset in whole minutes -- see {@link DateFields}'s own note on why
 * this is a structural shape rather than an import of `PlainTime`/`LocalTime`. */
export interface TimeFields {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly nanosecond: number;
  readonly offsetMinutes: number;
}

const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;

function isDigit(code: number): boolean {
  return code >= ASCII_ZERO && code <= ASCII_NINE;
}

/** Reads exactly `count` ASCII digit characters at `pos`, or fails -- never a sign, never fewer
 * or more than `count`. This is what keeps a year to exactly four digits and no leading `+`/`-`
 * (RFC 3339's `full-date`, rejecting ISO 8601's "extended year" form; see this module's own
 * TSDoc and `CONFORMANCE.md`). */
function readDigits(text: string, pos: number, count: number): number | undefined {
  if (pos + count > text.length) return undefined;
  let value = 0;
  for (let i = 0; i < count; i++) {
    const code = text.charCodeAt(pos + i);
    if (!isDigit(code)) return undefined;
    value = value * 10 + (code - ASCII_ZERO);
  }
  return value;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Days in `month` (1-12) for `year`, February's leap adjustment included. */
function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `month` is checked 1-12 by the caller before this runs.
  return DAYS_IN_MONTH[month - 1]!;
}

/**
 * `full-date = date-fullyear "-" date-month "-" date-mday` starting at `pos` -- exactly ten
 * characters, `YYYY-MM-DD`, month and day range- and calendar-checked (a non-leap February 29th
 * fails here, the same way `LocalDate.parse` rejecting it becomes a parse error in the Java
 * `DateParser`, not a validation one -- the token never denotes a real date at all).
 */
export function readFullDate(
  text: string,
  pos: number,
): { value: DateFields; next: number } | undefined {
  const year = readDigits(text, pos, 4);
  if (year === undefined) return undefined;
  if (text.charCodeAt(pos + 4) !== 0x2d /* '-' */) return undefined;
  const month = readDigits(text, pos + 5, 2);
  if (month === undefined || month < 1 || month > 12) return undefined;
  if (text.charCodeAt(pos + 7) !== 0x2d /* '-' */) return undefined;
  const day = readDigits(text, pos + 8, 2);
  if (day === undefined || day < 1 || day > daysInMonth(year, month)) return undefined;
  return { value: { year, month, day }, next: pos + 10 };
}

/**
 * `full-time = partial-time time-offset` starting at `pos`, consuming to the end of `text` --
 * `partial-time = time-hour ":" time-minute ":" time-second [time-secfrac]`, `time-offset = "Z" /
 * time-numoffset`. The offset is mandatory (never optional -- a bare local time with no `Z`/
 * numeric offset fails, RFC 3339's own grammar has no alternative that omits it), and `"T"`/`"Z"`
 * case-insensitivity is the caller's concern (`datetime.ts` checks the separator itself; the `Z`
 * here is read case-insensitively directly).
 *
 * **`time-second` of 60 (leap-second accommodation) is rejected.** `java.time` has no
 * leap-second concept at all, and `CONFORMANCE.md` documents the reference implementation
 * accepting this as a gap rather than solving it with a from-scratch leap-second-aware time
 * type; this grammar follows the same limit (§5.4, `PlainTime`'s own TSDoc in `value/types.ts`).
 *
 * **A numeric offset beyond ±18:00 is rejected**, even though `time-hour`/`time-minute` alone
 * would admit up to 23:59 -- `PlainTime`'s own `UtcOffset` field documents the ±1080-minute
 * bound as RFC 3339's real, `java.time.ZoneOffset`-confirmed limit, not merely the two-digit
 * field widths.
 *
 * **A fractional second past nine digits is rejected**, rather than silently truncated. §5.2
 * requires a parsed value's information content to be preserved; `PlainTime.nanosecond` cannot
 * hold a tenth digit, and dropping it silently would violate that requirement rather than
 * satisfy it. This is this port's own choice where the spec's grammar is silent on a maximum
 * `time-secfrac` width -- see this package's spec-feedback notes.
 */
export function readFullTime(text: string, pos: number): TimeFields | undefined {
  const hour = readDigits(text, pos, 2);
  if (hour === undefined || hour > 23) return undefined;
  if (text.charCodeAt(pos + 2) !== 0x3a /* ':' */) return undefined;
  const minute = readDigits(text, pos + 3, 2);
  if (minute === undefined || minute > 59) return undefined;
  if (text.charCodeAt(pos + 5) !== 0x3a /* ':' */) return undefined;
  const second = readDigits(text, pos + 6, 2);
  if (second === undefined || second > 59) return undefined;

  let cursor = pos + 8;
  let nanosecond = 0;
  if (text.charCodeAt(cursor) === 0x2e /* '.' */) {
    let digits = 0;
    let value = 0;
    let i = cursor + 1;
    while (i < text.length && isDigit(text.charCodeAt(i))) {
      if (digits < 9) {
        value = value * 10 + (text.charCodeAt(i) - ASCII_ZERO);
      }
      digits++;
      i++;
    }
    if (digits === 0 || digits > 9) return undefined;
    for (let pad = digits; pad < 9; pad++) value *= 10;
    nanosecond = value;
    cursor = i;
  }

  const offsetChar = text.charCodeAt(cursor);
  let offsetMinutes: number;
  if (offsetChar === 0x5a /* 'Z' */ || offsetChar === 0x7a /* 'z' */) {
    offsetMinutes = 0;
    cursor += 1;
  } else if (offsetChar === 0x2b /* '+' */ || offsetChar === 0x2d /* '-' */) {
    const sign = offsetChar === 0x2b ? 1 : -1;
    const offHour = readDigits(text, cursor + 1, 2);
    if (offHour === undefined || offHour > 23) return undefined;
    if (text.charCodeAt(cursor + 3) !== 0x3a /* ':' */) return undefined;
    const offMinute = readDigits(text, cursor + 4, 2);
    if (offMinute === undefined || offMinute > 59) return undefined;
    offsetMinutes = sign * (offHour * 60 + offMinute);
    if (offsetMinutes < -1080 || offsetMinutes > 1080) return undefined;
    cursor += 6;
  } else {
    return undefined;
  }

  if (cursor !== text.length) return undefined;
  return { hour, minute, second, nanosecond, offsetMinutes };
}

/** `YYYY-MM-DD`, zero-padded -- the exact `full-date` form, always four digits since `year` was
 * itself read as exactly four (this port never produces a `DateFields` with a wider year). */
export function formatFullDate(value: DateFields): string {
  const y = String(value.year).padStart(4, '0');
  const m = String(value.month).padStart(2, '0');
  const d = String(value.day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The fractional-second digits, trailing zeros trimmed -- e.g. `500000000` ns -> `"5"`,
 * `123000000` ns -> `"123"`. Shared with `duration.ts`'s own seconds formatting (§5.4's
 * `PnYnMnDTnHnMnS` seconds designator has the same fractional shape). */
export function fractionDigits(nanosecond: number): string {
  const nineDigits = String(nanosecond).padStart(9, '0');
  let end = nineDigits.length;
  while (end > 1 && nineDigits.charCodeAt(end - 1) === ASCII_ZERO) end--;
  return nineDigits.slice(0, end);
}

/** `"Z"` for a zero offset (RFC 3339 treats `Z` and `+00:00` as the same offset, and §5.4's
 * canonical form always writes the former -- confirmed by the conformance suite's own
 * `datetime-lowercase-t-and-z` sidecar, which asserts a lowercase `z` reads back as `Z`), else
 * signed `±HH:MM`. */
export function formatOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return 'Z';
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.trunc(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/** `HH:MM:SS[.fraction]±HH:MM` / `...Z` -- the exact `full-time` form. */
export function formatFullTime(value: TimeFields): string {
  const h = String(value.hour).padStart(2, '0');
  const m = String(value.minute).padStart(2, '0');
  const s = String(value.second).padStart(2, '0');
  const frac = value.nanosecond !== 0 ? `.${fractionDigits(value.nanosecond)}` : '';
  return `${h}:${m}:${s}${frac}${formatOffset(value.offsetMinutes)}`;
}

/** Proleptic-Gregorian days since the 1970-01-01 epoch (Howard Hinnant's `days_from_civil`) --
 * used only to compare two dates (or the date half of a datetime) by absolute ordering, never to
 * format or round-trip a value, so no host `Date` is needed for it. Exact for every `year` this
 * grammar can ever produce (`0000`-`9999`, `full-date`'s four-digit range), and correct for a
 * negative year too, so a bound authored outside that range still orders sensibly. */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400; // [0, 399]
  const mp = month > 2 ? month - 3 : month + 9; // [0, 11]
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/** `-1`/`0`/`1` comparing two dates by calendar order. */
export function compareDate(a: DateFields, b: DateFields): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

/**
 * A time-of-day shaped for comparison only: offset already reduced to whole seconds. Deliberately
 * *not* {@link TimeFields} -- that shape carries `offsetMinutes` (matching `PlainTime`'s own
 * `UtcOffset.totalMinutes`, `value/types.ts`), while `schema/meta`'s `TimeType`/`DateTimeType`
 * bounds carry their offset as `offsetSeconds` (matching `OffsetTime`'s own field,
 * `schema/meta/atoms-temporal.ts`). Rather than force one shape to fit both, `time.ts`/
 * `datetime.ts` each adapt their own value and bound into this one at the comparison call site.
 */
export interface ComparableTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly nanosecond: number;
  readonly offsetSeconds: number;
}

/** Whole seconds since local midnight, offset applied -- e.g. `10:15:30+05:30` and
 * `04:45:30Z` both give the same value. Used, alone, to compare two times-of-day (no shared
 * date); combined with {@link daysFromCivil} to compare two datetimes. */
function timeInstantSeconds(
  hour: number,
  minute: number,
  second: number,
  offsetSeconds: number,
): number {
  return hour * 3600 + minute * 60 + second - offsetSeconds;
}

/** `-1`/`0`/`1` comparing two times-of-day by instant (offset-normalised), nanosecond as the
 * final tie-break -- {@link ComparableTime}'s own TSDoc note on why this isn't plain
 * field-by-field comparison: two different offsets can still name the same instant. */
export function compareTime(a: ComparableTime, b: ComparableTime): number {
  const ai = timeInstantSeconds(a.hour, a.minute, a.second, a.offsetSeconds);
  const bi = timeInstantSeconds(b.hour, b.minute, b.second, b.offsetSeconds);
  if (ai !== bi) return ai - bi;
  return a.nanosecond - b.nanosecond;
}

/** `-1`/`0`/`1` comparing two datetimes by absolute instant -- date and time-of-day combined via
 * {@link daysFromCivil}/`timeInstantSeconds`, each offset-normalised independently before the
 * two are combined, so a bound written in one offset compares correctly against a value written
 * in another. */
export function compareDateTime(
  aDate: DateFields,
  aTime: ComparableTime,
  bDate: DateFields,
  bTime: ComparableTime,
): number {
  const aTotal =
    daysFromCivil(aDate.year, aDate.month, aDate.day) * 86400 +
    timeInstantSeconds(aTime.hour, aTime.minute, aTime.second, aTime.offsetSeconds);
  const bTotal =
    daysFromCivil(bDate.year, bDate.month, bDate.day) * 86400 +
    timeInstantSeconds(bTime.hour, bTime.minute, bTime.second, bTime.offsetSeconds);
  if (aTotal !== bTotal) return aTotal - bTotal;
  return aTime.nanosecond - bTime.nanosecond;
}
