/**
 * The kernel's structural (PRODUCT) constructors' resolved vocabularies — `record`, `array`,
 * `map`, `tuple`, `enum` — plus `choice` (SUM-kind) and the held body of an open template
 * (§4.2, §5.2–§5.4, §5.10, §8.1).
 */
import type { Annotations, Token, TypeRef } from './typedef.js';

/**
 * The meta-kernel's `field_role` enum (§5.2, §8.1) — what a written value at a field may be:
 * `FREE` (any value of the declared type), `DEFAULT` (the value omission injects, overridable by
 * a written one), or `FIXED` (the one value a written token MUST equal). `FREE` is the default,
 * omitted from canonical resolver-output text ("fields at their default values are omitted").
 *
 * One of {@link RecordField}'s three independent questions (§5.2) — see that type's own doc for
 * how `role` combines with `optional` and `voidable`, and {@link fieldOmission} for what omission
 * then yields.
 */
export type FieldRole = 'FREE' | 'DEFAULT' | 'FIXED';

/**
 * The meta-kernel's `element_state` enum (§5.3, §8.1) — shared by array elements, tuple
 * positions, and field groups: an element slot cannot be omitted, so it has only the voidable
 * question to answer, where a {@link RecordField} has three (§5.2). `REQUIRED` is the default,
 * omitted from output.
 */
export type ElementState = 'REQUIRED' | 'OPTIONAL';

/**
 * The meta-kernel's `record_field` record (§5.2, §8.1) — a field answers three independent
 * questions, one fact each, plus the value a non-`FREE` role carries:
 *
 * 1. **May the key be omitted?** `optional` — the name's own `?`. `false` (unmarked) says the
 *    key MUST be written; `true` says it MAY be omitted.
 * 2. **May a written value be `_`?** `voidable` — the type's own `?`. `true` admits the absent
 *    sentinel at this position, exactly as it does at any other voidable position.
 * 3. **What may a written value be?** `role` — `FREE` (any value of the declared type),
 *    `DEFAULT` (`~`, overridable), or `FIXED` (`=`, a written value MUST equal it).
 *
 * `optional`/`voidable` default to `false` and `role` to `FREE`; all three always appear on this
 * host shape (no notion of "omit when at default" applies to the TypeScript type itself — that is
 * a resolved-output *writer*'s concern) and none is optional here for exactly that reason.
 *
 * **`value` is one slot, and carries a parameter as readily as a literal.** Inside a template
 * body a token there is a parameter exactly when its text resolves against the enclosing entry's
 * declared type parameters; a closed entry has no parameters for one to resolve into, so the same
 * slot is unambiguous at both ends and needs no separate label (§8.1's shadowing rule). `value` is
 * present exactly when `role` is not `FREE` (§8.1's own invariant over this shape).
 *
 * **What omission yields is derived, never stored** — see {@link fieldOmission}, the one function
 * every consumer of this shape calls to answer it, rather than re-deriving the three-way branch
 * by hand. A fresh field-group member always flattens to `optional: true, role: FREE` (§5.11), but
 * a *restated* member may carry `role: 'FIXED'` with a value that is checked when written and
 * never injected (§5.11: "the one pin that does not inject") — this shape alone cannot tell the
 * two apart, which is why {@link fieldOmission} takes an explicit `isGroupMember` flag from a
 * caller that knows the enclosing `RecordBody.groups` rather than guessing it from `role` alone.
 *
 * `annotations` is always an array, never optional — absent-equals-empty, the same
 * convention {@link TypeDefinition} states for its own fields; a builder with none to carry
 * MUST supply `[]`.
 */
export interface RecordField {
  readonly name: string;
  readonly type: TypeRef;
  readonly optional: boolean;
  readonly voidable: boolean;
  readonly role: FieldRole;
  readonly value?: Token;
  readonly annotations: Annotations;
}

