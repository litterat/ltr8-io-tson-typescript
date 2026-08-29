import type { TokenValue } from '../value.js';
import type { SizeSpec } from './fields.js';

/**
 * `type-ref = paren-type / bracket-type / map-type / type-name "<" type-args ">" / type-name`
 * (Part 2 §12.1) — a reference to a type at any position one is legal: a declaration's own
 * body, field types, type arguments, choice variants, elements, composition/refinement targets.
 *
 * One tier, not two: every container form (`ArrayRef`, `TupleRef`, `MapRef`, `ChoiceRef`) is
 * legal at every type-ref position, with no separate declaration-level production. Each of
 * those, and every generic application, is a **syntactic** node — desugaring (a later phase,
 * outside this AST) lifts a concrete one to a closed synthetic entry and a parameter-bearing
 * one to an open synthetic entry; this union represents exactly what was written, never a
 * pre-normalised or pre-desugared form.
 *
 * Discriminated on `kind`. See {@link GenericRef} for the arguments-present invariant this
 * union's two "named" members (`SimpleRef`, `GenericRef`) exist to distinguish.
 */
export type TypeRef = SimpleRef | GenericRef | ArrayRef | MapRef | TupleRef | ChoiceRef;

/** `type-name` alone (§12.1) — a bare reference with no type arguments. */
export interface SimpleRef {
  readonly kind: 'simpleRef';
  readonly name: string;
}

/**
 * `type-name "<" type-args ">"` (§12.1, §5.3) — a generic application: `map<text, integer>`, or
 * a template application such as `vector<pixel, 1920>`. Whether `name` resolves to a
 * constructor, a non-constructor template, or is a resolver error is a later, semantic-layer
 * question (§3.3.1, §5.10) — not decided here.
 *
 * **The arguments-present invariant.** `SimpleRef` (no arguments) and `GenericRef` (one or
 * more) are this AST's direct encoding of the desugarer's central rule, stated one layer up in
 * resolved output (`docs/schema-grammar-and-desugaring.md`): *a reference carrying arguments
 * denotes an open form — a template application whose arguments materialisation later
 * substitutes; a reference carrying none is a bare name.* At this grammar-only layer every
 * `GenericRef` is necessarily non-empty — `type-args` requires at least one `type-arg` by
 * §12.1's grammar, encoded here as a non-empty tuple rather than a plain array, so "no
 * arguments" is exactly the shape that forces `SimpleRef` instead. The distinction that later
 * becomes "closed vs. open" is which of `SimpleRef`/`GenericRef` a use site holds *after*
 * desugaring has run, not before: desugaring rewrites a closed (parameter-free) application to
 * a `SimpleRef` naming its synthetic entry, and leaves an open (parameter-bearing) one as a
 * `GenericRef` whose arguments are exactly what materialisation substitutes. `args` is never
 * rewritten, reordered, or dropped by anything at this layer.
 */
export interface GenericRef {
  readonly kind: 'genericRef';
  readonly name: string;
  readonly args: readonly [TypeArg, ...TypeArg[]];
}

/**
 * `type-arg = type-ref / value-literal` (§12.1) — one argument inside a generic application's
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
  readonly ref: TypeRef;
}

/** A scalar-literal argument: `vector<pixel, 1920>`'s `1920`. */
export interface TypeArgValue {
  readonly kind: 'value';
  readonly value: TokenValue;
}

/**
 * `element-type = type-ref ["?"]` (§12.1, §5.3) — one position inside an {@link ArrayRef}, a
 * {@link TupleRef}, or a {@link MapRef}'s value.
 *
 * The optional `?` here is element/tuple-position optionality (a container-level fact),
 * distinct from a field's own `?` (§5.2) even though both reuse the same token: a field is
 * `field-name ":" type-ref ["?"]`, so in `xs: [T?]?` the inner `?` belongs to the element and
 * the outer to the field — they cannot collide.
 *
 * Holds a plain {@link TypeRef} and nothing else; nesting needs no case of its own, because a
 * bracket or map form *is* a type-ref — `[[T; 2]; 3]` is an {@link ArrayRef} whose
 * `elementType.typeRef` is itself an `ArrayRef`.
 */
