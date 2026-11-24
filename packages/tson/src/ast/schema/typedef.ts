import type { AtomRefinement, Instance, RecordEntry, RemovalSet } from './fields.js';
import type { TypeExpr, TypeRef } from './typeref.js';

/**
 * `type-def` (Part 2 §12.1) — the right-hand side of a declaration (§5.1). Every
 * type-definition form resolves to a `type_definition` value (§8, out of scope for this
 * grammar-only AST); this union models the surface syntax the resolver would consume, one
 * member per top-level ABNF alternative:
 *
 * - {@link AtomRefinement} — `"!" qualified-name ws "^" ws core-value` (§5.5, §5.7): a refinement of a type,
 *   or over a constructor an incomplete entry (§5.5)
 * - {@link Instance} — `[type-params] "!" qualified-name ws core-value` (§5.5, constructor
 *   application; a parameter list is admitted before `!meta.record` alone, the explicit spelling of a
 *   parametric record, §5.10)
 * - {@link StructuralTypeDef} — `[definition-mark] [type-params] structural-def` (§5.2, §5.8, §5.9)
 * - {@link TypeExprDef} — `[type-params] type-expr` (§8.3): a plain reference, an application, or any
 *   container form, since a declaration-level container reaches this union through `type-expr`
 *   like every other position
 * - {@link SchemaMapDef} — `"!schema" ws schema-map`: a schema map nested as an entry (§4.1)
 *
 * Every member has an ABNF alternative behind it — none is synthesised at this layer. §5.3's
 * sized sugar (`[T; 1..2]`) is no exception: it parses as a {@link TypeExprDef} wrapping
 * an `ArrayExpr`, and rewriting it into the `Instance` its bindings denote is desugaring's job,
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
export type TypeDef = AtomRefinement | Instance | StructuralTypeDef | TypeExprDef | SchemaMapDef;

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
 * `[definition-mark ws] [type-params] structural-def` (§12.1, §5.2, §5.8, §5.9) — a record definition: a fresh
 * record, a composition or a subtraction, optionally parameterized. `mark` is §5.2's definition mark,
 * `abstract` or `final`, which stands before a record definition alone (item 136): before `!`, a type expression
 * or a declared application it is a parse error.
 *
 * Whether the entry this resolves to is a *constructor* is never a fact this shape carries: an
 * entry IS-A `top` (§4.2) by what it composes or refines, transitively — derived from the
 * resolved entry's `chain.supertypes` (`schema/meta/typedef.ts`'s `isConstructor`), never
 * marked at the declaration.
 */
export interface StructuralTypeDef {
  readonly kind: 'structuralTypeDef';
  readonly mark?: 'abstract' | 'final';
  /** Parameter names from the declaration's own `<...>` (§5.10); empty for an unparameterized definition. */
  readonly typeParams: readonly string[];
  readonly body: StructuralDef;
}

/**
 * `[type-params] type-expr` (§12.1, §8.3) — a declaration whose body is a type expression: `id => uuid`, an
 * application (`tags => set<text>`, `boxed => box<text>`), or sugar (`contact_method => (email | phone |
 * address)`). A parameter list here is the resolver's to refuse: a parametric record's body is a record (§5.10).
 *
 * Resolves to an alias, a construction, a completion or a declared application depending on what `ref` turns
 * out to name — a semantic-layer distinction this grammar-only AST does not make.
 */
export interface TypeExprDef {
  readonly kind: 'typeExprDef';
  readonly typeParams: readonly string[];
  readonly ref: TypeExpr;
}

/**
 * `structural-def = construction-def / record-def` (§12.1) — the forms a {@link StructuralTypeDef} wraps.
 * `^` follows `!name` alone (§5.7): a record is derived by `&`.
 */
export type StructuralDef = ConstructionDef | RecordDef;

/**
 * Supertype composition and/or subtraction (§12.1, §5.8, §5.9): one or more `&`-joined
 * supertypes, an optional trailing `record-def` body, and an optional trailing `removal-set`.
 *
 * `supertypes` always has at least one element — encoded here as a non-empty tuple type —
 * since a lone type-ref with neither a body nor a removal is not a `ConstructionDef` at all,
 * just a {@link TypeExprDef} wrapping a plain `TypeRef` (§12.2's disambiguation: `name
 * &`/`name -` enter this production, bare `name` does not).
 *
 * Each `supertypes` element is restricted by grammar to a `SimpleRef` or `GenericRef` (a
 * `supertype-ref`, never a paren/bracket/map form, §4.3/§5.8) — not encoded in the element
 * type; a parser building this type is responsible for that restriction.
 */
export interface ConstructionDef {
  readonly kind: 'constructionDef';
  readonly supertypes: readonly [TypeRef, ...TypeRef[]];
  readonly body?: RecordDef;
  readonly removal?: RemovalSet;
}

/**
 * `record-def = "{" ws [record-entry *(separator record-entry)] ws "}"` (§12.1, §5.2) — a
 * braced record body: fresh (no supertypes), a composition's trailing body, or a record written in
 * place at a type slot (`RecordExpr`). An empty `{}` is the zero-field case — the shape of the kernel's `top`.
 */
export interface RecordDef {
  readonly kind: 'recordDef';
  readonly entries: readonly RecordEntry[];
}
