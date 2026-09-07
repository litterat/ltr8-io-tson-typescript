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
 * **`min`/`max` are not enforced here yet.** The value space is totally ordered — an exact
 * nanosecond count — so the bounds are enforceable, which is exactly what the split from `period`
 * bought ([TSON-SCHEMA] §5.5, §5.7). What is missing is a bound to compare against:
 * `duration_type`'s bounds are `value`-typed, meaning the resolver reads each under the atom the
 * slot stands for and stores the result (§5.2, §7.4), and `DurationType.min`/`.max`
 * (`schema/meta/atoms-temporal.ts`) still carry the raw ISO 8601 text. Parsing that text here
 * instead would put the reading in the wrong layer and give a facet a second, private notion of
 * what its value is.
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
 * {}`. `constraints` is accepted for structural symmetry with every other `create*Parser` factory
 * in `atom/temporal/` and to carry `min`/`max` through unevaluated -- see this module's own TSDoc
 * on why they are not checked here.
 */
export function createDurationParser(
  typeRef: string,
  constraints: DurationType,
): AtomType<TsonDuration> {
  // `constraints.min`/`.max` are not read here: they are still raw text, and reading them is the
  // resolver's job under §5.2's value-typed facet rule -- see this module's own TSDoc.
  void constraints;

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
    return { nanoseconds };
  }

  /** {@link formatIsoDuration} already gives the single canonical `PTnHnMnS` form. */
  function write(value: TsonDuration): string {
    return formatIsoDuration(value.nanoseconds);
  }

  return { read, write };
}
