/**
 * Populates each type's `chain.subtypes`, the reverse of its `chain.supertypes` —
 * never done anywhere before this (`definitionResolver.ts`'s own doc: "`subtypes` is never
 * populated — the reverse index over a whole resolved schema is a global pass, not a
 * per-declaration concern; deliberately deferred to a later work package (linking)"). This module
 * is that later work package.
 *
 * Ported from the reference implementation's `TsonSchemaLinker.computeSubtypes`/
 * `withAddedSubtypes`/`unified` (`tson-compiler/.../TsonSchemaLinker.java`); see that file's own
 * module doc for the exhaustive rationale.
 *
 * **Since `supertypes` is already the full *transitive* IS-A chain** (by the induction
 * `definitionResolver.ts`'s own composition/refinement resolution already performs), the reverse
 * index falls out just as transitively for free: if `success_response`'s own `supertypes`
 * includes both `response` and (transitively) `top`, then both gain `success_response` as a
 * subtype here, with no separate transitive-closure step needed.
 */
import type { Top } from '../schema/meta/typedef.js';
import { chainOf, isType, subtypesOf, supertypesOf, withChain } from '../schema/meta/typedef.js';

/**
 * `def` plus `newSubtypes`, unioned with whatever subtypes it already had — a new
 * value, `def` itself untouched. The result is sorted, a chain's one spelling: `def`'s subtypes and
 * any of `newSubtypes` not already present.
 */
export function withAddedSubtypes(
  def: Top,
  newSubtypes: ReadonlySet<string> | readonly string[],
): Top {
  if (!isType(def)) return def; // a value with no chain has no subtypes to record
  const existing = subtypesOf(def);
  const combined = new Set(existing);
  for (const name of newSubtypes) combined.add(name);
  if (combined.size === existing.length) {
    return def; // nothing new -- keep the same reference rather than an equal-but-fresh copy
  }
  const chain = chainOf(def);
  return withChain(def, { ...chain, subtypes: [...combined].sort() });
}

/**
 * Populates `subtypes` over `merged` (every entry this schema can see, imported or local) for
 * every supertype credited by a `localNames` entry.
 *
 * **Only `localNames` entries are walked as potential subtypes — but the supertype being
 * credited may be anywhere in `merged`, imported or local.** An import's own already-linked
 * entries are never mutated by this: `merged` is a plain `Map` built fresh by the caller (see
 * `link.ts`'s own `mergeImports`), so replacing one of its values here changes only *this*
 * schema's own result, never whatever schema `merged`'s imported entries came from. So when a
 * local entry composes with an imported supertype, crediting the subtype onto this schema's own
 * view of that supertype is safe and correct: from this schema's own perspective the supertype
 * genuinely does have that subtype, even though the imported schema, examined on its own,
 * correctly doesn't know about it.
 *
 * Pure: `merged` is read, never mutated: entries with no new subtype keep their identity, and
 * `merged` itself is returned unchanged when nothing has any.
 */
export function computeSubtypes(
  merged: ReadonlyMap<string, Top>,
  localNames: ReadonlySet<string>,
): Map<string, Top> {
  const newSubtypesByName = new Map<string, Set<string>>();
  for (const localName of localNames) {
    const def = merged.get(localName);
    if (def === undefined) continue;
    for (const supertype of supertypesOf(def)) {
      if (!merged.has(supertype)) continue;
      let set = newSubtypesByName.get(supertype);
      if (set === undefined) {
        set = new Set();
        newSubtypesByName.set(supertype, set);
      }
      set.add(localName);
    }
  }
  if (newSubtypesByName.size === 0) {
    return new Map(merged);
  }

  const result = new Map(merged);
  for (const [name, additions] of newSubtypesByName) {
    const def = result.get(name);
    if (def === undefined) continue;
    result.set(name, withAddedSubtypes(def, additions));
  }
  return result;
}

/**
 * One entry reached by two `!!import` routes, reconciled (the diamond case: two different
 * imports both transitively reach one schema). Both copies came from the same declaring schema,
 * so they agree on everything the declaring schema resolved — everything except `subtypes`,
 * which each route's own linking credited against *its* view of the namespace
 * ({@link computeSubtypes}). The union is the answer §9 requires: `subtypes` is the transitive
 * inverse of `supertypes` across *this* schema's namespace, and this schema can see both routes'
 * subtypes even though neither route could see the other's.
 */
export function unifySubtypes(incumbent: Top, arriving: Top): Top {
  const known = subtypesOf(incumbent);
  if (subtypesOf(arriving).every((s) => known.includes(s))) {
    return incumbent;
  }
  return withAddedSubtypes(incumbent, subtypesOf(arriving));
}
