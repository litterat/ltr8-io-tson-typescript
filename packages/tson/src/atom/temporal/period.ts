/**
 * Parses and validates against meta's `period_type` constructor (§5.4's `!period` atom) -- the
 * port of `atom/PeriodParser.java`.
 *
 * Grammar recognition lives in `isoPeriod.ts` (`tryParseIsoPeriod`/`formatIsoPeriod`); this
 * module is the `AtomType` wiring plus the bound/step check against the parsed value.
 *
 * **`min`/`exclusive_min`/`max`/`exclusive_max`/`multiple_of` are enforced against the *value* —
 * the signed month count, never the written form** ([TSON-SCHEMA] §5.5, §5.7): `period_type`'s
 * bounds and step are read under `period`'s own atom at schema load
 * (`schema/metaReader.ts`/`schema/bindings.ts`'s own `periodBoundBinding`), so `PeriodType`'s
 * fields (`schema/meta/atoms-temporal.ts`) already hold the resolved `bigint` this module
 * compares against directly. `multiple_of` tests the magnitude with the sign ignored (§5.7). No
 * `precision` facet: a month count has no fractional part to bound.
 */

import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import type { PeriodType } from '../../schema/meta/atoms-temporal.js';
import type { TsonPeriod } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';
import { formatIsoPeriod, tryParseIsoPeriod } from './isoPeriod.js';

/**
 * Builds the `AtomType` for one fully-parameterised `period_type` instance -- `period` (§5.4).
 * `constraints` defaults to the unconstrained body so an unconstrained caller need not spell
 * `{ kind: 'period_type' }` out, the one asymmetry from {@link createDurationParser}'s own
 * required parameter.
 */
export function createPeriodParser(
  typeRef: string,
  constraints: PeriodType = { kind: 'period_type' },
): AtomType<TsonPeriod> {
  function validate(months: bigint, text: string): void {
    const { min, exclusiveMin, max, exclusiveMax, multipleOf } = constraints;
    if (min !== undefined && months < min) {
      const bound = formatIsoPeriod(min);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is less than the minimum ${bound}`,
        `>= ${bound}`,
      );
    }
    if (exclusiveMin !== undefined && months <= exclusiveMin) {
      const bound = formatIsoPeriod(exclusiveMin);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' must be strictly greater than ${bound}`,
        `> ${bound}`,
      );
    }
    if (max !== undefined && months > max) {
      const bound = formatIsoPeriod(max);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is greater than the maximum ${bound}`,
        `<= ${bound}`,
      );
    }
    if (exclusiveMax !== undefined && months >= exclusiveMax) {
      const bound = formatIsoPeriod(exclusiveMax);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' must be strictly less than ${bound}`,
        `< ${bound}`,
      );
    }
    if (multipleOf !== undefined) {
      const magnitude = months < 0n ? -months : months;
      const step = multipleOf < 0n ? -multipleOf : multipleOf;
      if (magnitude % step !== 0n) {
        const of = formatIsoPeriod(multipleOf);
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' is not a multiple of ${of}`,
          `a multiple of ${of}`,
        );
      }
    }
  }

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
    validate(months, text);
    return { months };
  }

  function write(value: TsonPeriod): string {
    return formatIsoPeriod(value.months);
  }

  return { read, write };
}
