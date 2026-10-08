/**
 * Whether a compound value's element or entry order is part of its identity ([TSON-SCHEMA] §5.3,
 * §7.5): two arrays or maps that differ only in order are one value exactly when their type says
 * `ordered: false`. A map defaults to unordered, an array to ordered, and `set_type` to unordered.
 *
 * The order is a property of the **type**, which a value does not carry, and identity is decided
 * on values nested inside other values (a set of sets). A reader therefore records the declaring
 * type's `ordered` against the node it builds ({@link declareOrder}), and every identity function
 * both encodings compare by reads it back ({@link declaredOrder}). The record is out of band so a
 * node's shape, and what a writer emits, is untouched: `ordered` never changes what a document may
 * write, and output keeps the order written.
 *
 * A node nothing declared an order for (a schemaless read, a schema-supplied fixed value) is
 * compared in sequence unless the other side of the comparison declares it unordered.
 */

const declared = new WeakMap<object, boolean>();

/** Records that `node`'s type says `ordered`; returns `node`. */
export function declareOrder<T extends object>(node: T, ordered: boolean): T {
  declared.set(node, ordered);
  return node;
}

/** The `ordered` the node's type declared, or `undefined` when no reader declared one. */
export function declaredOrder(node: object): boolean | undefined {
  return declared.get(node);
}

/**
 * Whether `a` and `b` hold the same members regardless of order: each member of `a` pairs with a
 * distinct equal member of `b`. Quadratic, like the duplicate checks that call it.
 */
export function sameMembers<T>(
  a: readonly T[],
  b: readonly T[],
  equal: (x: T, y: T) => boolean,
): boolean {
  if (a.length !== b.length) return false;
  const unmatched = [...b];
  for (const x of a) {
    const at = unmatched.findIndex((y) => equal(x, y));
    if (at < 0) return false;
    unmatched.splice(at, 1);
  }
  return true;
}
