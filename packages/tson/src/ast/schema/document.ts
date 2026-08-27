import type { Annotation } from '../value.js';
import type { TypeDef } from './typedef.js';

/**
 * A schema document (Part 2 §2.1, §12.1): a fixed-shape header — optional `!!id`, mandatory
 * `!!meta` (exactly once), repeatable `!!import` in declaration order — followed by the
 * {@link SchemaMap} body.
 *
 * Every directive value is a URL string, preserved uninterpreted here (§2.2): resolving them
 * against the schema library (§10) is a later, semantic-layer concern this grammar-only AST
 * does not implement.
 */
export interface SchemaDocument {
  /** The `!!id` directive's value, when the schema states one (§2.2.1). Absent for a development schema. */
  readonly id?: string;
  /** The `!!meta` directive's value: the governing meta-schema, exactly once, mandatory (§2.2.2). */
  readonly meta: string;
  /** The `!!import` directives' values, in declaration order (§2.2.3). */
  readonly imports: readonly string[];
  /** The braced declaration map that follows the header. */
  readonly body: SchemaMap;
}

/**
 * `schema-map = *(annotation ws) "{" ws schema-map-entry *(separator schema-map-entry) ws "}"`
 * (§12.1, §2.1) — the schema document's body: an annotated, braced declaration map.
 *
 * The grammar requires at least one entry — `{}` at schema-body position is a parse error,
 * unlike an ordinary data map — but that cardinality rule is enforced by the parser that
 * builds this type, not encoded in the type itself: this layer states shapes, not validation.
 *
 * `annotations` bind to the schema map itself, the document's own annotation anchor (§2.1).
 */
export interface SchemaMap {
  readonly annotations: readonly Annotation[];
  /**
   * Declarations keyed by name, **insertion order preserved**.
   *
   * The Java model uses a `LinkedHashMap`; a `ReadonlyMap` is its TS counterpart — the
   * built-in `Map` iterates `keys()`/`values()`/`entries()` (and a plain `for...of`) in
   * insertion order, so walking `declarations` sees them in source order while still giving a
   * resolver §3.4.1's Pass 1 wants ("populated with skeleton records keyed by name") direct
   * O(1) lookup by name. Two declarations sharing a name are not rejected at this layer: the
   * later one simply overwrites the earlier one's map entry — the same "detection is a
   * resolver-layer concern, not a grammar one" treatment [TSON-DATA] gives duplicate record
   * fields and map keys.
   */
  readonly declarations: ReadonlyMap<string, Declaration>;
}

/**
 * `schema-map-entry = *(annotation ws) type-name ws "=>" ws *(annotation ws) type-def`
 * (§12.1, §2.1) — one entry of a {@link SchemaMap}: a type name bound to a type definition.
 *
 * `nameAnnotations` bind to the key — the `type_name` token itself; the resolver does not
 * hoist annotations from key to value (§2.1). `typeDefAnnotations` bind to the type
 * definition, after `=>`.
 */
export interface Declaration {
  readonly nameAnnotations: readonly Annotation[];
  readonly name: string;
  readonly typeDefAnnotations: readonly Annotation[];
  readonly typeDef: TypeDef;
}
