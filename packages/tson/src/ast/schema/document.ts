import type { Annotation } from '../value.js';
import type { Position } from '../../core/position.js';
import type { TypeDef } from './typedef.js';
import type { TypeRef } from './typeref.js';

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
 * `schema-map-entry = *(annotation ws) type-name ws "=>" ws *(annotation ws) [ definition-mark ws
 * ] type-def` (§12.1, §2.1) — one entry of a {@link SchemaMap}: a type name bound to a type
 * definition.
 *
 * `nameAnnotations` bind to the key — the `type_name` token itself; the resolver does not
 * hoist annotations from key to value (§2.1). `typeDefAnnotations` bind to the type
 * definition, after `=>`.
 *
 * `mark` is §5.2's definition mark — `abstract` or `final`, read unconditionally at this one
 * slot and an ordinary identifier everywhere else ([TSON-DATA] §7.7): `abstract => { ... }`
 * declares a type of that name (the mark position is never reached, since it sits *before* the
 * type-def this slot introduces, at the previous token), and `f: abstract` references it. A
 * declaration whose whole type-def is the bare mark word is a declaration missing its
 * definition — a parse error the parser building this type raises, never represented here. A
 * mark on a non-record definition is a resolver error, not a parse error.
 *
 * `position` is the name token's own source position — this package's diagnostic addition, with
 * no counterpart in the grammar itself. `compiler/schemaResolver.ts` copies it onto the resolved
 * `TypeDefinition` (§8.1's own diagnostic addition there), which is what lets a
 * `Diagnostic.schemaPosition` name a line at all: without it every resolved entry's `position` is
 * `undefined` and every diagnostic naming that entry loses its line. `compiler/desugar.ts` carries
 * it forward automatically when it rebuilds a declaration whose body contains sugar (a plain
 * object spread), so a rewritten declaration keeps the position its author wrote.
 */
export interface Declaration {
  readonly nameAnnotations: readonly Annotation[];
  readonly name: string;
  readonly typeDefAnnotations: readonly Annotation[];
  readonly mark?: 'abstract' | 'final';
  readonly typeDef: TypeDef;
  /**
   * The types the declaration's parameter list wrote — `<T: text, N: int8>` — keyed by parameter
   * name, only for the parameters that wrote one (§5.10, §12.1). A written type narrows the type
   * the parameter's positions give, so it lives beside the type-def rather than inside it: every
   * desugar rewrite of the type-def keeps the declaration's own list as written. Absent when no
   * parameter wrote a type.
   */
  readonly parameterTypes?: ReadonlyMap<string, TypeRef>;
  readonly position?: Position;
}
