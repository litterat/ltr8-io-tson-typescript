/**
 * Parses and validates against meta-kernel's `duration_type` constructor (§5.4's `!duration`
 * atom, ISO 8601's `PnYnMnDTnHnMnS`) -- the port of `atom/DurationParser.java`.
 *
 * Grammar recognition itself lives in `isoDuration.ts` (`tryParseIsoDuration`/
 * `formatIsoDuration`); this module is only the `AtomType` wiring plus the two "designator
 * required" and "combined form" edge cases the grammar module itself already enforces --
 * matching `CONFORMANCE.md`'s account of the Java's own split between "at least one designator"
 * and "T with no clock designators" both being checked after the shape match succeeds.
 *
 * **`min`/`max` are not validated, matching `DurationParser.java` exactly.** `DurationType`'s own
 * TSDoc (`schema/meta/atoms-temporal.ts`) already states why: they're raw ISO 8601 text, not a
 * host duration type, and `CONFORMANCE.md` records the reference implementation's own reasoning
 * for leaving them unenforced -- a calendar-based duration (`P1M`, one calendar month) has no
 * fixed length to compare against a clock-based one (`P1M` is 28-31 days depending on when it's
 * applied), so no built-in instance sets either bound and no coherent partial-order comparison
 * is implemented for this family. Carrying the fields on `DurationType` without enforcing them
 * mirrors the constructor's resolved shape faithfully while leaving the actual comparison to
 * whichever later work package decides how a calendar/clock partial order should behave.
 */

import { TsonAtomParseError } from '../../core/errors.js';
import type { DurationType } from '../../schema/meta/atoms-temporal.js';
import type { TsonDuration } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';
import { formatIsoDuration, tryParseIsoDuration } from './isoDuration.js';

/**
 * Builds the `AtomType` for one fully-parameterised `duration_type` instance. `typeRef` names
 * the type for error reporting, e.g. `'duration'` for §5.4's unconstrained
 * `duration => !duration_type {}`. `constraints` is accepted for structural symmetry with every
 * other `create*Parser` in `atom/temporal/` and to carry `min`/`max` through unevaluated -- see
 * this module's own TSDoc on why they aren't validated.
 */
export function createDurationParser(
  typeRef: string,
  constraints: DurationType,
): AtomType<TsonDuration> {
  // `constraints.min`/`.max` are intentionally never read -- see this module's own TSDoc.
  void constraints;

  function read(token: AtomToken): TsonDuration {
    const text = token.text;
    const value = tryParseIsoDuration(text);
    if (value === undefined) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid ISO 8601 duration -- expected PnYnMnDTnHnMnS, uppercase ` +
          'designators, no leading sign, at least one designator present (§5.4)',
        'an ISO 8601 duration',
      );
    }
    return value;
  }

  /** {@link formatIsoDuration} already gives the single combined `PnYnMnDTnHnMnS` form. */
  function write(value: TsonDuration): string {
    return formatIsoDuration(value);
  }

  return { read, write };
}
