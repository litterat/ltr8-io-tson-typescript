/**
 * An ordered family's bounds on read: two field groups, `( min | exclusive_min )?` and
 * `( max | exclusive_max )?`, and a value outside either is a validation error (§5.5, §5.7). The four
 * tests are written once, over the order the family supplies, so a family cannot carry an exclusive
 * bound in its body and leave it untested.
 */
import { TsonAtomValidationError } from '../../core/errors.js';

/** The limits one atom body states; each end holds at most one of its pair. */
export interface BoundSet<T> {
  readonly min?: T | undefined;
  readonly exclusiveMin?: T | undefined;
  readonly max?: T | undefined;
  readonly exclusiveMax?: T | undefined;
}

type BoundKind = 'min' | 'exclusiveMin' | 'max' | 'exclusiveMax';

const RELATION: Readonly<Record<BoundKind, string>> = {
  min: '>= ',
  exclusiveMin: '> ',
  max: '<= ',
  exclusiveMax: '< ',
};

/** The chronological families' wording; the exclusive ends read as every numeric family reads them. */
const CHRONOLOGICAL: Readonly<Record<BoundKind, string>> = {
  min: 'is before the minimum ',
  exclusiveMin: 'must be strictly greater than ',
  max: 'is after the maximum ',
  exclusiveMax: 'must be strictly less than ',
};

/**
 * Throws the first violated bound, tested in the order `min`, `exclusive_min`, `max`,
 * `exclusive_max`. `order` is the family's value order, negative, zero or positive as the first
 * argument is below, equal to or above the second; `render` writes a limit as the family's own text.
 */
export function checkChronologicalBounds<T>(
  typeRef: string,
  value: T,
  text: string,
  bounds: BoundSet<T>,
  order: (a: T, b: T) => number,
  render: (limit: T) => string,
): void {
  const violated = (kind: BoundKind, limit: T): never => {
    const rendered = render(limit);
    throw new TsonAtomValidationError(
      typeRef,
      `'${text}' ${CHRONOLOGICAL[kind]}${rendered}`,
      `${RELATION[kind]}${rendered}`,
    );
  };
  const { min, exclusiveMin, max, exclusiveMax } = bounds;
  if (min !== undefined && order(value, min) < 0) violated('min', min);
  if (exclusiveMin !== undefined && order(value, exclusiveMin) <= 0) {
    violated('exclusiveMin', exclusiveMin);
  }
  if (max !== undefined && order(value, max) > 0) violated('max', max);
  if (exclusiveMax !== undefined && order(value, exclusiveMax) >= 0) {
    violated('exclusiveMax', exclusiveMax);
  }
}
