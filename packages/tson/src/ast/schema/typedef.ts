import type { DataValue } from '../value.js';
import type { AtomRefinement, Instance, RecordEntry, RemovalSet } from './fields.js';
import type { Reference, TypeExpr } from './typeref.js';

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
 * - {@link StructuralTypeDef} — `[type-params] structural-def` (§5.7–§5.9)
 * - {@link ReferenceTypeDef} — `[type-params] type-expr` (§8.3): a plain reference, or any
 *   container form, since a declaration-level container reaches this union through `type-expr`
 *   like every other position
 * - {@link SchemaMapDef} — `"!schema" ws schema-map`: a schema map nested as an entry (§4.1)
 * - {@link RecordTemplateDef} — a record template as the desugar phase normalises it; no parser builds one
 *
 * Every member has an ABNF alternative behind it — none is synthesised at this layer. §5.3's
 * sized sugar (`[T; 1..2]`) is no exception: it parses as a {@link ReferenceTypeDef} wrapping
 * an `ArrayRef`, and rewriting it into the `Instance` its bindings denote is desugaring's job,
 * a later phase this AST does not perform.
 *
 * **There is no constructor marker.** §12.1's own grammar states it explicitly: "there is no
 * constructor marker: an entry is a constructor by being IS-A `top` (§4.2), and `~` is a
 * special token with no role at type-def position." `~` keeps exactly one grammar role, the
 * field-modifier default-value marker (§5.2's `field-modifier`); a `~` written here is a parse
 * error (`class2/schema/invalid/a-constructor-marker-is-not-grammar` states the corpus's own
 * name for it).
 *
 * Discriminated on `kind` via each member's own `kind` field.
 */
export type TypeDef =
  | AtomRefinement
  | Instance
  | StructuralTypeDef
  | ReferenceTypeDef
  | SchemaMapDef
  | RecordTemplateDef;

/**
 * `"!schema" ws schema-map` as a declaration's value (§12.1, §4.1): a schema map nested as an entry,
 * `geo => !schema { address => { ... } }`. It is a value of the kernel's `schema` namespace type, and
 * every value of `schema` declares as the document's root does: its members are declarations, which
 * lift, mint, link and compile as root entries do. The `!schema` tag is read as a spelling, as the
 * root's is.
 *
 * **The members are not held here.** The parser puts each into the document's one declaration map
 * under its path from the root (`geo.address`), which is the member's identity and the name every later
 * phase addresses it by; a further nested map's members are keyed the same way, one segment deeper.
 * This node is what the entry itself declares: the names of its members, unqualified, in the order
 * written.
 */
export interface SchemaMapDef {
  readonly kind: 'schemaMapDef';
  /** The members' own names, in source order; never empty, a schema map declaring at least one entry. */
  readonly members: readonly [string, ...string[]];
}

/**
 * A record template as the desugar phase normalises it (§5.2, §5.10): the declaration's parameters
 * and the `!meta.record_template { ... }` payload its body denotes, each field labelled where the
 * parameters are in scope -- a bare parameter name in a field's type is its `type_param`, an unquoted
 * parameter token in its value its `value_param` -- and the parameters stated last, each provisionally a
 * type parameter.
 *
 * **The one variant no parser builds.** Both spellings of a record template reach it -- the sugar body
 * `<T> { x: T }` and the explicit `<T> !meta.record { ... }` -- and nothing an author writes does: a
 * written `!meta.record_template { ... }` is an {@link Instance}, which the resolver refuses as resolver
 * vocabulary (§8.1). So the type, not a flag, is what tells the desugarer's own output from a
 * construction an author wrote.
 *
 * Every slot but the labels and the parameter list is carried as written, so the resolver still answers
 * the author's spelling in the author's terms.
 */
export interface RecordTemplateDef {
  readonly kind: 'recordTemplateDef';
  readonly typeParams: readonly string[];
  readonly payload: DataValue;
}

/**
 * `[type-params] structural-def` (§12.1, §5.7–§5.9) — a refinement, composition or subtraction,
 * or a fresh record, optionally parameterized.
 *
 * Whether the entry this resolves to is a *constructor* is never a fact this shape carries: an
 * entry IS-A `top` (§4.2) by what it composes or refines, transitively — derived from the
 * resolved entry's `chain.supertypes` (`schema/meta/typedef.ts`'s `isConstructor`), never
 * marked at the declaration.
 */
export interface StructuralTypeDef {
  readonly kind: 'structuralTypeDef';
  /** Parameter names from the declaration's own `<...>` (§5.10); empty for an unparameterized definition. */
  readonly typeParams: readonly string[];
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
  readonly ref: TypeExpr;
}

/**
 * `structural-def = refined-def / construction-def / record-def` (§12.1) — the three forms a
 * (possibly `~`-marked) {@link StructuralTypeDef} can wrap.
 */
export type StructuralDef = RefinedDef | ConstructionDef | RecordDef;

/**
 * `refined-def = type-ref ws "^" ws record-def` (§12.1, §5.7) —
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
  readonly target: Reference;
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
  readonly supertypes: readonly [Reference, ...Reference[]];
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
