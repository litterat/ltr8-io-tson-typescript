/**
 * Parses and validates against meta-kernel's `datetime_type` constructor (§5.4's `!datetime`
 * atom, RFC 3339 `date-time = full-date "T" full-time`) -- the port of `atom/DateTimeParser.java`.
 *
 * Composed from `date.ts`/`time.ts`'s own `rfc3339.ts` primitives rather than duplicating either
 * grammar: `readFullDate` for the first ten characters, an explicit case-insensitive `"T"`/`"t"`
 * separator check (this is what rejects a space in place of it -- RFC 3339's `date-time`
 * production names the separator literally, and a space is a different, non-conforming
 * date-time profile some other formats accept), then `readFullTime` for the rest. Both halves
 * inherit their own strictness from `rfc3339.ts` -- the four-digit no-sign year, the ±18:00
 * offset bound, the leap-second gap -- with nothing extra to add here.
 *
 * **`precision` bounds the written fractional-second digits, and no `requireTimezone` facet
 * exists** -- the same contract `time.ts` implements and documents in full (§5.5); this module
 * shares its own local `writtenFractionDigits` re-scan rather than importing it, for the same
 * reason `rfc3339.ts`'s own `nanosecond` field can't stand in for it there either.
 */

import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import type { DateTimeType } from '../../schema/meta/atoms-temporal.js';
import type { PlainDateTime } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';
import {
  type ComparableTime,
  compareDateTime,
  formatFullDate,
  formatFullTime,
  readFullDate,
  readFullTime,
} from './rfc3339.js';

/** See `time.ts`'s own `writtenFractionDigits` -- the identical re-scan, over the same
 * `full-time` fractional-second shape that sits at the end of a `date-time` token too. */
function writtenFractionDigits(text: string): number {
  const dot = text.indexOf('.');
  if (dot === -1) return 0;
  let count = 0;
  let i = dot + 1;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code < 0x30 || code > 0x39) break;
    count++;
    i++;
  }
  return count;
}

function toComparableTime(value: PlainDateTime): ComparableTime {
  return {
    hour: value.time.hour,
    minute: value.time.minute,
    second: value.time.second,
    nanosecond: value.time.nanosecond,
    offsetSeconds: value.time.offset.totalMinutes * 60,
  };
}

function formatBound(bound: NonNullable<DateTimeType['min']>): string {
  const date = formatFullDate(bound.date);
  const time = formatFullTime({
    ...bound.time,
    offsetMinutes: Math.round(bound.offsetSeconds / 60),
  });
  return `${date}T${time}`;
}

/**
 * Builds the `AtomType` for one fully-parameterised `datetime_type` instance. `typeRef` names
 * the type for error reporting, e.g. `'datetime'` for §5.4's unconstrained
 * `datetime => !datetime_type {}`.
 */
export function createDateTimeParser(
  typeRef: string,
  constraints: DateTimeType,
): AtomType<PlainDateTime> {
  function fail(text: string): never {
    throw new TsonAtomParseError(
      typeRef,
      `'${text}' is not a valid datetime -- expected RFC 3339 date-time, ` +
        'YYYY-MM-DDTHH:MM:SS[.fraction](Z|+HH:MM) (§5.4)',
      'an RFC 3339 date-time',
    );
  }

  function read(token: AtomToken): PlainDateTime {
    const text = token.text;
    const datePart = readFullDate(text, 0);
    if (datePart === undefined) fail(text);
    const separator = text.charCodeAt(datePart.next);
    if (separator !== 0x54 /* 'T' */ && separator !== 0x74 /* 't' */) fail(text);
    const timePart = readFullTime(text, datePart.next + 1);
    if (timePart === undefined) fail(text);

    const value: PlainDateTime = {
      date: datePart.value,
      time: {
        hour: timePart.hour,
        minute: timePart.minute,
        second: timePart.second,
        nanosecond: timePart.nanosecond,
        offset: { totalMinutes: timePart.offsetMinutes },
      },
    };

    if (constraints.precision !== undefined) {
      const digits = writtenFractionDigits(text);
      if (BigInt(digits) > constraints.precision) {
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' has ${String(digits)} fractional-second digits, more than the maximum ` +
            `${constraints.precision.toString()} (§5.5)`,
          `at most ${constraints.precision.toString()} fractional-second digits`,
        );
      }
    }
    if (constraints.min !== undefined) {
      const bound = constraints.min;
      if (
        compareDateTime(value.date, toComparableTime(value), bound.date, {
          ...bound.time,
          offsetSeconds: bound.offsetSeconds,
        }) < 0
      ) {
        const boundText = formatBound(bound);
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' is before the minimum ${boundText}`,
          `>= ${boundText}`,
        );
      }
    }
    if (constraints.max !== undefined) {
      const bound = constraints.max;
      if (
        compareDateTime(value.date, toComparableTime(value), bound.date, {
          ...bound.time,
          offsetSeconds: bound.offsetSeconds,
        }) > 0
      ) {
        const boundText = formatBound(bound);
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' is after the maximum ${boundText}`,
          `<= ${boundText}`,
        );
      }
    }
    return value;
  }

  /** `full-date` + `"T"` + `full-time`, each in its own exact canonical form. */
  function write(value: PlainDateTime): string {
    const date = formatFullDate(value.date);
    const time = formatFullTime({
      hour: value.time.hour,
      minute: value.time.minute,
      second: value.time.second,
      nanosecond: value.time.nanosecond,
      offsetMinutes: value.time.offset.totalMinutes,
    });
    return `${date}T${time}`;
  }

  return { read, write };
}
