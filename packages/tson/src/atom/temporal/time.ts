/**
 * Parses and validates against meta-kernel's `time_type` constructor (§5.4's `!time` atom, RFC
 * 3339 `full-time`) -- the port of `atom/TimeParser.java`.
 *
 * No host `Date`/`Temporal` and no JDK `OffsetTime` to delegate to; `rfc3339.ts`'s
 * `readFullTime` is a single hand-written pass covering both the shape check and the
 * range/leap-second/offset-bound checks the Java original splits between its own shape regex
 * and `OffsetTime.parse`'s own validation. See `rfc3339.ts`'s TSDoc for the leap-second gap
 * (`time-second` of 60 rejected -- `CONFORMANCE.md`'s "one accepted, unfixable gap") and the
 * ±18:00 offset bound this inherits from `java.time.ZoneOffset`.
 *
 * **`precision`/`requireTimezone` are refused, matching `TimeParser.java`'s compact-constructor
 * guard exactly.** `TimeType` (`schema/meta/atoms-temporal.ts`) carries both fields because a
 * resolved body must mirror its constructor's full shape, but neither is enforced by this atom:
 * `precision`'s required semantics (exact vs. maximum fractional-digit count) are unsettled by
 * the spec, and `require_timezone: false` would need an offset-less parse path RFC 3339's
 * `full-time` -- offset mandatory -- doesn't have. A schema that sets either is refused outright
 * (a {@link TsonNotImplementedError} at parser construction) rather than silently accepted and
 * ignored, the same "surfaced gap, not a silent one" call the Java's own comment explains.
 */

import {
  TsonAtomParseError,
  TsonAtomValidationError,
  TsonNotImplementedError,
} from '../../core/errors.js';
import type { TimeType } from '../../schema/meta/atoms-temporal.js';
import type { PlainTime } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';
import { type ComparableTime, compareTime, formatFullTime, readFullTime } from './rfc3339.js';

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
 *
 * @throws {@link TsonNotImplementedError} if `constraints` sets `precision` or
 *   `requireTimezone` -- see this module's own TSDoc.
 */
export function createTimeParser(typeRef: string, constraints: TimeType): AtomType<PlainTime> {
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
