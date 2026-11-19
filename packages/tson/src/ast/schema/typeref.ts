import type { TokenValue } from '../value.js';
import type { SizeSpec } from './fields.js';

/**
 * `type-expr = paren-type / bracket-type / map-type / type-ref` (Part 2 §12.1) -- a type expression
 * at any position one is legal: a declaration's own body, field types, type arguments, choice
 * variants, elements, composition/refinement targets. It is a {@link Reference} or one of the
 * four structural forms ({@link ChoiceExpr}, {@link ArrayExpr}, {@link TupleExpr}, {@link MapExpr}),
 * each of which holds further expressions.
 *
 * One tier, not two: every container form is legal at every type-expression position, with no
 * separate declaration-level production. Each of those, and every application, is a **syntactic**
 * node -- desugaring (a later phase, outside this AST) lifts a concrete one to a closed synthetic
 * entry and a parameter-bearing one to an open synthetic entry; this union represents exactly what
 * was written, never a pre-normalised or pre-desugared form.
 *
 * Discriminated on `kind`.
 */
export type TypeExpr = Reference | ArrayExpr | MapExpr | TupleExpr | ChoiceExpr;

/**
 * A reference as written: a {@link TypeRef}, naming a type by its qualified name and any arguments, or
 * a {@link SiblingRef}, naming the field of the same record whose value names the type
 * ([TSON-DATA] §7.4, Part 2 §12.1). The shape mirrors the resolved model's `Reference`
 * (`schema/meta`). A reference parses wherever a {@link TypeExpr} does, and wherever the grammar admits a
 * reference alone: a map's key, a refinement's source, a composition's operand. A sibling reference
 * stands only at a record field's type; the desugar phase refuses it everywhere else (§5.2).
 */
export type Reference = TypeRef | SiblingRef;

/**
 * `qualified-name ["<" type-args ">"]` (§12.1) -- a reference to a type: a {@link NameRef} or an
 * {@link ApplicationRef}. The shape of the resolved model's `TypeRef`, the value of `meta.type_ref`.
 */
export type TypeRef = NameRef | ApplicationRef;

/** `qualified-name` alone (§12.1) -- a bare reference with no type arguments, `geo.address` included. */
export interface NameRef {
  readonly kind: 'nameRef';
  readonly name: string;
}

/**
 * `qualified-name "<" type-args ">"` (§12.1, §5.3) -- an application: `map<text, integer>`, or a
 * template application such as `vector<pixel, 1920>`. Whether `name` resolves to a constructor, a
 * non-constructor template, or is a resolver error is a later, semantic-layer question (§3.3.1,
 * §5.10) -- not decided here.
 *
 * **The arguments-present invariant.** {@link NameRef} (no arguments) and {@link ApplicationRef} (one or
 * more) encode the desugarer's central rule: *a reference carrying arguments denotes an open form --
 * a template application whose arguments materialisation later substitutes; a reference carrying none
 * is a bare name.* `type-args` requires at least one `type-arg` by §12.1's grammar, encoded here as a
 * non-empty tuple. `args` is never rewritten, reordered, or dropped by anything at this layer.
 */
export interface ApplicationRef {
  readonly kind: 'applicationRef';
  readonly name: string;
  readonly args: readonly [TypeArg, ...TypeArg[]];
}

/**
 * `sibling-ref = unquoted-token "!"` (§12.1, [TSON-DATA] §7.4) -- the field `field` of the same
 * record instance, whose value names the type: `kind!`. It parses wherever a {@link Reference} does,
 * and stands only at a record field's type (§5.2).
 */
export interface SiblingRef {
  readonly kind: 'siblingRef';
  readonly field: string;
}

/**
 * `type-arg = type-expr / value-literal` (§12.1) — one argument inside a generic application's
 * `<...>`.
 *
 * **An unquoted, non-numeric argument token always parses as {@link TypeArgRef}, never
 * {@link TypeArgValue}.** §12.1 is explicit that the two are not disambiguated by grammar for
 * that case: whether such a token denotes a type or a value (an enum member, for instance) is
 * settled against the applied signature's parameter kinds (§5.10), not by the grammar. This
 * layer resolves only the grammar-level part of that rule — a quoted token, or one whose text
 * matches the `number` production, is unambiguously {@link TypeArgValue}; every other token,
 * including one that will later turn out to be an enum member or a value-parameter reference,
 * is parsed as {@link TypeArgRef}, deferring the real classification to the semantic layer that
 * has the applied signature to consult. This mirrors `type-name`'s own numeric exclusion, so a
 * genuinely numeric argument can never collide with a type-ref reading in the first place.
 */
export type TypeArg = TypeArgRef | TypeArgValue;

