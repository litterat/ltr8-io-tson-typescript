/**
 * The kernel constructor whose binding reads a meta layer's own constructor ([TSON-SCHEMA] §2.2.2,
 * §7.4): `text_enum => enum_type ^ { name_type?: = text_identifier }` declares no vocabulary of its
 * own, so an entry applying it, `city => !text_enum [ "New York" "Sydney" ]`, is an enum body read
 * through `enum_type`'s binding, under `text_enum`'s own field policy -- which is where the pinned
 * `name_type` is injected from. The body is the binding's; the facts the constructor pins are its
 * own.
 *
 * **The most derived ancestor wins.** A constructor's `chain.supertypes` is its closed IS-A chain,
 * sorted by name rather than by distance, so the binding chosen is that of the ancestor among them
 * whose own chain is longest -- `enum_type` rather than any base kind it composes, were one ever to
 * carry a binding of its own.
 */
import type { Top } from './meta/typedef.js';
import { supertypesOf } from './meta/typedef.js';

/**
 * The name of `type`'s most derived ancestor `hasBinding` admits, reading each constructor's
 * declaration through `lookup`; `undefined` when no ancestor has one.
 */
export function inheritedBindingName(
  type: string,
  lookup: (name: string) => Top | undefined,
  hasBinding: (name: string) => boolean,
): string | undefined {
  let best: string | undefined;
  let depth = -1;
  for (const ancestor of supertypesOf(lookup(type))) {
    if (!hasBinding(ancestor)) continue;
    const own = supertypesOf(lookup(ancestor)).length;
    if (own > depth) {
      best = ancestor;
      depth = own;
    }
  }
  return best;
}
