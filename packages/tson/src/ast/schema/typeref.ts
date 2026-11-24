import type { DataValue } from '../value.js';
import type { SizeSpec } from './fields.js';
import type { RecordDef } from './typedef.js';

/**
 * `type-expr = paren-type / bracket-type / brace-type / type-ref` (Part 2 §12.1) -- a type expression at any
 * position one is legal: a declaration's own body, field types, type arguments, choice variants, elements. It is
 * a {@link TypeRef} or one of the structural forms ({@link ChoiceExpr}, {@link ArrayExpr}, {@link TupleExpr},
 * {@link MapExpr}, {@link RecordExpr}), each of which holds further expressions; desugaring adds
 * {@link InlineConstruction}, the construction a form denotes written in place, which no parser builds.
 *
 * One tier: every container form is legal at every type-expression position. Each is a **syntactic** node --
 * desugaring writes it in place as the construction it denotes (§5.3); nothing is lifted or named.
 *
 * Discriminated on `kind`.
 */
export type TypeExpr =
  TypeRef | ArrayExpr | MapExpr | TupleExpr | ChoiceExpr | RecordExpr | InlineConstruction;

/**
 * `field-type = type-expr ["?"] / dependent-type` (§12.1) -- what a record field's or a field group member's type
 * holds: a type expression, or `kind!`, a {@link DependentType}, which the grammar admits there and nowhere else
 * (§5.2).
 */
export type FieldTypeExpr = TypeExpr | DependentType;

/**
 * `dependent-type = unquoted-token "!"` (§12.1, §5.2) -- the field `on` of the same record instance, whose value
 * names the type: `kind!`. It stands only at a record field's or a group member's type, which the AST's types
 * hold: only {@link FieldTypeExpr} admits it.
 */
export interface DependentType {
  readonly kind: 'dependentType';
  readonly on: string;
}

/**
 * `qualified-name ["<" type-args ">"]` (§12.1) -- a reference to a type: a {@link NameRef} or an
 * {@link ApplicationRef}.
 */
export type TypeRef = NameRef | ApplicationRef;

/** `qualified-name` alone (§12.1) -- a bare reference with no type arguments, `geo.address` included. */
export interface NameRef {
  readonly kind: 'nameRef';
  readonly name: string;
}

/**
 * `qualified-name "<" type-args ">"` (§12.1, §5.3, §5.10) -- an application, `map<text, integer>` or
 * `pair<text uuid>`: sugar for the construction `meta.apply`. Whether `name` resolves to a constructor, an
 * incomplete entry or a parametric record is a later, semantic-layer question, not decided here.
 *
 * `type-arg = type-expr` (§12.1): an argument is a type, never a literal. The grammar admits a structural form
 * there and desugaring refuses one, an argument being a name or a parameter (§5.10). `type-args` requires at
 * least one argument, encoded as a non-empty tuple.
 */
export interface ApplicationRef {
  readonly kind: 'applicationRef';
  readonly name: string;
  readonly args: readonly [TypeExpr, ...TypeExpr[]];
}

/**
 * `record-def` at a type slot (§12.1's `brace-type = map-type / record-def`, §5.2): a record body written where
 * it is used, `at: { lat: float64  lon: float64 }`. Desugaring writes it as its `!meta.record` construction in
 * place.
 */
export interface RecordExpr {
  readonly kind: 'recordExpr';
  readonly body: RecordDef;
}

/**
 * A construction written in place at a type slot (§4.2, §5.3): the binding record a sugar form or an applied
 * constructor denotes, `!meta.array { element_type: text }`, tagged with its constructor (`value.typeRef`). No
 * parser builds one: desugaring writes it at a field's or group member's type, where resolution reads it through
 * its constructor and holds it as the field's type in place.
 */
export interface InlineConstruction {
  readonly kind: 'inlineConstruction';
  readonly value: DataValue;
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
 * family. This is a syntactic node — desugaring writes it as its `!meta.array { ... }`
 * construction where it stands; nothing here pre-normalises it.
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
 * The key is a {@link TypeRef} (`map-key = type-ref`, §12.1) and never a bracket, paren or brace form: keeping it
 * to a reference is what holds the record/map brace dispatch (§12.2) to its stated lookahead budget, and a
 * composite key type earns a named declaration instead.
 *
 * The value is an {@link ElementType}: `{K => V?}` marks the value voidable exactly as `[T?]`
 * marks an array element (§5.3), under which an entry's value may be the void sentinel and the
 * entry still counts toward the size bounds. The key side carries no such suffix — a void key
 * is a resolver error ([TSON-DATA] §2.9), and `map-key` has no `?` to write (§12.1).
 */
export interface MapExpr {
  readonly kind: 'mapExpr';
  readonly keyType: TypeRef;
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
