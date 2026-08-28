/**
 * Structural equality over {@link Value} and the host {@link AtomValue} types it can hold -- what
 * `record.ts`'s FIXED-field check needs to compare a document-stated value against the schema's own
 * precomputed one (§5.2: "a contradicting value is a validation error"), the port of Java's plain
 * `Objects.equals` over two already-decoded values of the same reader's own output type.
 *
 * A general recursive structural comparison rather than one written against a specific `AtomValue`
 * member: the value on either side of a FIXED check comes from running the *same* field parser twice
 * (once over the schema's own literal, once over whatever the document wrote), so whatever shape that
 * parser produces -- a bare primitive, a `bigint`, a `TsonDecimal`, a temporal/network record, or (a
 * schema-default composite is not resolved anywhere yet, per `RecordAbstractReader`'s own note, but a
 * written value could still legitimately be one) a nested {@link Value} tree -- this must compare it
 * correctly without knowing in advance which one it is.
 */
import type { Value } from '../../tree/nodes.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep structural equality over two arbitrary host values -- primitives, `bigint`, `Uint8Array`, arrays, and plain records, recursively. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    return typeof a === typeof b && a === b;
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((element, i) => deepEqual(element, b[i]));
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) {
      if (!b.has(key) || !deepEqual(value, b.get(key))) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/** {@link deepEqual} specialised to two {@link Value} tree nodes -- the shape `record.ts`'s FIXED check actually compares. */
export function valuesEqual(a: Value, b: Value): boolean {
  return deepEqual(a, b);
}
