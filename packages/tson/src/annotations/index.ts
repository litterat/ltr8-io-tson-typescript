import type { Annotation, DataValue } from '../ast/value.js';

/**
 * One `@name` or `@name:value` annotation (§3.1).
 *
 * Re-exported from the grammar rather than redeclared: an annotation *is* the AST node, its
 * argument is exactly one `data-value`, and a second structurally identical type would drift.
 */
export type { Annotation } from '../ast/value.js';

/** Constructs an {@link Annotation}: the valueless form `@name` when `value` is omitted, `@name:value` otherwise. */
export function annotation(name: string, value?: DataValue): Annotation {
  return value === undefined ? { name } : { name, value };
}

/**
 * The ordered annotations attached to one value (§3.1). A name may repeat — "§3.1 permits any number of
 * occurrences of one name on a single value and preserves them in source order" (per
 * `io.ltr8.annotation.Annotations`'s own Javadoc) — so this is a list, not a name-keyed map.
 *
 * The Java interface's default query methods (`get`, `getAll`, `value`, `values(name, type)`, `has`) are
 * behaviour derived from `values()` alone; they are not reproduced here, per this file's scope.
 */
export interface Annotations {
  /** Every annotation on this value, in source order. */
  readonly values: readonly Annotation[];
}

/** No annotations — what a position that wrote none carries. Mirrors `Annotations.empty()`. */
export const EMPTY_ANNOTATIONS: Annotations = { values: [] };

/** Constructs an {@link Annotations} from `values`, preserving source order. Mirrors `Annotations.of`. */
export function annotations(values: readonly Annotation[]): Annotations {
  return values.length === 0 ? EMPTY_ANNOTATIONS : { values };
}

/**
 * A value together with the wire annotations written at its position (§3.1) — the opt-in for a position
 * that cannot itself declare an {@link Annotations} component, such as a scalar field, an array element,
 * a tuple slot, or either side of a map entry. Mirrors `io.ltr8.annotation.Annotated<T>`.
 *
 * The Java type proxies `equals`/`hashCode` to `value` alone (annotations are metadata that "does not
 * change what a value *is*"); that behaviour is left to whatever later work package implements
 * equality/comparison over these types, not reproduced as a class here since this is a plain interface.
 */
export interface Annotated<T> {
  readonly value: T;
  readonly annotations: Annotations;
}

/**
 * Constructs an {@link Annotated} value. `annotationsFor` defaults to {@link EMPTY_ANNOTATIONS}, mirroring
 * `Annotated.of(value)`.
 */
export function annotated<T>(
  value: T,
  annotationsFor: Annotations = EMPTY_ANNOTATIONS,
): Annotated<T> {
  return { value, annotations: annotationsFor };
}

/**
 * A map whose keys carry their own annotations, presented as the plain entries it indexes plus a
 * parallel per-key annotation lookup. Mirrors `io.ltr8.annotation.AnnotatedMap<K, V>`.
 *
 * §3.1 lets an annotation attach to either side of a map entry, so a key is an annotatable position like
 * any other — but a plain `Map`/`ReadonlyMap` never hands back the exact key object it stored, so a key's
 * annotations cannot ride along inside `K` the way {@link Annotated} rides along a value (the Java
 * Javadoc's own reasoning for why `Map<Annotated<K>, V>` "cannot answer the question it appears to").
 * `keyAnnotations` is the parallel structure instead, keyed by the same `K`.
 *
 * The Java type's mutating/query behaviour (`put`, `getAnnotations`, `withAnnotations`,
 * `annotatedEntrySet`, `putAnnotated`, ...) is not reproduced here — this interface is the data shape that
 * behaviour would operate over, left to a later work package.
 */
export interface AnnotatedMap<K, V> {
  readonly entries: ReadonlyMap<K, V>;
  readonly keyAnnotations: ReadonlyMap<K, Annotations>;
}

/**
 * Constructs an {@link AnnotatedMap}. `keyAnnotations` defaults to empty, matching a map with no key
 * carrying annotations. Mirrors `AnnotatedMap.of`/`AnnotatedMap.copyOf`.
 */
export function annotatedMap<K, V>(
  entries: ReadonlyMap<K, V>,
  keyAnnotations: ReadonlyMap<K, Annotations> = new Map<K, Annotations>(),
): AnnotatedMap<K, V> {
  return { entries, keyAnnotations };
}
