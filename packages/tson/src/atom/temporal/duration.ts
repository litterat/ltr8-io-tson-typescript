/**
 * Parses and validates against meta's `duration_type` constructor (§5.4's `!duration` atom) --
 * the port of `atom/DurationParser.java`.
 *
 * Grammar recognition lives in `isoDuration.ts` (`tryParseIsoDuration`/`formatIsoDuration`); this
 * module is the `AtomType` wiring plus the one check the grammar itself cannot make: whether the
 * parsed value fits the family's own magnitude ceiling.
 *
 * **The value space is a signed exact count of nanoseconds, capped at 2^63 − 1 in magnitude**
 * (§5.4) -- about 292 years, stated as a magnitude rather than as the asymmetric `int64` range so
 * that negating an admitted duration always yields an admitted one. A token that is not shaped
 * like a duration at all is a {@link TsonAtomParseError} (`isoDuration.ts` returning `undefined`);
 * one that parses but whose magnitude exceeds the ceiling is a {@link TsonAtomValidationError} --
 * the token denoted a real ISO 8601 span, it is simply longer than this value space carries.
 *
 * **`min`/`exclusive_min`/`max`/`exclusive_max`/`multiple_of`/`precision` are all enforced
 * against the *value* — the exact nanosecond count, never the written form** ([TSON-SCHEMA] §5.5,
 * §5.7): the value space is totally ordered, which is exactly what the split from `period` bought.
 * `duration_type`'s bounds and step are read under `duration`'s own atom at schema load
 * (`schema/metaReader.ts`/`schema/bindings.ts`'s own `durationBoundBinding`), so `DurationType`'s
 * fields (`schema/meta/atoms-temporal.ts`) already hold the resolved `bigint` this module compares
 * against directly. `multiple_of` tests the magnitude with the sign ignored (§5.7); `precision`
 * admits a value that is a whole number of 10⁻ᴺ seconds (§5.5) — tested on the nanosecond count
 * itself, since `precision` constrains the *value*, not a spelling: `formatIsoDuration`'s own
 * trailing-zero trimming already writes at most `N` digits for any value that passes this check.
 */

import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import type { DurationType } from '../../schema/meta/atoms-temporal.js';
import type { TsonDuration } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';
import { formatIsoDuration, tryParseIsoDuration } from './isoDuration.js';

/** 2^63 − 1: the widest nanosecond magnitude a duration carries (§5.4). */
const MAX_DURATION_NANOSECONDS = 9_223_372_036_854_775_807n;

/**
 * Builds the `AtomType` for one fully-parameterised `duration_type` instance. `typeRef` names the
 * type for error reporting, e.g. `'duration'` for §5.4's unconstrained `duration => !duration_type
 * {}`.
 */
export function createDurationParser(
  typeRef: string,
  constraints: DurationType,
): AtomType<TsonDuration> {
  function validate(nanoseconds: bigint, text: string): void {
    const { min, exclusiveMin, max, exclusiveMax, multipleOf, precision } = constraints;
    if (min !== undefined && nanoseconds < min) {
      const bound = formatIsoDuration(min);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is less than the minimum ${bound}`,
        `>= ${bound}`,
      );
    }
    if (exclusiveMin !== undefined && nanoseconds <= exclusiveMin) {
      const bound = formatIsoDuration(exclusiveMin);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' must be strictly greater than ${bound}`,
        `> ${bound}`,
      );
    }
    if (max !== undefined && nanoseconds > max) {
      const bound = formatIsoDuration(max);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is greater than the maximum ${bound}`,
        `<= ${bound}`,
      );
    }
    if (exclusiveMax !== undefined && nanoseconds >= exclusiveMax) {
      const bound = formatIsoDuration(exclusiveMax);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' must be strictly less than ${bound}`,
        `< ${bound}`,
      );
    }
    if (multipleOf !== undefined) {
      const magnitude = nanoseconds < 0n ? -nanoseconds : nanoseconds;
      const step = multipleOf < 0n ? -multipleOf : multipleOf;
      if (magnitude % step !== 0n) {
        const of = formatIsoDuration(multipleOf);
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' is not a multiple of ${of}`,
          `a multiple of ${of}`,
        );
      }
    }
    if (precision !== undefined) {
      const magnitude = nanoseconds < 0n ? -nanoseconds : nanoseconds;
      const divisor = 10n ** (9n - precision);
      if (magnitude % divisor !== 0n) {
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' is not a whole number of 10^-${precision.toString()} seconds`,
          `on the precision-${precision.toString()} grid`,
        );
      }
    }
  }

  function read(token: AtomToken): TsonDuration {
    const text = token.text;
    const nanoseconds = tryParseIsoDuration(text);
    if (nanoseconds === undefined) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid duration -- expected the RFC 3339 Appendix A dur-date/dur-time/` +
          'dur-week form without a Y or month-M component (a month is a period, a minute is PT1M), ' +
          'the week form standing alone, uppercase designators only, and at least one designator ' +
          'present (§5.4)',
        'a duration',
      );
    }
    const magnitude = nanoseconds < 0n ? -nanoseconds : nanoseconds;
    if (magnitude > MAX_DURATION_NANOSECONDS) {
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is longer than ${MAX_DURATION_NANOSECONDS.toString()} nanoseconds, the widest ` +
          'magnitude a duration carries -- a span this long is a calendar span (a period) or a ' +
          'quantity in a unit a schema names (§5.4)',
        `a magnitude of at most ${MAX_DURATION_NANOSECONDS.toString()} nanoseconds`,
      );
    }
    validate(nanoseconds, text);
    return { nanoseconds };
  }

  /** {@link formatIsoDuration} already gives the single canonical `PTnHnMnS` form. */
  function write(value: TsonDuration): string {
    return formatIsoDuration(value.nanoseconds);
  }

  return { read, write };
}