/**
 * What omission yields at one field (§5.2): `'MISSING'` — the key MUST be written, and its
 * absence is a validation error (`optional: false`, whatever `role` says: a pin on an unmarked
 * name is a marker the document states itself, never injected, so it is `MISSING` exactly like a
 * plain required field); `'ABSENT'` — the key may be omitted and omission yields nothing
 * (`optional: true, role: 'FREE'`, or any field-group member whatever its own `role` says);
 * `'INJECTED'` — the key may be omitted and omission yields `field.value` (`optional: true`,
 * `role` `'DEFAULT'` or `'FIXED'`, and not a group member).
 *
 * The **one** derivation every consumer of {@link RecordField} calls — the tree reader deciding
 * what a field left out of the data yields, `schema/metaReader.ts` deciding whether a governing
 * meta's own field injects, `link/typeInhabitance.ts` deciding whether a field terminates
 * recursion, `compiler/definitionResolver.ts` ranking a refinement's omission axis — rather than
 * each re-deriving the three-way branch over `optional`/`role` by hand.
 */
export type FieldOmission = 'MISSING' | 'ABSENT' | 'INJECTED';

/**
 * See {@link FieldOmission}. `isGroupMember` answers §5.11's own carve-out: a field-group member
 * "the group governs and never supplies" whatever its own `role` says, because a restated member
 * may carry `role: 'FIXED'` (checked against a written value, §5.7) without ever being injected —
 * presence is what selects the group's alternative, and an injected member would always be
 * present. A caller iterating a whole {@link RecordBody} decides this from `body.groups`; every
 * other caller leaves it at its default of `false`.
 */
export function fieldOmission(
  field: Pick<RecordField, 'optional' | 'role'>,
  isGroupMember = false,
): FieldOmission {
  if (isGroupMember) return 'ABSENT';
  if (!field.optional) return 'MISSING';
  return field.role === 'FREE' ? 'ABSENT' : 'INJECTED';
}

/** Whether `fieldName` names a member of one of `groups` -- what a caller iterating a whole {@link RecordBody} passes as {@link fieldOmission}'s own `isGroupMember` flag. */
export function isGroupMember(groups: readonly FieldGroup[], fieldName: string): boolean {
  return groups.some((g) => g.members.includes(fieldName));
}

/**
 * The meta-kernel's `field_group` record (§5.11, §8.1): a resolved field group. `state`
 * defaults to {@link ElementState.REQUIRED} — a bare group requires exactly one member
 * present; `?` makes it {@link ElementState.OPTIONAL} (at most one MAY be present). These
 * are the only two group states, matching the kernel's own `state: element_state ~
 * REQUIRED` field type exactly (not {@link RecordField}'s three independent facts).
 */
export interface FieldGroup {
  readonly members: readonly string[];
  readonly state: ElementState;
}

/**
 * How a record may be realised (§5.2, §8.1) — the meta-kernel's `record_extension_type`, written
 * at a declaration as the word between `=>` and the type definition (`pet => abstract { ... }`,
 * `leaf => final { ... }`), never inherited. `OPEN` (the default, omitted from output): the record
 * has direct instances and any schema in the closure may compose onto or refine it. `ABSTRACT`: no
 * direct instances — a position typed by it admits exactly its subtypes, and the tag is REQUIRED
 * there in every encoding unless the record names {@link RecordBody.discriminators}. `FINAL`:
 * direct instances and no subtype — composition or refinement naming it as a source is a resolver
 * error; subtraction stays admissible, since it never joins the IS-A set FINAL constrains.
 */
export type RecordExtensionType = 'ABSTRACT' | 'FINAL' | 'OPEN';

/**
 * The kernel's `record` constructor's own vocabulary, resolved (§5.2, §8.1) —
 * `access_pattern`/`size_type` are fixed by the constructor (`NAMED`/`FIXED`) and never
 * appear in output, so this shape carries neither.
 *
 * **`supertypes` and `groups` are conceptually OPTIONAL** (`[type_ref]?`, `[field_group]?`)
 * but modelled as bare, always-present arrays: **absent and empty are the same list** here,
 * the convention {@link TypeDefinition}'s own note states in full — a resolver MUST supply
 * `[]` for either field rather than leaving it unset. `fields` is REQUIRED and carries no
 * such normalisation question: an absent `fields` is a violation a reader reports and
 * abandons the construction over, never a value that reaches this shape as `[]`.
 *
 * **`supertypes` holds `type_ref`, not a bare name** (§5.8, §8.1): a parent may still be an open
 * application inside a held template body (`<T> result<T> & { ... }`), and a name cannot carry
 * the arguments that say which instantiation is meant. A closed supertype carries no arguments and
 * is written as a bare token, the same spelling a name had; the *derived* index,
 * {@link TypeDefinition.supertypes}, stays plain names, since it is computed only once every
 * parent is an actual type.
 *
 * **`extension` and `discriminators` are the two record-only facts §5.2's definition marks and
 * `=?` selector lower into.** `extension` defaults to `OPEN` (see {@link RecordExtensionType});
 * `discriminators` names the fields (in declaration order) this record's members are selected by
 * — empty when the family, if any, is tag-dispatched rather than member-dispatched — and a
 * non-empty list implies `extension: 'ABSTRACT'` (a record its members are selected from has no
 * values of its own). Both are absent-equals-empty/default the same way `supertypes`/`groups` are.
 *
 * Named `RecordBody`, not `Record` — the kernel's own constructor is literally called
 * `record`, but `Record` is a built-in TypeScript utility type and importing that name here
 * would shadow it for the whole module.
 */
