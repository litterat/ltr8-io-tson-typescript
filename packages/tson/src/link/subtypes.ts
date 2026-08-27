/**
 * Populates {@link TypeDefinition.subtypes}, the reverse of {@link TypeDefinition.supertypes} —
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
import type { TypeDefinition } from '../schema/meta/typedef.js';

/**
 * `def` plus `newSubtypes`, unioned with whatever subtypes it already had — a new
 * {@link TypeDefinition}, `def` itself untouched. Order is preserved: `def.subtypes` first, then
 * any of `newSubtypes` not already present.
 */
export function withAddedSubtypes(
  def: TypeDefinition,
  newSubtypes: ReadonlySet<string> | readonly string[],
): TypeDefinition {
  const combined = new Set(def.subtypes);
  for (const name of newSubtypes) combined.add(name);
  if (combined.size === def.subtypes.length) {
    return def; // nothing new -- keep the same reference rather than an equal-but-fresh copy
  }
  return { ...def, subtypes: [...combined] };
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
  merged: ReadonlyMap<string, TypeDefinition>,
  localNames: ReadonlySet<string>,
): Map<string, TypeDefinition> {
  const newSubtypesByName = new Map<string, Set<string>>();
  for (const localName of localNames) {
    const def = merged.get(localName);
    if (def === undefined) continue;
    for (const supertype of def.supertypes) {
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
export function unifySubtypes(incumbent: TypeDefinition, arriving: TypeDefinition): TypeDefinition {
  if (arriving.subtypes.every((s) => incumbent.subtypes.includes(s))) {
    return incumbent;
  }
  return withAddedSubtypes(incumbent, arriving.subtypes);
}