/** A type-reference argument: `box<text>`, `pair<text, uuid>`. */
export interface TypeArgRef {
  readonly kind: 'ref';
  readonly ref: TypeExpr;
}

/** A scalar-literal argument: `vector<pixel, 1920>`'s `1920`. */
export interface TypeArgValue {
  readonly kind: 'value';
  readonly value: TokenValue;
}

/**
 * `element-type = type-expr ["?"]` (§12.1, §5.3) — one position inside an {@link ArrayExpr}, a
 * {@link TupleExpr}, or a {@link MapExpr}'s value.
 *
 * The `?` here makes the position `voidable`: the void sentinel `_` may stand in it (§5.3). It is
 * the same fact a field's type `?` states, at a container position. In `xs: [T?]?` the inner `?`
 * is the element's and the outer the field type's; a container's position is never missing, so
 * there is no counterpart of the field name's `?`.
 *
 * Holds a plain {@link TypeExpr} and nothing else; nesting needs no case of its own, because a
 * bracket or map form *is* a type-ref — `[[T; 2]; 3]` is an {@link ArrayExpr} whose
 * `elementType.typeRef` is itself an `ArrayExpr`.
 */
export interface ElementType {
  readonly typeRef: TypeExpr;
  /** `true` for a trailing `?` — the position may carry the void sentinel `_` in data. */
  readonly voidable: boolean;
}

/**
 * `"[" element-type [ws ";" ws size-spec] ws "]"` (§12.1, §5.3) — an array type, legal at
 * *every* type-ref position: a declaration's own body, a field type, an element, a type
 * argument, a choice variant. One production, not a separate declaration-level and inline
 * form — every position admits a size specifier and an element `?` alike.
 *
 * `size` absent means unconstrained. Nesting is the recursion in {@link ElementType}, which
 * holds a plain `TypeExpr`: `[[T; 2]; 3]` is this node twice over, needing no second node
 * family. This is a syntactic node — desugaring lifts it to a closed or open synthetic
 * `!array { ... }` entry; nothing here pre-normalises it.
 */
export interface ArrayExpr {
  readonly kind: 'arrayExpr';
  readonly elementType: ElementType;
  readonly size?: SizeSpec;
}

/**
 * `"{" ws map-key ws "=>" ws element-type [ws ";" ws size-spec] ws "}"` (§12.1, §5.3) — a map
 * type, legal at every type-ref position, mirroring the data notation's own `{k => v}` the way
 * {@link ArrayExpr} mirrors `[a b]`. Syntactic, like every sugar form — desugars to
 * `!map { key_type: ... value_type: ... }` at resolution, not here.
 *
 * The key is a {@link Reference} (`map-key = type-ref`, a qualified name optionally with type
 * arguments) and never a bracket, paren or map form: keeping it to a reference is what holds the
 * record/map brace dispatch (§12.2) to its stated lookahead budget, and a composite key type earns a
 * named declaration and the explicit `!meta.map { key_type: ... }` form instead. A sibling reference
 * parses as it does at every reference position and the desugar phase refuses it here (§5.2).
 *
 * The value is an {@link ElementType}: `{K => V?}` marks the value voidable exactly as `[T?]`
 * marks an array element (§5.3), under which an entry's value may be the void sentinel and the
 * entry still counts toward the size bounds. The key side carries no such suffix — a void key
 * is a resolver error ([TSON-DATA] §2.9), and `map-key` has no `?` to write (§12.1).
 */
export interface MapExpr {
  readonly kind: 'mapExpr';
  readonly keyType: Reference;
  readonly valueType: ElementType;
  readonly size?: SizeSpec;
}

/**
 * `"[" element-type 1*(separator element-type) "]"` (§12.1, §5.3) — a tuple type: two or more
 * positions, legal at every type-ref position, each carrying its own `?` to make the
 * position voidable. Syntactic — desugars to `!tuple { elements: [...] }` at resolution.
 *
 * Distinguished from {@link ArrayExpr} by arity alone — one element (with or without a size) is
 * an array, two or more a tuple — which is why the minimum arity is encoded structurally here
 * as a non-empty (2+) tuple type rather than checked at runtime.
 */
export interface TupleExpr {
  readonly kind: 'tupleExpr';
  readonly elementTypes: readonly [ElementType, ElementType, ...ElementType[]];
}

/**
 * `paren-type = "(" type-ref "|" type-ref *("|" type-ref) ")"` (§12.1, §5.4) — a choice type,
 * at least two variants. Desugars to `!choice { variants: [...] }` at resolution (§5.4); this
 * layer only records the variants as written, encoding the 2+ arity as a non-empty tuple type.
 */
export interface ChoiceExpr {
  readonly kind: 'choiceExpr';
  readonly variants: readonly [TypeExpr, TypeExpr, ...TypeExpr[]];
}
