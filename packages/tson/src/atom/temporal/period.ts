/**
 * Parses and validates against meta's `period_type` constructor (§5.4's `!period` atom) -- the
 * port of `atom/PeriodParser.java`.
 *
 * Grammar recognition lives in `isoPeriod.ts` (`tryParseIsoPeriod`/`formatIsoPeriod`); this
 * module is only the `AtomType` wiring.
 *
 * **No `constraints` parameter, unlike every other `create*Parser` factory in `atom/temporal/`.**
 * `period_type` (`schema/meta/atoms-temporal.ts`'s `PeriodType`) carries `min`/`max`/
 * `multiple_of` as the kernel's `value` escape hatch resolved to a month count (`bigint`,
 * §7.4) -- but wiring a bound check against them is a resolver concern this module does not yet
 * reach into, mirroring `duration.ts`'s own precedent and `complex.ts`'s for a family with
 * nothing yet to bound: no parameter to thread through unread, only a value to parse. The
 * built-in, always-unconstrained `period => !period_type {}` instance
 * (`reader/schemaless/vocabulary.ts`) needs nothing else.
 */

import { TsonAtomParseError } from '../../core/errors.js';
import type { TsonPeriod } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';
import { formatIsoPeriod, tryParseIsoPeriod } from './isoPeriod.js';

/** Builds the `AtomType` for the unconstrained `period_type` instance -- `period` (§5.4). */
export function createPeriodParser(typeRef: string): AtomType<TsonPeriod> {
  function read(token: AtomToken): TsonPeriod {
    const text = token.text;
    const months = tryParseIsoPeriod(text);
    if (months === undefined) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid period -- expected P with a Y component, an M component, or ` +
          'both in that order, and no D, W, T part or fraction (§5.4)',
        'a period',
      );
    }
    return { months };
  }

  function write(value: TsonPeriod): string {
    return formatIsoPeriod(value.months);
  }

  return { read, write };
}
