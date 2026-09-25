/**
 * Shared facet-comparison helpers behind `atomChecks.ts`'s own narrowing rule for each atom
 * family — the mechanics every family's own tightening check reuses (bounds, counts, permission
 * flags, member sets), so `atomChecks.ts` only has to say *which* of a family's fields are which
 * kind of facet, not how a facet is compared. A direct, idiomatic-TypeScript port of the
 * reference implementation's `AtomNarrowing` (`tson-schema/.../meta/AtomNarrowing.java`) — a
 * generic Java utility class here becomes a set of plain, independently-typed functions.
 *
 * **A selector facet's own narrowing relation is not one shape (§5.7).** Each of the four —
 * `integer_type.size`, `complex_type.component`, `float_type.format`, `bytes_type.encoding` —
 * states its own relation, and none of the four is a single shared shape, so none is a generic
 * helper here: `size` folds into the family's own ordered-bound comparison (a width chain is
 * exactly "does the derived range narrow", so {@link checkLower}/{@link checkUpper} already
 * state it, applied to {@link tighterLower}/{@link tighterUpper}'s own inputs, in
 * `atomChecks.ts`'s own `integerNarrows`); `component` and `format` each rank *two* incomparable
 * chains (exact/approximate for `component`; binary/decimal radix for `format`), a shape specific
 * enough to each family that `atomChecks.ts`'s own `complexNarrows`/`floatNarrows` build it by
 * hand; `encoding` alone carries no relation at all — every alphabet is a fresh instance, so the
 * only legal move is no move, checked by equality rather than by comparison, again in
 * `atomChecks.ts`.
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
import { writeDecimal } from '../atom/numeric/decimalMath.js';
import type { Decimal } from '../schema/meta/algebra.js';

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
  return `${bound.facet} ${renderBoundValue(bound.value)}`;
}

/**
 * A bound's value as an author would recognise it.
 *
 * A facet value is whatever its own family models — a `bigint` for an integer bound, a
 * {@link TsonDecimal} for a decimal one, a `Rational` for a rational one, a record for a temporal
 * one. Only the primitives have a useful `toString`, and the rest render as `[object Object]`,
 * which turns a real diagnostic about the author's own schema into noise. Each shape is spelled
 * out here rather than asking every atom family for a renderer, because a diagnostic's rendering
 * is this module's concern and nothing else consumes it.
 */
export function renderBoundValue(value: unknown): string {
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') return value;
  if (isRationalShape(value)) {
    return `${value.numerator.toString()}/${value.denominator.toString()}`;
  }
  if (isDecimalShape(value)) {
    return writeDecimal({ unscaled: value.unscaledValue, exponent: -value.scale });
  }
  // A temporal or network bound: its own fields, in declaration order, which is the closest thing
  // to the token the author wrote that this layer can reach.
  return JSON.stringify(value);
}

function isDecimalShape(value: unknown): value is Decimal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'unscaledValue' in value &&
    'scale' in value &&
    typeof (value as Decimal).unscaledValue === 'bigint'
  );
}

function isRationalShape(value: unknown): value is { numerator: bigint; denominator: bigint } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'numerator' in value &&
    'denominator' in value &&
    typeof (value as { numerator: unknown }).numerator === 'bigint'
  );
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
    out.push(
      `${facet} ${renderBoundValue(refined)} is below the source's own ${renderBoundValue(source)}`,
    );
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
    out.push(
      `${facet} ${renderBoundValue(refined)} is above the source's own ${renderBoundValue(source)}`,
    );
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

/**
 * A **settable-once** facet (§5.7): a refinement may set it where the source left it unset,
 * restate the source's own value verbatim, or leave it alone — never change it. `text_type.pattern`
 * and `text_type.members` (and its composers `regex_type`/`uri_type`/`email_type`) are the pair
 * this exists for: both occupy the position "what does this text admit", `pattern` cannot be
 * narrowed without a regular-language containment oracle the series decides nowhere, and giving
 * the pair two rules by spelling would make the narrowing relation an artifact of which one an
 * author reached for. `equals` defaults to `===`, which is exactly right for `pattern` (a string)
 * and wrong for `members` (an array, where a caller supplies element-wise equality — see
 * `atomChecks.ts`'s own call).
 */
export function checkSettableOnce<T>(
  out: string[],
  facet: string,
  source: T | undefined,
  refined: T | undefined,
  equals: (a: T, b: T) => boolean = (a, b) => a === b,
  because = 'whether one narrows the other is not decided here',
): void {
  if (source !== undefined && refined !== undefined && !equals(source, refined)) {
    out.push(
      `${facet} ${renderBoundValue(refined)} replaces the source's own ${renderBoundValue(source)} -- ` +
        `${because}, so a set ${facet} may be restated but not changed`,
    );
  }
}

