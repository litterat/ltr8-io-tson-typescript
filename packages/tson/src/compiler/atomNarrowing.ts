/**
 * Shared facet-comparison helpers behind `atomChecks.ts`'s own narrowing rule for each atom
 * family — the mechanics every family's own tightening check reuses (bounds, counts, permission
 * flags, member sets), so `atomChecks.ts` only has to say *which* of a family's fields are which
 * kind of facet, not how a facet is compared. A direct, idiomatic-TypeScript port of the
 * reference implementation's `AtomNarrowing` (`tson-schema/.../meta/AtomNarrowing.java`) — a
 * generic Java utility class here becomes a set of plain, independently-typed functions.
 *
 * There is deliberately no helper for a *selector* facet (`complex_type.component`,
 * `float_type.format`, `uuid_type.version`): a selector picks among unordered alternatives, so no
 * comparison decides whether swapping one narrows.
 *
 * Every `check*` function appends a human-readable violation fragment to `out` and appends
 * nothing when the refinement is a valid tightening, so a family's rule reads as a straight list
 * of facet checks and reports all of its problems at once rather than only the first.
 *
 * The comparison direction is always "is the refined facet at least as restrictive as the
 * source's own?" (§5.7's refinement rule — a refinement tightens and never loosens). A facet
 * absent from the source is unbounded and admits any refined value. A facet absent from the
 * *refinement* is likewise not a violation, because a refinement has no way to express one:
 * `definitionResolver.ts`'s own `mergeWithSource` gives an unmentioned facet the source's own
 * value, so an absent refined facet means the source never carried it either — the exception is a
 * bound a family *derives* rather than stores (an integer's own `size` implies a range with no
 * `min`/`max` facet behind it), where absent is the normal, correct state.
 */

/**
 * One end of a range as a comparable value plus whether it is inclusive, paired with the wire
 * facet name it came from so a violation can name the field the author actually wrote. An
 * inclusive/exclusive pair (`min`/`exclusive_min`) collapses to this one shape, so a bound
 * comparison never has to branch on which of the two a family happened to use.
 */
export interface Bound<T> {
  readonly value: T;
  readonly inclusive: boolean;
  readonly facet: string;
}

function describe<T>(bound: Bound<T>): string {
  return `${bound.facet} ${String(bound.value)}`;
}

/**
 * The single bound an inclusive/exclusive facet pair denotes, or `undefined` when the range is
 * open at that end. Both ends collapse the same way, so one function serves `min`/`exclusive_min`
 * and `max`/`exclusive_max` alike — the call site's own variable name says which end it built.
 */
export function bound<T>(
  inclusiveValue: T | undefined,
  exclusiveValue: T | undefined,
  inclusiveFacet: string,
  exclusiveFacet: string,
): Bound<T> | undefined {
  if (inclusiveValue !== undefined) {
    return { value: inclusiveValue, inclusive: true, facet: inclusiveFacet };
  }
  if (exclusiveValue !== undefined) {
    return { value: exclusiveValue, inclusive: false, facet: exclusiveFacet };
  }
  return undefined;
}

/**
 * Whether `refined` is a lower bound at least as restrictive as `source` — a higher floor, or the
 * same floor made exclusive. Equal bounds of equal strictness tighten vacuously, which is what
 * lets a refinement restate a facet it doesn't actually change.
 */
export function lowerTightens<T>(
  source: Bound<T>,
  refined: Bound<T>,
  compare: (a: T, b: T) => number,
): boolean {
  const order = compare(refined.value, source.value);
  return order !== 0 ? order > 0 : !refined.inclusive || source.inclusive;
}

/** The {@link lowerTightens} twin: a lower ceiling, or the same ceiling made exclusive. */
export function upperTightens<T>(
  source: Bound<T>,
  refined: Bound<T>,
  compare: (a: T, b: T) => number,
): boolean {
  const order = compare(refined.value, source.value);
  return order !== 0 ? order < 0 : !refined.inclusive || source.inclusive;
}

/**
 * The tighter of two lower bounds — how a family folds an implied range (an integer's own
 * `size`) into its explicit one before comparing. An absent end is unbounded, so the other wins.
 */
export function tighterLower<T>(
  left: Bound<T> | undefined,
  right: Bound<T> | undefined,
  compare: (a: T, b: T) => number,
): Bound<T> | undefined {
  if (left === undefined || right === undefined) {
    return left ?? right;
  }
  return lowerTightens(left, right, compare) ? right : left;
}

/** The {@link tighterLower} twin, for the upper end. */
export function tighterUpper<T>(
  left: Bound<T> | undefined,
  right: Bound<T> | undefined,
  compare: (a: T, b: T) => number,
): Bound<T> | undefined {
  if (left === undefined || right === undefined) {
    return left ?? right;
  }
  return upperTightens(left, right, compare) ? right : left;
}

/** A refined lower bound must not sit below the source's own — `min: -10` under a source whose floor is 0. */
export function checkLower<T>(
  out: string[],
  source: Bound<T> | undefined,
  refined: Bound<T> | undefined,
  compare: (a: T, b: T) => number,
): void {
  if (source !== undefined && refined !== undefined && !lowerTightens(source, refined, compare)) {
    out.push(`${describe(refined)} is below the source's own ${describe(source)}`);
  }
}

/** A refined upper bound must not sit above the source's own — `max: 300` under a source whose ceiling is 255. */
export function checkUpper<T>(
  out: string[],
  source: Bound<T> | undefined,
  refined: Bound<T> | undefined,
  compare: (a: T, b: T) => number,
): void {
  if (source !== undefined && refined !== undefined && !upperTightens(source, refined, compare)) {
    out.push(`${describe(refined)} is above the source's own ${describe(source)}`);
  }
}

/** A floor-style facet (`min_length`, `min_prefix`) may only rise. */
export function checkAtLeast<T>(
  out: string[],
  facet: string,
  source: T | undefined,
  refined: T | undefined,
  compare: (a: T, b: T) => number,
): void {
  if (source !== undefined && refined !== undefined && compare(refined, source) < 0) {
    out.push(`${facet} ${String(refined)} is below the source's own ${String(source)}`);
  }
}

/** A ceiling-style facet (`max_length`, `max_prefix`, `total_digits`) may only fall. */
export function checkAtMost<T>(
  out: string[],
  facet: string,
  source: T | undefined,
  refined: T | undefined,
  compare: (a: T, b: T) => number,
): void {
  if (source !== undefined && refined !== undefined && compare(refined, source) > 0) {
    out.push(`${facet} ${String(refined)} is above the source's own ${String(source)}`);
  }
}

/** A permission flag (`allow_nan` and friends) may be withdrawn but never granted back. */
export function checkOnlyWithdraws(
  out: string[],
  facet: string,
  source: boolean,
  refined: boolean,
): void {
  if (refined && !source) {
    out.push(`${facet} re-enables what the source forbids`);
  }
}

/** A member/value set may only shrink — an enum's own `members`, a CIDR family's `within`. */
export function checkSubset(
  out: string[],
  facet: string,
  source: readonly string[],
  refined: readonly string[],
): void {
  if (source.length === 0) {
    return;
  }
  const added = refined.filter((member) => !source.includes(member));
  if (added.length > 0) {
    out.push(`${facet} adds [${added.join(', ')}], which the source does not admit`);
  }
}

/** Ordinary numeric/lexicographic comparison, for the many facets whose host type is already comparable with `<`/`>`. */
export function naturalCompare<T extends number | bigint | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
