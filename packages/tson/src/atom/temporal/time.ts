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
 * **`precision` bounds the written fractional-second digits (§5.5), never a truncation
 * instruction.** `precision: N` admits a token whose fractional-second part has at most `N`
 * digits, judged on the token as written -- `12:00:00.100` has three digits whatever instant it
 * denotes, so this is counted from `token.text` directly rather than derived from the parsed
 * `nanosecond` value, which would lose exactly that distinction (`.1`/`.10`/`.100` all parse to
 * the same nanosecond count). `precision: 0` admits no fractional part at all.
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

/**
 * The written fractional-second digit count of a `full-time`/`date-time` token's time part --
 * `.100` counts three, trailing zeros included, matching §5.5's "judged on the written token"
 * rule for `precision` exactly. Zero when there is no fractional part at all. A local re-scan
 * rather than a value `readFullTime` itself returns: that function already discards this exact
 * distinction on the way to a single `nanosecond` integer (`.1`/`.10`/`.100` all parse to
 * 100000000ns), so recovering it means looking at the text again, not at the parsed value.
 */
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
