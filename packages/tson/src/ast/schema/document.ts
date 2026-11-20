import type { Annotation } from '../value.js';
import type { Position } from '../../core/position.js';
import type { TypeDef } from './typedef.js';
import type { TypeExpr } from './typeref.js';

/**
 * A schema document (Part 2 §2.1, §12.1): the data header — optional `!!id`, then any number of
 * `!!import`s in declaration order — followed by the {@link SchemaMap} body, the root tagged
 * `!schema`.
 *
 * Every directive value is a URL string, preserved uninterpreted here (§2.2): resolving them
 * against the schema library (§10) is a later, semantic-layer concern this grammar-only AST
 * does not implement.
 */
export interface SchemaDocument {
  /** The `!!id` directive's value, when the schema states one (§2.2.1). Absent for a development schema. */
  readonly id?: string;
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
 * `schema-map-entry = *(annotation ws) type-name ws "=>" ws *(annotation ws) type-def` (§12.1, §2.1) —
 * one entry of a {@link SchemaMap}: a type name bound to a type definition.
 *
 * `nameAnnotations` bind to the key — the `type_name` token itself; the resolver does not
 * hoist annotations from key to value (§2.1). `typeDefAnnotations` bind to the type
 * definition, after `=>`.
 *
 * A definition mark (`abstract`, `final`) is the record definition's own
 * (`StructuralTypeDef.mark`): it stands before a record definition alone (§12.1, item 136).
 *
 * `position` is the name token's own source position — this package's diagnostic addition, with
 * no counterpart in the grammar itself. `compiler/schemaResolver.ts` copies it onto the resolved
 * entry's facts (§8.1's own diagnostic addition there), which is what lets a
 * `Diagnostic.schemaPosition` name a line at all: without it every resolved entry's `position` is
 * `undefined` and every diagnostic naming that entry loses its line. `compiler/desugar.ts` carries
 * it forward automatically when it rebuilds a declaration whose body contains sugar (a plain
 * object spread), so a rewritten declaration keeps the position its author wrote.
 */
export interface Declaration {
  readonly nameAnnotations: readonly Annotation[];
  readonly name: string;
  readonly typeDefAnnotations: readonly Annotation[];
  readonly typeDef: TypeDef;
  /**
   * The types the declaration's parameter list wrote — `<T: text, N: int8>` — keyed by parameter
   * name, only for the parameters that wrote one (§5.10, §12.1). A written type narrows the type
   * the parameter's positions give, so it lives beside the type-def rather than inside it: every
   * desugar rewrite of the type-def keeps the declaration's own list as written. Absent when no
   * parameter wrote a type.
   */
  readonly parameterTypes?: ReadonlyMap<string, TypeExpr>;
  readonly position?: Position;
}
