/**
 * Parses and validates against meta-kernel's `time_type` constructor (§5.4's `!time` atom, RFC
 * 3339 `full-time`) -- the port of `atom/TimeParser.java`.
 *
 * No host `Date`/`Temporal` and no JDK `OffsetTime` to delegate to; `rfc3339.ts`'s
 * `readFullTime` is a single hand-written pass covering both the shape check and the
 * range/leap-second/offset-bound checks the Java original splits between its own shape regex
 * and `OffsetTime.parse`'s own validation. See `rfc3339.ts`'s TSDoc for the leap second
 * (`time-second` of 60, refused by §5.4) and the
 * ±18:00 offset bound this inherits from `java.time.ZoneOffset`.
 *
 * **`precision` bounds the *value*, never the spelling (§5.5).** `precision: N` admits a value
 * that is a whole number of 10⁻ᴺ seconds -- tested on the parsed `nanosecond` field, not on how
 * many fractional digits the token happened to write: `12:00:00.500` and a hypothetical
 * `12:00:00.5000` denote the same nanosecond count and are both admitted or both refused
 * together under `precision: 1`. `precision: 0` admits only a whole second. `formatFullTime`'s
 * own trailing-zero trimming already writes at most `N` digits for any value that passes this
 * check, so there is nothing further for the writer to do.
 *
 * **No `requireTimezone` facet exists** -- RFC 3339 `full-time`, which this atom's `spec` pins,
 * already makes the offset mandatory, so a facet requiring it would be vacuous and one relaxing
 * it would widen the atom against its own pin (§5.5). `TimeType` carries no such field.
 */

import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import type { TimeType } from '../../schema/meta/atoms-temporal.js';
import type { PlainTime } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';
import { type ComparableTime, compareTime, formatFullTime, readFullTime } from './rfc3339.js';

/** Whether `nanosecond` is a whole number of 10⁻ᴺ seconds -- the `precision: N` value grid (§5.5), shared by `datetime.ts`'s identical check. */
function onPrecisionGrid(nanosecond: number, precision: bigint): boolean {
  const divisor = 10 ** (9 - Number(precision));
  return nanosecond % divisor === 0;
}

function toComparable(value: PlainTime): ComparableTime {
  return {
    hour: value.hour,
    minute: value.minute,
    second: value.second,
    nanosecond: value.nanosecond,
    offsetSeconds: value.offset.totalMinutes * 60,
  };
}

/**
 * Builds the `AtomType` for one fully-parameterised `time_type` instance. `typeRef` names the
 * type for error reporting, e.g. `'time'` for §5.4's unconstrained `time => !time_type {}`.
 */
export function createTimeParser(typeRef: string, constraints: TimeType): AtomType<PlainTime> {
  function read(token: AtomToken): PlainTime {
    const text = token.text;
    const fields = readFullTime(text, 0);
    if (fields === undefined) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid time -- expected RFC 3339 full-time, ` +
          'HH:MM:SS[.fraction](Z|+HH:MM) (§5.4)',
        'an RFC 3339 full-time',
      );
    }
    const value: PlainTime = {
      hour: fields.hour,
      minute: fields.minute,
      second: fields.second,
      nanosecond: fields.nanosecond,
      offset: { totalMinutes: fields.offsetMinutes },
    };
    if (
      constraints.precision !== undefined &&
      !onPrecisionGrid(value.nanosecond, constraints.precision)
    ) {
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is not a whole number of 10^-${constraints.precision.toString()} seconds (§5.5)`,
        `on the precision-${constraints.precision.toString()} grid`,
      );
    }
    if (constraints.min !== undefined) {
      const bound = constraints.min;
      if (
        compareTime(toComparable(value), { ...bound.time, offsetSeconds: bound.offsetSeconds }) < 0
      ) {
        const boundText = formatFullTime({
          ...bound.time,
          offsetMinutes: Math.round(bound.offsetSeconds / 60),
        });
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
        compareTime(toComparable(value), { ...bound.time, offsetSeconds: bound.offsetSeconds }) > 0
      ) {
        const boundText = formatFullTime({
          ...bound.time,
          offsetMinutes: Math.round(bound.offsetSeconds / 60),
        });
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' is after the maximum ${boundText}`,
          `<= ${boundText}`,
        );
      }
    }
    return value;
  }

  /** {@link formatFullTime} already gives RFC 3339's exact `full-time` form. */
  function write(value: PlainTime): string {
    return formatFullTime({
      hour: value.hour,
      minute: value.minute,
      second: value.second,
      nanosecond: value.nanosecond,
      offsetMinutes: value.offset.totalMinutes,
    });
  }

  return { read, write };
}
