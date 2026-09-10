/**
 * The kernel's structural (PRODUCT) constructors' resolved vocabularies — `record`, `array`,
 * `map`, `tuple`, `enum` — plus `choice` (SUM-kind) and the held body of an open template
 * (§4.2, §5.2–§5.4, §5.10, §8.1).
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
 * enclosing entry's declared type parameters; a closed entry has no parameters for one
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
 * typed `non_negative_integer`, itself a refinement of the kernel's arbitrary-precision
 * `integer` — no built-in bound ever exceeds a small count in practice, but the field type
 * itself is unbounded.
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
 * address)` and similar). `variants` is ordered as written.
 *
 * `disjoint` is a resolver-derived index over `variants`, parallel to {@link
 * TypeDefinition.subtypes}: `true` or `false` by discrimination-class distinctness (§5.4).
 * Declarations never set it; on ingest it MUST be discarded and recomputed. It lives here
 * rather than on {@link TypeDefinition} because it is a fact about a variant list, and this is
 * the only body that has one — an entry with no variants has nowhere to put it, so "recorded on
 * every choice and absent on every other definition" is structural rather than a rule a
 * document could break (§8.1). Use {@link choiceDisjoint} to read it off a `TypeDefinition`
 * without narrowing `body` by hand.
 */
export interface ChoiceBody {
  readonly kind: 'choice';
  readonly variants: readonly TypeRef[];
  readonly disjoint?: boolean;
}

/**
 * The kernel's `enum` constructor's own vocabulary, resolved (§4.1, §8.1): `members: enum_set`
 * — `!set_type { element_type: identifier }` (inheriting `set_type`'s own `min_items: 1`
 * default) — backs `boolean` (`[true false]`), the kernel's own internal enumerations
 * (`product_access_type`, `field_state`, `scope_kind`, ...), and every user-declared
 * `!enum [...]` instance. Kept as an ordered array, matching how {@link
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
 * The kernel's `template` constructor's own vocabulary, resolved (§5.10, §8.1) — the body of an
 * entry that declares type parameters, which §5.10 calls open. **Holds in both directions**: a
 * {@link TypeDefinition.body} that is one of these means the entry declares type parameters
 * (read them with `typeParameters` in `./typedef.js`), and every entry that declares parameters
 * has one.
 *
 * **A real change of representation, not a rename.** `template` is the constructor application
 * as written, held as **text** and unread until materialisation substitutes the parameters
 * away — not a value of any constructor's own record shape, and cannot be one: a parameter
 * stands wherever a token stands (`min_items: N` in a value slot as readily as `element_type:
 * T` in a type slot), so a body carrying one is not typed by any constructor's vocabulary until
 * it closes. Writing it as though it already had a shape leaves the two halves disagreeing — a
 * value parameter refuses to read at all, and a type parameter reads as a reference to a type
 * nobody declared.
 *
 * **The text is authoritative; the parsed form is what compares.** Identity is derived from the
 * *parsed* application, never the text itself, so two spellings of one form reduce to one entry
 * and whitespace is free (§5.10, §8.2). Parsing that text — and answering the questions §5.10
 * asks of it (which names it mentions, which applications it writes, at any depth) — is a later
 * work package's concern (`compiler`'s own held-body cache), never this package's: `schema/meta`
 * holds the seat, not the parser, the same boundary {@link SourcePosition} draws against
 * `core/position.ts`'s `Position`.
 *
 * **It never serialises as a value of the vocabulary it will close into**, which is a different
 * claim from not serialising at all. An open entry is carried in resolver output as an ordinary
 * `type_definition` whose `body` is a `!template` instance (§8.1) — `spec/m/meta-resolved.tn`
 * writes `set` as `body: !template { parameters: [T]  template: "!set_type { element_type: T }" }`
 * — so `body: top` holds with no exception, and what a resolved-output consumer never meets is a
 * half-closed `!set_type` with a parameter standing in one of its slots.
 *
 * **It carries no `kind` tag of its own**, because the kernel's `template` declares only
 * `parameters` and `template` and the wire name rides on the value's own `!type-ref`. That makes
 * it the one member of {@link Top} a `kind` discriminant cannot reach, so code switching on `kind`
 * narrows with `isTemplateBody` (in `./typedef.js`) first, as {@link Top}'s own note says, and the
 * binding that writes it tests for the two fields rather than for a tag.
 */
export interface TemplateBody {
  /**
   * The parameter names this entry binds, in declaration order — the arity and order an
   * application binds against (§5.10, §8.1). Read this instead of a stored
   * `TypeDefinition.parameters` field, which the kernel no longer carries.
   */
  readonly parameters: readonly string[];

  /**
   * The constructor application as written, held and unread (§5.10). Comparison for identity
   * is over this text's *parsed* form, never the text itself, so whitespace is free — but the
   * parse is a later work package's job, not this package's.
   */
  readonly template: string;
}
