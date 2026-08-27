import { isInCategory } from './categories.js';

/**
 * An immutable set of Unicode code points as sorted, disjoint, merged inclusive intervals over
 * `[0, 0x10FFFF]` — flattened as `[lo0, hi0, lo1, hi1, ...]` — plus the boolean-algebra
 * operations {@link unionCodePointSets}/{@link intersectCodePointSets}/{@link
 * complementCodePointSet} that `disjoint.ts`'s product-NFA emptiness check needs.
 *
 * Unlike the matcher's opaque `(codePoint: number) => boolean` predicates (`nfa.ts`), these can
 * be intersected and tested for emptiness — required to explore a product automaton over a
 * Unicode-sized alphabet without enumerating it. A `\p{...}` category is materialised once (a
 * scan of `categories.ts`'s tables) and cached.
 *
 * A plain `readonly number[]` rather than a wrapper object: every operation is a pure function
 * over the flattened interval array, so there is nothing a class would hold that the array
 * itself does not already carry.
 */
export type CodePointSet = readonly number[];

/** The highest Unicode scalar value — the whole set's universe is `[0, MAX_CODE_POINT]`. */
export const MAX_CODE_POINT = 0x10ffff;

/** The set containing no code points. */
export const EMPTY_CODE_POINT_SET: CodePointSet = [];

/** The set of every code point in `[lo, hi]` inclusive; empty when `lo > hi`. */
export function codePointRange(lo: number, hi: number): CodePointSet {
  return lo > hi ? EMPTY_CODE_POINT_SET : [lo, hi];
}

/** The set containing exactly `codePoint`. */
export function singleCodePoint(codePoint: number): CodePointSet {
  return codePointRange(codePoint, codePoint);
}

export function isEmptyCodePointSet(set: CodePointSet): boolean {
  return set.length === 0;
}

/**
 * A set this module builds is always an even-length, in-range array of interval bounds by
 * construction; this reads one bound with that invariant made explicit rather than asserted
 * away, so a genuinely malformed set fails loudly instead of comparing against `undefined`.
 */
function boundAt(set: CodePointSet, index: number): number {
  const value = set[index];
  if (value === undefined) {
    throw new RangeError(`code-point set is malformed at index ${String(index)}`);
  }
  return value;
}

/** Binary search over the flattened interval pairs. */
export function codePointSetContains(set: CodePointSet, codePoint: number): boolean {
  let lo = 0;
  let hi = set.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = set[2 * mid];
    const end = set[2 * mid + 1];
    // Both indices are in bounds for any set this module produces; the guard is what lets the
    // reads stay unasserted, and a missing bound can only mean "not in the set".
    if (start === undefined || end === undefined) return false;
    if (codePoint < start) {
      hi = mid - 1;
    } else if (codePoint > end) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

export function complementCodePointSet(set: CodePointSet): CodePointSet {
  const out: Interval[] = [];
  let next = 0;
  for (let k = 0; k < set.length; k += 2) {
    const start = boundAt(set, k);
    if (start > next) out.push({ lo: next, hi: start - 1 });
    next = boundAt(set, k + 1) + 1;
  }
  if (next <= MAX_CODE_POINT) out.push({ lo: next, hi: MAX_CODE_POINT });
  return fromIntervals(out);
}

export function unionCodePointSets(a: CodePointSet, b: CodePointSet): CodePointSet {
  if (isEmptyCodePointSet(a)) return b;
  if (isEmptyCodePointSet(b)) return a;
  const raw: Interval[] = [];
  addPairs(raw, a);
  addPairs(raw, b);
  return fromIntervals(raw);
}

export function intersectCodePointSets(a: CodePointSet, b: CodePointSet): CodePointSet {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const aHi = boundAt(a, i + 1);
    const bHi = boundAt(b, j + 1);
    const lo = Math.max(boundAt(a, i), boundAt(b, j));
    const hi = Math.min(aHi, bHi);
    if (lo <= hi) out.push({ lo, hi });
    if (aHi < bHi) {
      i += 2;
    } else {
      j += 2;
    }
  }
  return fromIntervals(out);
}

// ── Category materialisation (cached) ─────────────────────────────────────

const categoryCache = new Map<string, CodePointSet>();

/**
 * The set of every code point in Unicode general category `name` — a full `[0, 0x10FFFF]` scan
 * against `categories.ts`'s tables the first time a given category is asked for, cached
 * thereafter. Only `disjoint.ts` calls this: the matcher tests category membership directly
 * (`isInCategory`) and never materialises the set of an entire category.
 */
export function codePointSetOfCategory(name: string): CodePointSet {
  const cached = categoryCache.get(name);
  if (cached !== undefined) return cached;
  const built = buildCategorySet(name);
  categoryCache.set(name, built);
  return built;
}

function buildCategorySet(name: string): CodePointSet {
  const out: Interval[] = [];
  let runStart = -1;
  for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
    if (isInCategory(name, cp)) {
      if (runStart < 0) runStart = cp;
    } else if (runStart >= 0) {
      out.push({ lo: runStart, hi: cp - 1 });
      runStart = -1;
    }
  }
  if (runStart >= 0) out.push({ lo: runStart, hi: MAX_CODE_POINT });
  return fromIntervals(out);
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** A single (not yet merged, not yet sorted) inclusive interval, used only while building a set. */
interface Interval {
  lo: number;
  hi: number;
}

function addPairs(raw: Interval[], flat: CodePointSet): void {
  for (let k = 0; k < flat.length; k += 2)
    raw.push({ lo: boundAt(flat, k), hi: boundAt(flat, k + 1) });
}

/** Sorts by low bound and coalesces overlapping or adjacent intervals into a normalised set. */
function fromIntervals(raw: readonly Interval[]): CodePointSet {
  if (raw.length === 0) return EMPTY_CODE_POINT_SET;
  const sorted = [...raw].sort((p, q) => p.lo - q.lo);
  const merged: Interval[] = [];
  let current: Interval | undefined;
  for (const next of sorted) {
    if (current === undefined) {
      current = { ...next };
    } else if (next.lo <= current.hi + 1) {
      current.hi = Math.max(current.hi, next.hi);
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  if (current !== undefined) merged.push(current);
  const flat: number[] = [];
  for (const interval of merged) flat.push(interval.lo, interval.hi);
  return flat;
}