/**
 * A member/value set may only shrink — an enum's own `members`, a network family's `within`.
 * `source` empty is unconstrained and admits any `refined` (the same "absent-equals-empty"
 * convention `checkMemberSubset` states for its own typed twin). `refined` empty while `source`
 * is not is the same widening the other direction — the constraint disappeared, not shrank to
 * nothing — and is reported the same way a genuinely added member would be.
 */
export function checkSubset(
  out: string[],
  facet: string,
  source: readonly string[],
  refined: readonly string[],
): void {
  if (source.length === 0) {
    return;
  }
  if (refined.length === 0) {
    out.push(
      `${facet} is empty, which does not shrink the source's own [${source.join(', ')}] -- an ` +
        'empty list is unconstrained, so dropping every entry widens rather than narrows',
    );
    return;
  }
  const added = refined.filter((member) => !source.includes(member));
  if (added.length > 0) {
    out.push(`${facet} adds [${added.join(', ')}], which the source does not admit`);
  }
}

/**
 * {@link checkSubset}'s mirror image, for a list facet that narrows by *growing* — a network
 * family's `within`/`excluding` pair (§5.5, §5.7) list networks two opposite ways: `within`
 * admits addresses, so a refinement narrows by shrinking it (removing a permitted network
 * removes values); `excluding` removes addresses, so a refinement narrows by growing it (adding
 * an exclusion removes values). Compared by entry, not by containment — a refinement excluding a
 * network strictly smaller than one the source already excludes is refused here even though it
 * narrows in fact. §5.7 states a member set is "compared by the family's own value identity" but
 * does not itself say whether a *network* list narrows by entry or by containment; this port
 * takes the conservative reading (refuses a legal-in-principle refinement rather than risk
 * admitting an illegal one), matching every other member set's own by-entry comparison. The
 * containment arithmetic to decide it properly already exists (`atom/network/cidrParsing.ts`);
 * what would change is only this function's own comparison, not that arithmetic.
 */
export function checkSuperset(
  out: string[],
  facet: string,
  source: readonly string[],
  refined: readonly string[],
): void {
  const dropped = source.filter((member) => !refined.includes(member));
  if (dropped.length > 0) {
    out.push(
      `${facet} drops [${dropped.join(', ')}] from the source's own list -- each entry removes ` +
        `values, so ${facet} may grow but never shrink`,
    );
  }
}

/**
 * {@link checkSubset}'s twin for a member set compared by the family's own value identity
 * (§5.5, §7.4) rather than string/reference equality — `integer_type.members`,
 * `decimal_type.members`, where `1` and `1.0` are one member. `source` absent or empty is
 * unconstrained, exactly as {@link checkSubset} treats an empty one; `refined` absent while
 * `source` is not is itself a widening (the constraint disappeared) and is reported the same way
 * a genuinely added member would be.
 */
export function checkMemberSubset<T>(
  out: string[],
  facet: string,
  source: readonly T[] | undefined,
  refined: readonly T[] | undefined,
  equals: (a: T, b: T) => boolean,
): void {
  if (source === undefined || source.length === 0) {
    return;
  }
  if (refined === undefined) {
    out.push(
      `${facet} is absent, which does not shrink the source's own [${source.map(renderBoundValue).join(', ')}]`,
    );
    return;
  }
  const added = refined.filter((r) => !source.some((s) => equals(s, r)));
  if (added.length > 0) {
    out.push(
      `${facet} adds [${added.map(renderBoundValue).join(', ')}], which the source does not admit`,
    );
  }
}

/** Whether `value` satisfies a lower {@link Bound} — the per-member coherence check ("does every member of `members` satisfy the body's other facets", §7.4) reduces to this rather than a source/refined comparison. `undefined` is unbounded and admits everything. */
export function admitsLower<T>(
  bound: Bound<T> | undefined,
  value: T,
  compare: (a: T, b: T) => number,
): boolean {
  if (bound === undefined) return true;
  const order = compare(value, bound.value);
  return bound.inclusive ? order >= 0 : order > 0;
}

/** The {@link admitsLower} twin, for an upper bound. */
export function admitsUpper<T>(
  bound: Bound<T> | undefined,
  value: T,
  compare: (a: T, b: T) => number,
): boolean {
  if (bound === undefined) return true;
  const order = compare(value, bound.value);
  return bound.inclusive ? order <= 0 : order < 0;
}

/** Ordinary numeric/lexicographic comparison, for the many facets whose host type is already comparable with `<`/`>`. */
export function naturalCompare<T extends number | bigint | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
