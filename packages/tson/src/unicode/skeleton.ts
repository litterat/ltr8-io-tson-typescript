import { confusableReplacement } from './confusables.js';

/**
 * UTS #39 §4's `skeleton()`, and [TSON-DATA] §8.2 mechanism 1 (skeleton distinctness) built on
 * top of it: two names are confusable exactly when their skeletons are equal, and mechanism 1
 * refuses two such names sharing one named scope (§8.2's own list — a record's field names, plus
 * the schema-layer scopes [TSON-SCHEMA] §11.4 adds).
 *
 * **It is a relation, not a property of one name**, and that is why §8.2 keeps it apart from
 * {@link "./restriction-level.js"}'s per-name restriction levels: a skeleton says nothing about a
 * lone name, so it cannot reject `id_пользователя` or any other mixed-script name an author
 * legitimately wrote on its own. It fires only when two names *in the same scope* collide — which
 * is also why {@link firstConfusableCollision} takes the whole scope, not one name at a time.
 */

/**
 * `skeleton(text)` per UTS #39 §4: NFD, replace each code point via the confusables map, NFD
 * again. Two strings are confusable exactly when this returns equal values for them; the
 * skeleton itself carries no meaning of its own and is never shown to an author.
 */
export function skeleton(text: string): string {
  const decomposed = text.normalize('NFD');
  let mapped = '';
  for (const character of decomposed) {
    // `character` iterates `decomposed` code point by code point (a `for...of` over a string
    // yields whole code points, surrogate pairs included), so `codePointAt(0)` is always
    // defined; the `undefined` branch is unreachable and falls back to `character` unchanged
    // rather than asserting.
    const codePoint = character.codePointAt(0);
    mapped += (codePoint === undefined ? undefined : confusableReplacement(codePoint)) ?? character;
  }
  return mapped.normalize('NFD');
}

/** Two names a reader cannot tell apart, in the order they occurred. */
export interface ConfusableCollision {
  /** The name that appeared first — what a diagnostic reports the second name as colliding with. */
  readonly first: string;
  /** The name that appeared second — what a diagnostic reports as the offender (§8.2 "on detection"). */
  readonly second: string;
}

/**
 * The first pair of `names` sharing a UTS #39 skeleton, or `undefined` when every name in the
 * scope is distinguishable from every other — [TSON-DATA] §8.2 mechanism 1, applied over one
 * named scope.
 *
 * Fires only on a colliding **pair**: a name is never refused alone, and an outright duplicate
 * (the same string appearing twice) is left for the caller's own duplicate-name rule rather than
 * reported here — the two are different defects, and this function reports neither the first
 * occurrence of a name nor a second, identical occurrence of it as a collision.
 *
 * Reported at the second occurrence's position, in the manner of §2.6's duplicate-key diagnostic
 * (§8.2 "on detection") — which is why {@link ConfusableCollision.second} is the name a caller
 * should locate the diagnostic at, and `first` is what the message names it as confusable with.
 */
export function firstConfusableCollision(names: Iterable<string>): ConfusableCollision | undefined {
  const bySkeleton = new Map<string, string>();
  for (const name of names) {
    const key = skeleton(name);
    const previous = bySkeleton.get(key);
    if (previous === undefined) {
      bySkeleton.set(key, name);
    } else if (previous !== name) {
      return { first: previous, second: name };
    }
  }
  return undefined;
}
