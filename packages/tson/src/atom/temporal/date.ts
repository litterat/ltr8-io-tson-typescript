/**
 * Parses and validates against meta-kernel's `date_type` constructor (§5.4's `!date` atom, RFC
 * 3339 `full-date`) -- the port of `atom/DateParser.java`.
 *
 * **No host `Date`, and no JDK to lean on.** The Java original validates the token's shape with
 * a regex before delegating to `LocalDate.parse` for the calendar-validity check (leap years,
 * day-of-month ranges); this port has no such delegate; `rfc3339.ts`'s `readFullDate` does both
 * in one hand-written pass -- shape and calendar validity together, since JS has nothing to
 * split the work with. A non-leap 29th of February therefore fails inside `readFullDate` itself
 * and reads back the same way the Java's `DateTimeParseException` does: a {@link
 * TsonAtomParseError}, not a {@link TsonAtomValidationError} -- the token never denotes a real
 * calendar date at all, so this isn't a value falling outside a declared bound.
 *
 * See `CONFORMANCE.md` and `rfc3339.ts`'s own TSDoc for why `!date` rejects ISO 8601's
 * "extended year" form (leading sign, more than four digits) that `LocalDate.parse` alone would
 * accept.
 */

import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import type { DateType } from '../../schema/meta/atoms-temporal.js';
import type { PlainDate } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';
import { compareDate, formatFullDate, readFullDate } from './rfc3339.js';

/**
 * Builds the `AtomType` for one fully-parameterised `date_type` instance. `typeRef` names the
 * type for error reporting, e.g. `'date'` for §5.4's unconstrained `date => !date_type {}`.
 */
export function createDateParser(typeRef: string, constraints: DateType): AtomType<PlainDate> {
  function read(token: AtomToken): PlainDate {
    const text = token.text;
    const parsed = readFullDate(text, 0);
    if (parsed?.next !== text.length) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid date -- expected RFC 3339 full-date, YYYY-MM-DD (§5.4)`,
        'an RFC 3339 full-date',
      );
    }
    const value = parsed.value;
    if (constraints.min !== undefined && compareDate(value, constraints.min) < 0) {
      const bound = formatFullDate(constraints.min);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is before the minimum ${bound}`,
        `>= ${bound}`,
      );
    }
    if (constraints.max !== undefined && compareDate(value, constraints.max) > 0) {
      const bound = formatFullDate(constraints.max);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is after the maximum ${bound}`,
        `<= ${bound}`,
      );
    }
    return value;
  }

  /** {@link formatFullDate} already gives RFC 3339's exact `full-date` form. */
  function write(value: PlainDate): string {
    return formatFullDate(value);
  }

  return { read, write };
}
