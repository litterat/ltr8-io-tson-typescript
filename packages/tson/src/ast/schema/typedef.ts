import type { AtomRefinement, Instance, RecordEntry, RemovalSet } from './fields.js';
import type { TypeRef } from './typeref.js';

/**
 * `type-def` (Part 2 §12.1) — the right-hand side of a declaration (§5.1). Every
 * type-definition form resolves to a `type_definition` value (§8, out of scope for this
 * grammar-only AST); this union models the surface syntax the resolver would consume, one
 * member per top-level ABNF alternative:
 *
 * - {@link AtomRefinement} — `"!" type-name ws "^" ws record-def` (§5.5)
 * - {@link Instance} — `[type-params] "!" type-name ws core-value` (§5.5, constructor
 *   application; a parameter list makes it a template and leaves the payload untouched — an
 *   open entry's body is held rather than read against its constructor's vocabulary until
 *   materialisation substitutes, so a collection payload is as ordinary as a scalar one)
 * - {@link StructuralTypeDef} — `[type-params] ["~"] structural-def` (§5.7–§5.9)
 * - {@link ReferenceTypeDef} — `[type-params] type-ref` (§8.3): a plain reference, or any
 *   container form, since a declaration-level container reaches this union through `type-ref`
 *   like every other position
 *
 * Every member has an ABNF alternative behind it — none is synthesised at this layer. §5.3's
 * sized sugar (`[T; 1..2]`) is no exception: it parses as a {@link ReferenceTypeDef} wrapping
 * an `ArrayRef`, and rewriting it into the `Instance` its bindings denote is desugaring's job,
 * a later phase this AST does not perform.
 *
 * Discriminated on `kind` via each member's own `kind` field.
 */
export type TypeDef = AtomRefinement | Instance | StructuralTypeDef | ReferenceTypeDef;

/**
 * `[type-params] ["~"] structural-def` (§12.1, §4.2, §5.10) — a refinement, composition or
 * subtraction, or fresh record, optionally parameterized and optionally marked as a
 * constructor.
 */
export interface StructuralTypeDef {
  readonly kind: 'structuralTypeDef';
  /** Parameter names from the declaration's own `<...>` (§5.10); empty for an unparameterized definition. */
  readonly typeParams: readonly string[];
  /**
   * `true` only when the source carried a literal `~` — the sole signal for `constructor:
   * true` in resolver output (§5.8: "constructor marker is independent of supertypes"). A bare
   * record or composition with no `~` is an ordinary (non-constructor) type even though it
   * uses the same {@link StructuralDef} shapes.
   */
  readonly constructor: boolean;
  readonly body: StructuralDef;
}

/**
 * `[type-params] type-ref` (§12.1, §8.3) — a declaration whose body is a plain type reference:
 * `id => uuid`, a fully- or partially-bound generic application
 * (`text_keyed_map => <V> map<text, V>`), or inline sugar
 * (`contact_method => (email | phone | address)`).
 *
 * Resolves to a `REFERENCE`-kind entry, a construction, or an open template depending on what
 * `ref` turns out to name — a semantic-layer distinction (§5.6, §5.10) this grammar-only AST
 * does not make.
 */
export interface ReferenceTypeDef {
  readonly kind: 'referenceTypeDef';
  readonly typeParams: readonly string[];
  readonly ref: TypeRef;
}

/**
 * `structural-def = refined-def / construction-def / record-def` (§12.1) — the three forms a
 * (possibly `~`-marked) {@link StructuralTypeDef} can wrap.
 */
export type StructuralDef = RefinedDef | ConstructionDef | RecordDef;

/**
 * `refined-def = type-name [ws "<" type-args ">"] ws "^" ws record-def` (§12.1, §5.7) —
 * record, map/array-head, or (with a preceding `~`) constructor refinement.
 *
 * `target` is restricted by grammar to a bare type-name, optionally with type-args — inline
 * structural forms (a choice, an inline array) cannot precede `^`, so `target` is always a
 * `SimpleRef` or a `GenericRef`, never an `ArrayRef`/`MapRef`/`TupleRef`/`ChoiceRef`. That
 * narrower fact is not encoded in `target`'s type (every `TypeRef` variant satisfies the
 * field); a parser building this type is responsible for never constructing it with anything
 * else.
 *
 * No removal clause is admitted on a refinement head (§5.7, §5.9) — there is deliberately no
 * field for one.
 */
export interface RefinedDef {
  readonly kind: 'refinedDef';
  readonly target: TypeRef;
  readonly body: RecordDef;
}

/**
 * Supertype composition and/or subtraction (§12.1, §5.8, §5.9): one or more `&`-joined
 * supertypes, an optional trailing `record-def` body, and an optional trailing `removal-set`.
 *
 * `supertypes` always has at least one element — encoded here as a non-empty tuple type —
 * since a lone type-ref with neither a body nor a removal is not a `ConstructionDef` at all,
 * just a {@link ReferenceTypeDef} wrapping a plain `TypeRef` (§12.2's disambiguation: `name
 * &`/`name -` enter this production, bare `name` does not).
 *
 * Each `supertypes` element is restricted by grammar to a `SimpleRef` or `GenericRef` (a
 * `supertype-ref`, never a paren/bracket/map form, §4.3/§5.8) — not encoded in the element
 * type, for the same reason as {@link RefinedDef.target}.
 */
export interface ConstructionDef {
  readonly kind: 'constructionDef';
  readonly supertypes: readonly [TypeRef, ...TypeRef[]];
  readonly body?: RecordDef;
  readonly removal?: RemovalSet;
}

/**
 * `record-def = "{" ws [record-entry *(separator record-entry)] ws "}"` (§12.1, §5.2) — a
 * braced record body: fresh (no supertypes), a refinement's tightening body, a construction's
 * trailing body, or an atom refinement's constraint bindings (`AtomRefinement.bindings`,
 * `fields.ts`). An empty `{}` is the zero-field case — the shape of the kernel's `top`.
 */
export interface RecordDef {
  readonly kind: 'recordDef';
  readonly entries: readonly RecordEntry[];
}
