/**
 * The kernel's structural (PRODUCT) constructors' resolved vocabularies — `record`, `array`,
 * `map`, `tuple`, `choice`, `enum` — plus the held body of an open template (§4.2, §5.2–§5.4,
 * §5.10, §8.1).
 */
import type { Annotations, Token, TypeRef } from './typedef.js';

/**
 * The meta-kernel's `field_state` enum (§5.2, §8.1) — five members, used only by
 * {@link RecordField}. `REQUIRED` is the default, omitted from canonical resolver-output
 * text ("fields at their default values are omitted").
 */
export type FieldState =
  'REQUIRED' | 'REQUIRED_DEFAULT' | 'REQUIRED_FIXED' | 'OPTIONAL' | 'OPTIONAL_FIXED';

/**
 * The meta-kernel's `element_state` enum (§5.3, §8.1) — the two-member counterpart to
 * {@link FieldState}, shared by array elements, tuple positions, and field groups ("tuples
 * and arrays share the two-member `element_state` enumeration; records use the five-member
 * `field_state`"). `REQUIRED` is the default, omitted from output.
 */
export type ElementState = 'REQUIRED' | 'OPTIONAL';

/**
 * The meta-kernel's `record_field` record (§5.2, §8.1): `name`/`type` are REQUIRED; `state`
 * always appears in resolver output even at its nominal {@link FieldState.REQUIRED} default,
 * since this is a plain data field with no notion of "omit when at default".
 *
 * **`value` is one slot, and carries a parameter as readily as a literal.** Inside a
 * template body a token there is a parameter exactly when its text resolves against the
 * enclosing {@link TypeDefinition.parameters} list; a closed entry has no parameters for one
 * to resolve into, so the same slot is unambiguous at both ends and needs no separate label
 * (§8.1's shadowing rule). §5.7's fixation — a parametric `= P` sits at `REQUIRED` until its
 * value is concrete, then becomes `REQUIRED_FIXED` — is what this single channel costs, and
 * where it is paid.
 *
 * `annotations` is always an array, never optional — absent-equals-empty, the same
 * convention {@link TypeDefinition} states for its own fields; a builder with none to carry
 * MUST supply `[]`.
 */
export interface RecordField {
  readonly name: string;
  readonly type: TypeRef;
  readonly state: FieldState;
  readonly value?: Token;
  readonly annotations: Annotations;
}

/**
 * The meta-kernel's `field_group` record (§5.11, §8.1): a resolved field group. `state`
 * defaults to {@link ElementState.REQUIRED} — a bare group requires exactly one member
 * present; `?` makes it {@link ElementState.OPTIONAL} (at most one MAY be present). These
 * are the only two group states, matching the kernel's own `state: element_state ~
 * REQUIRED` field type exactly (not {@link FieldState}'s five members).
 */
export interface FieldGroup {
  readonly members: readonly string[];
  readonly state: ElementState;
}

/**
 * The kernel's `record` constructor's own vocabulary, resolved (§5.2, §8.1) —
 * `access_pattern`/`size_type` are fixed by the constructor (`NAMED`/`FIXED`) and never
 * appear in output, so this shape carries neither.
 *
 * **`supertypes` and `groups` are conceptually OPTIONAL** (`[type_name]?`, `[field_group]?`)
 * but modelled as bare, always-present arrays: **absent and empty are the same list** here,
 * the convention {@link TypeDefinition}'s own note states in full — a resolver MUST supply
 * `[]` for either field rather than leaving it unset. `fields` is REQUIRED and carries no
 * such normalisation question: an absent `fields` is a violation a reader reports and
 * abandons the construction over, never a value that reaches this shape as `[]`.
 *
 * Named `RecordBody`, not `Record` — the kernel's own constructor is literally called
 * `record`, but `Record` is a built-in TypeScript utility type and importing that name here
 * would shadow it for the whole module.
 */
export interface RecordBody {
  readonly kind: 'record';
  readonly supertypes: readonly string[];
  readonly fields: readonly RecordField[];
  readonly groups: readonly FieldGroup[];
}

/**
 * The kernel's `array` constructor's own vocabulary, resolved (§4.2, §5.3, §8.1) —
 * `access_pattern`/`size_type` are fixed (`INDEX`/`VARIABLE`) and never appear in output.
 * Also backs `set`, whose own refinement resolves to this same shape with different field
 * values (`state: REQUIRED`, `unordered: true`, `uniqueItems: true`).
 *
 * `minItems`/`maxItems` are `bigint` because the kernel's own `min_items`/`max_items` are
 * typed `integer`, the kernel's arbitrary-precision integer — no built-in bound ever
 * exceeds a small count in practice, but the field type itself is unbounded.
 */
export interface ArrayBody {
  readonly kind: 'array';
  readonly elementType: TypeRef;
  readonly state: ElementState;
  readonly unordered: boolean;
  readonly uniqueItems: boolean;
  readonly minItems?: bigint;
  readonly maxItems?: bigint;
}

