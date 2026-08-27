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
 * **`precision`/`requireTimezone` are refused**, the same guard `time.ts` has and for the same
 * reason -- see that module's TSDoc.
 */

import {
  TsonAtomParseError,
  TsonAtomValidationError,
  TsonNotImplementedError,
} from '../../core/errors.js';
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
 *
 * @throws {@link TsonNotImplementedError} if `constraints` sets `precision` or
 *   `requireTimezone` -- see `time.ts`'s TSDoc.
 */
export function createDateTimeParser(
  typeRef: string,
  constraints: DateTimeType,
): AtomType<PlainDateTime> {
  if (constraints.precision !== undefined) {
    throw new TsonNotImplementedError(
      `'${typeRef}' does not enforce 'precision' yet, so a schema setting it would be accepted ` +
        'without the constraint being applied -- the spec does not say whether it bounds the ' +
        'fractional-second digits exactly or at most, and this implementation will not guess. ' +
        'Drop it, or constrain the value another way',
    );
  }
  if (constraints.requireTimezone !== undefined) {
    throw new TsonNotImplementedError(
      `'${typeRef}' does not enforce 'requireTimezone' yet, so a schema setting it would be ` +
        'accepted without the constraint being applied. RFC 3339 requires an offset on every ' +
        "value this atom accepts, so 'true' is already the behaviour; 'false' needs an " +
        'offset-less parse this atom does not have',
    );
  }

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