export interface RecordBody {
  readonly kind: 'record';
  readonly supertypes: readonly TypeRef[];
  readonly fields: readonly RecordField[];
  readonly groups: readonly FieldGroup[];
  readonly extension: RecordExtensionType;
  readonly discriminators: readonly string[];
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
 * array elements, not {@link RecordField}'s three independent facts.
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
 * Which lexical profile an enum's members lie in (§5.4, §7.4, §8.1) — the meta-kernel's
 * `enum_profile`. `IDENTIFIER` (the default) constrains every member to §7.7's identifier
 * grammar and carries the name-hygiene rules that follow from it (§8.2, §11.4); `TEXT` admits any
 * text as a member and carries none of them — the enum is string-class under `TEXT` whatever its
 * members' spellings. `IDENTIFIER` narrows `TEXT`, the one direction a refinement may move it
 * (§5.7's settable-once facets).
 */
export type EnumProfile = 'IDENTIFIER' | 'TEXT';

/**
 * The kernel's `enum` constructor's own vocabulary, resolved (§4.1, §8.1): `members: enum_set`
 * — `!set_type { element_type: text }` (inheriting `set_type`'s own `min_items: 1`
 * default) — backs `boolean` (`[true false]`), the kernel's own internal enumerations
 * (`product_access_type`, `field_role`, `scope_kind`, ...), and every user-declared
 * `!enum [...]` instance. Kept as an ordered array, matching how {@link
 * TypeDefinition.supertypes}/{@link TypeDefinition.subtypes} already represent conceptual
 * sets — member order is preserved for deterministic output, not semantically significant.
 *
 * `profile` defaults to `'IDENTIFIER'` (see {@link EnumProfile}) and is always present on this
 * host shape for the same reason `RecordField`'s own three facts are.
 *
 * **Two constraints this type does not itself enforce**, both `enum_set`'s own vocabulary
 * (§4.2, §9): at least one member (`min_items: 1` — an empty `!enum []` is a schema-load
 * error), and, where `profile` is `'IDENTIFIER'`, every member individually well-formed against
 * §7.7's identifier grammar (`!enum [1 2 3]` is a schema-load error under `IDENTIFIER`; under
 * `TEXT` a member is any text and this grammar does not apply). Enforcing either is a
 * resolver/compiler concern, not this value model's.
 */
export interface EnumBody {
  readonly kind: 'enum';
  readonly members: readonly string[];
  readonly profile: EnumProfile;
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

  /**
   * Present, and always `'ABSTRACT'`, exactly when a **record-bodied** template is a family base
   * nameable at a type position (§5.10): absent means the template is no type at all, and the
   * fact is optional with **no default** so a consumer never has to tell "omitted at its default"
   * from "not a type" by parsing the held text — the same reasoning `RecordBody.extension`'s
   * default does NOT apply here.
   */
  readonly extension?: RecordExtensionType;

  /**
   * Present and non-empty exactly where a record-bodied template base's members are selected by
   * reading these fields rather than by tag — whatever selectors survive erasure of the
   * template's own parameters, in the order their pins are compared as a tuple (§5.10). Optional
   * with no default, mirroring {@link extension}: absence says nothing was derived, not "empty at
   * its default".
   */
  readonly discriminators?: readonly string[];
}