/**
 * The kernel's `map` constructor's own vocabulary, resolved (§4.2, §8.1) —
 * `access_pattern`/`size_type` are fixed (`NAMED`/`VARIABLE`) and never appear in output.
 * Also backs the kernel's own `schema` type (`map<type_name, type_definition>`).
 *
 * **`state` governs the *value* side only** — the key side admits no `?` and is always
 * present ([TSON-SCHEMA] §5.3, §7.6). `state` defaults to {@link ElementState.REQUIRED}
 * (every key present names a present value); the `{K => V?}` sugar produces
 * {@link ElementState.OPTIONAL}, and only then may a map entry's value be absent on the
 * wire — the entry itself, keyed by `K`, is unconditional either way.
 */
export interface MapBody {
  readonly kind: 'map';
  readonly keyType: TypeRef;
  readonly valueType: TypeRef;
  readonly state: ElementState;
  readonly minItems?: bigint;
  readonly maxItems?: bigint;
}

/**
 * The meta-kernel's `tuple_element` record (§5.3, §8.1): one position of a resolved
 * {@link TupleBody}. `state` shares the two-member {@link ElementState} enumeration with
 * array elements, not {@link FieldState}'s five members.
 */
export interface TupleElement {
  readonly elementType: TypeRef;
  readonly state: ElementState;
}

/**
 * The kernel's `tuple` constructor's own vocabulary, resolved (§4.2, §5.3, §8.1) —
 * `access_pattern`/`size_type` are fixed (`INDEX`/`FIXED`) and never appear in output.
 * `elements`' positional order is significant (§5.3: a tuple's positions are fixed-arity and
 * ordered), unlike the supertype-style lists elsewhere in this package.
 */
export interface TupleBody {
  readonly kind: 'tuple';
  readonly elements: readonly TupleElement[];
}

/**
 * The kernel's `choice` constructor's own vocabulary, resolved (§4.1, §5.4, §8.1): a
 * SUM-kind body backing every declared choice type (`contact_method => (email | phone |
 * address)` and similar). `variants` is ordered as written; {@link
 * TypeDefinition.disjoint} — not a field here — carries the resolver-derived
 * discrimination-class distinctness fact for the enclosing definition.
 */
export interface ChoiceBody {
  readonly kind: 'choice';
  readonly variants: readonly TypeRef[];
}

/**
 * The kernel's `enum` constructor's own vocabulary, resolved (§4.1, §8.1): `members: enum_set`
 * — `!set { element_type: identifier  min_items: 1 }` — backs `boolean` (`[true false]`), the
 * kernel's own internal enumerations (`product_access_type`, `field_state`, `type_kind`, ...),
 * and every user-declared `!enum [...]` instance. Kept as an ordered array, matching how {@link
 * TypeDefinition.supertypes}/{@link TypeDefinition.subtypes} already represent conceptual
 * sets — member order is preserved for deterministic output, not semantically significant.
 *
 * **Two constraints this type does not itself enforce**, both `enum_set`'s own vocabulary
 * (§4.2, §9): at least one member (`min_items: 1` — an empty `!enum []` is a schema-load
 * error), and every member individually well-formed against §7.7's identifier grammar (an
 * `!enum` member is no longer any whitespace-free lexeme — `!enum [1 2 3]` is now an error).
 * Enforcing either is a resolver/compiler concern, not this value model's.
 */
export interface EnumBody {
  readonly kind: 'enum';
  readonly members: readonly string[];
}

/**
 * The body of a template — an entry declaring type parameters, which §5.10 calls open —
 * held in the form it was written rather than resolved into constructor vocabulary.
 * **Holds in both directions**: a {@link TypeDefinition.body} that is one of these means the
 * entry declares {@link TypeDefinition.parameters}, and every entry that declares parameters
 * has one.
 *
 * **Declared here but implemented elsewhere.** The held form is the compiler's own schema
 * AST — exactly one class implements this interface, and it lives outside `schema/meta`
 * (in the layer that depends on this package, never the reverse, mirroring
 * {@link SourcePosition}'s relationship to `core/position.ts`'s `Position`). This package
 * only declares the seat.
 *
 * **It never serialises and carries no `kind` tag.** An open entry's resolved form is its
 * declaration round-tripped, not a `type_definition` value the kernel could hold in any
 * case (`body: top` is REQUIRED with no `top` variant an open body could be) — so no
 * implementation of this shape carries a constructor name, nothing binds through it, and a
 * resolved-output consumer never meets one (§1.3). This is why {@link Top}'s own note calls
 * this member out as the one requiring a `'kind' in body` check before narrowing.
 *
 * The two methods answer the only two questions a *held*, unresolved body can answer
 * without being resolved:
 */
export interface TemplateBody {
  /**
   * Every unquoted name this body mentions, at any depth — the one question §5.10 asks at
   * link time: a declared parameter the body never references is an author error. Includes
   * every token substitution would rewrite; a quoted token in a value slot is a literal and
   * never a name.
   */
  names(): ReadonlySet<string>;

  /**
   * Every type application this body writes, at any depth — the question §5.10.1 asks at
   * the declaration: a recursive application that does not pass its parameters through
   * unchanged grows its argument at every level, so no finite set of types closes it. Each
   * element is the {@link TypeRef} an application spells, nesting included (an application
   * inside another's argument list is itself a member of this list).
   */
  applications(): readonly TypeRef[];
}