export interface ElementType {
  readonly typeRef: TypeRef;
  /** `true` for a trailing `?` — the position may carry the absent sentinel `_` in data. */
  readonly optional: boolean;
}

/**
 * `"[" element-type [ws ";" ws size-spec] ws "]"` (§12.1, §5.3) — an array type, legal at
 * *every* type-ref position: a declaration's own body, a field type, an element, a type
 * argument, a choice variant. One production, not a separate declaration-level and inline
 * form — every position admits a size specifier and an element `?` alike.
 *
 * `size` absent means unconstrained. Nesting is the recursion in {@link ElementType}, which
 * holds a plain `TypeRef`: `[[T; 2]; 3]` is this node twice over, needing no second node
 * family. This is a syntactic node — desugaring lifts it to a closed or open synthetic
 * `!array { ... }` entry; nothing here pre-normalises it.
 */
export interface ArrayRef {
  readonly kind: 'arrayRef';
  readonly elementType: ElementType;
  readonly size?: SizeSpec;
}

/**
 * `"{" ws map-key ws "=>" ws element-type [ws ";" ws size-spec] ws "}"` (§12.1, §5.3) — a map
 * type, legal at every type-ref position, mirroring the data notation's own `{k => v}` the way
 * {@link ArrayRef} mirrors `[a b]`. Syntactic, like every sugar form — desugars to
 * `!map { key_type: ... value_type: ... }` at resolution, not here.
 *
 * The key is a `type-name`, optionally with type arguments (`map-key = type-name
 * ["<" type-args ">"]`) — never a paren, bracket, or map form: keeping it to a simple or
 * generic reference is what holds the record/map brace dispatch (§12.2) to its stated
 * lookahead budget, and a composite key type earns a named declaration and the explicit
 * `!map { key_type: ... }` form instead. That narrower grammar fact is not encoded in the type
 * of `keyType` (every `TypeRef` variant satisfies the field); a parser building this type is
 * responsible for never constructing it with an `ArrayRef`, `MapRef`, `TupleRef`, or
 * `ChoiceRef` key.
 *
 * The value is an {@link ElementType}: `{K => V?}` marks the value OPTIONAL exactly as `[T?]`
 * marks an array element (§5.3), under which an entry's value may be the absent sentinel and the
 * entry still counts toward the size bounds. The key side carries no such suffix — an absent key
 * is a resolver error ([TSON-DATA] §2.9), and `map-key` has no `?` to write (§12.1).
 */
export interface MapRef {
  readonly kind: 'mapRef';
  readonly keyType: TypeRef;
  readonly valueType: ElementType;
  readonly size?: SizeSpec;
}

/**
 * `"[" element-type 1*(separator element-type) "]"` (§12.1, §5.3) — a tuple type: two or more
 * positions, legal at every type-ref position, each carrying its own `?` for `OPTIONAL`
 * position state. Syntactic — desugars to `!tuple { elements: [...] }` at resolution.
 *
 * Distinguished from {@link ArrayRef} by arity alone — one element (with or without a size) is
 * an array, two or more a tuple — which is why the minimum arity is encoded structurally here
 * as a non-empty (2+) tuple type rather than checked at runtime.
 */
export interface TupleRef {
  readonly kind: 'tupleRef';
  readonly elementTypes: readonly [ElementType, ElementType, ...ElementType[]];
}

/**
 * `paren-type = "(" type-ref "|" type-ref *("|" type-ref) ")"` (§12.1, §5.4) — a choice type,
 * at least two variants. Desugars to `!choice { variants: [...] }` at resolution (§5.4); this
 * layer only records the variants as written, encoding the 2+ arity as a non-empty tuple type.
 */
export interface ChoiceRef {
  readonly kind: 'choiceRef';
  readonly variants: readonly [TypeRef, TypeRef, ...TypeRef[]];
}
