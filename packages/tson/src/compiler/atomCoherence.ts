/**
 * Shared facet-comparison helpers behind `atomChecks.ts`'s own coherence rule for each atom
 * family — the `atomNarrowing.ts` twin, for the other question: `atomNarrowing.ts` compares two
 * bodies (is this refinement a tightening of that source, §5.7?); this compares one body's facets
 * against each other (does what the author wrote admit any value at all?), a resolver-time
 * question Part 2 §7.2 states outright: "family coherence between bindings (e.g. `min <= max`) is
 * a compilation and ingest concern (§8), not data validation." A direct port of the reference
 * implementation's `AtomCoherence` (`tson-schema/.../meta/AtomCoherence.java`).
 *
 * Every `check*` function appends a human-readable violation fragment to `out` and appends
 * nothing when the facets are coherent, matching `atomNarrowing.ts`'s own convention so a
 * family's two rules read the same way and both report every problem rather than the first.
 *
 * A facet absent from the body is unbounded and contradicts nothing — an incoherence needs two
 * present facets (or one present facet and a range the family itself fixes).
 *
 * **Emptiness is judged, not narrowness.** A range admitting exactly one value (`min: 5 max: 5`)
 * is a legitimate way to pin a constant and passes; the same range made exclusive at either end
 * admits nothing and does not — the strictness of each end is load-bearing here, which is why
 * {@link checkRange} takes {@link Bound}s rather than raw values.
 */
import { renderBoundValue } from './atomNarrowing.js';
import type { Bound } from './atomNarrowing.js';

/**
 * A lower and upper bound must leave something between them. Empty in two ways: the floor above
 * the ceiling outright, or the two meeting at a single value that an exclusive end then removes —
 * `exclusive_min: 5 max: 5` admits nothing while `min: 5 max: 5` admits exactly 5.
 */
export function checkRange<T>(
  out: string[],
  lower: Bound<T> | undefined,
  upper: Bound<T> | undefined,
  compare: (a: T, b: T) => number,
): void {
  if (lower === undefined || upper === undefined) {
    return;
  }
  const order = compare(lower.value, upper.value);
  if (order > 0) {
    out.push(
      `${lower.facet} ${renderBoundValue(lower.value)} is above ${upper.facet} ${renderBoundValue(upper.value)}`,
    );
  } else if (order === 0 && !(lower.inclusive && upper.inclusive)) {
    out.push(
      `${lower.facet} and ${upper.facet} meet at ${String(lower.value)}, which one of them excludes`,
    );
  }
}

/**
 * A floor facet must not sit above its ceiling twin, for the families whose bounds are plain
 * inclusive values with no exclusive spelling — `min_length`/`max_length`, `min_prefix`/
 * `max_prefix`, `fraction_digits` against `total_digits`.
 */
export function checkOrdered<T>(
  out: string[],
  lowerFacet: string,
  lower: T | undefined,
  upperFacet: string,
  upper: T | undefined,
  compare: (a: T, b: T) => number,
): void {
  if (lower !== undefined && upper !== undefined && compare(lower, upper) > 0) {
    out.push(
      `${lowerFacet} ${renderBoundValue(lower)} is above ${upperFacet} ${renderBoundValue(upper)}`,
    );
  }
}

/**
 * A facet must fall inside the range the family itself fixes — a CIDR prefix length within its
 * address family's width. Unlike every other check here this needs no second facet: the range is
 * the family's, not something the author wrote, so a single out-of-range value already
 * contradicts the type it claims to constrain.
 */
export function checkWithin(
  out: string[],
  facet: string,
  value: number | undefined,
  low: number,
  high: number,
): void {
  if (value !== undefined && (value < low || value > high)) {
    out.push(
      `${facet} ${String(value)} is outside the family range ${String(low)}-${String(high)}`,
    );
  }
}

/**
 * A count-style facet may not be negative — a length or a digit count below zero describes no
 * value. Kept separate from {@link checkWithin} because the ceiling is the family's business and
 * the floor is not: every count shares zero, and no family has a meaningful maximum.
 */
export function checkNonNegative(out: string[], facet: string, value: number | undefined): void {
  if (value !== undefined && value < 0) {
    out.push(`${facet} ${String(value)} is negative`);
  }
}

/**
 * A step facet must be a usable divisor. Zero is the case that matters and is not merely vacuous:
 * an unchecked `multiple_of: 0` would turn every read of an otherwise valid document into a
 * library-fault report against the *data* once the numeric atom parsers divide by it — catching
 * it at the declaration puts the verdict on the schema that is actually wrong.
 *
 * A negative step is rejected alongside it: nothing divides differently by `-2` than by `2`, so
 * it is not unsound, but the sign is meaningless in a facet whose whole content is a grid
 * spacing.
 */
export function checkPositiveStep<T>(
  out: string[],
  facet: string,
  value: T | undefined,
  signum: (v: T) => number,
): void {
  if (value === undefined) {
    return;
  }
  const sign = signum(value);
  if (sign === 0) {
    out.push(`${facet} is zero, which divides nothing`);
  } else if (sign < 0) {
    out.push(`${facet} ${String(value)} is negative; a step is a spacing, not a direction`);
  }
}
