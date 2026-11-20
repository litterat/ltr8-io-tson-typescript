/**
 * The kernel's structural (PRODUCT) constructors' resolved vocabularies — `meta.record`, `meta.array`,
 * `meta.map`, `meta.namespace`, `meta.tuple` — plus the atoms `meta.enum_type` and `meta.ref` and the sum
 * `meta.choice` (§4.2, §5.2–§5.4, §5.10, §8.1).
 */
import type {
  Annotations,
  Namespace,
  Param,
  Token,
  TypeBase,
  TypeExpr,
  TypeRef,
} from './typedef.js';
import { namespaceOf } from './typedef.js';
import { FIELD_MAP, metaName } from './kernel.js';

/**
 * the kernel's `meta.field_role` enum (§5.2, §8.1) — what a written value at a field may be:
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
 * the kernel's `meta.record_field` record (§5.2, §8.1) -- a field answers three independent
 * questions, one fact each, plus the value a non-`FREE` role carries:
 *
 * 1. **May the key be omitted?** `optional` -- the name's own `?`.
 * 2. **May a written value be `_`?** `voidable` -- the type's own `?`.
 * 3. **What may a written value be?** `role` -- `FREE` (any value of the declared type),
 *    `DEFAULT` (`~`, overridable), or `FIXED` (`=`, a written value MUST equal it).
 *
 * **A field's name is not one of its facts.** It is the field's key in `record.fields`, the
 * kernel's `field_map` namespace ({@link RecordBody.fields}), so the name is said once, by the
 * position that declares it.
 *
 * `type` is typed `meta.type_expr` by the kernel: a type's name, judged a member of the types when the
 * schema links, or a type written in place -- among them `{ of: !meta.dependent { on: kind } }`, `kind!`
 * in source, which makes the field a dependent field whose type each instance's `kind` chooses (§5.2).
 * Inside a parametric record a name may be one of its parameters (§5.10), and a field typed by one takes
 * no value.
 *
 * **`value` is a literal read against the field's own type** (typed `type!` by the kernel). A
 * schema document holds a dependent field's value as written. `value` is present exactly when `role`
 * is not `FREE`.
 *
 * **What omission yields is derived, never stored** -- see {@link fieldOmission}.
 *
 * `annotations` is always an array, never optional -- absent-equals-empty; a builder with none to
 * carry supplies `[]`.
 */
export interface RecordField {
  readonly type: TypeExpr;
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
  return groups.some((g) => g.members.some((option) => option.includes(fieldName)));
}

/**
 * the kernel's `meta.field_group` record (§5.11, §8.1): a resolved field group. `members` holds the
 * group's options in source order, each the fields it holds, and every option is non-empty.
 * `optionalMembers` names the members that may be left out once their option is chosen (absent
 * when none is, never empty). An option is chosen when any of its members is present, and a chosen
 * option holds every member `optionalMembers` does not name. Without `optional` exactly one option
 * is chosen; with it, at most one, so the group as a whole may be left out, as an optional field's
 * key may.
 *
 * The at-least-one group (`( a: A | b: B )+`) resolves to one option holding every member, each
 * marked optional, on a group that is not optional — see {@link atLeastOne}.
 */
export interface FieldGroup {
  readonly members: readonly (readonly string[])[];
  readonly optionalMembers?: readonly string[];
  readonly optional: boolean;
}

/** Every member of every option of `group`, in source order. */
export function groupMemberNames(group: FieldGroup): readonly string[] {
  return group.members.flat();
}

/**
 * Whether `group` is the at-least-one group (§5.11): one option the group may not leave out, which
 * the grammar writes only as `+` over its members.
 */
export function atLeastOne(group: FieldGroup): boolean {
  return group.members.length === 1 && !group.optional;
}

/**
 * One way the members present in a record fail a {@link FieldGroup} (§5.11): `'MEMBER_MISSING'` —
 * a chosen option lacks a member `optionalMembers` does not name (`option` indexes
 * {@link FieldGroup.members}, `missing` lists the members); `'SEVERAL_CHOSEN'` — more than one
 * option is chosen (`options` lists them by index); `'NONE_CHOSEN'` — no option is chosen and the
 * group is not optional.
 */
export type GroupViolation =
  | { readonly kind: 'NONE_CHOSEN' }
  | { readonly kind: 'SEVERAL_CHOSEN'; readonly options: readonly number[] }
  | {
      readonly kind: 'MEMBER_MISSING';
      readonly option: number;
      readonly missing: readonly string[];
    };

/**
 * Judges the members of a record that are present against one {@link FieldGroup} (§5.11, §7.6),
 * in the order §5.11's validation states: it finds the chosen options, reports each chosen
 * option's missing members, and then counts. An option is chosen when any of its members is
 * present; a group that is not optional errs with no option chosen or with two or more, an
 * optional group only with two or more; a chosen option must hold every member `optionalMembers`
 * does not name. `isPresent` answers for a member name; a member written as the void sentinel is
 * present. An empty result is a group satisfied.
 */
export function groupViolations(
  group: FieldGroup,
  isPresent: (member: string) => boolean,
): readonly GroupViolation[] {
  const chosen: number[] = [];
  group.members.forEach((option, index) => {
    if (option.some(isPresent)) chosen.push(index);
  });
  const optionalMembers = group.optionalMembers ?? [];
  const violations: GroupViolation[] = [];
  for (const index of chosen) {
    const missing = (group.members[index] ?? []).filter(
      (member) => !optionalMembers.includes(member) && !isPresent(member),
    );
    if (missing.length > 0) violations.push({ kind: 'MEMBER_MISSING', option: index, missing });
  }
  if (chosen.length > 1) violations.push({ kind: 'SEVERAL_CHOSEN', options: chosen });
  else if (chosen.length === 0 && !group.optional) violations.push({ kind: 'NONE_CHOSEN' });
  return violations;
}

/**
 * One refusal a record's group judgement yields (§5.11, §7.6), in the shape both encodings'
 * readers report: the code is always `FIELD_GROUP`, the one code for everything a group decides, so
 * a consumer repairs a group as one thing rather than as separate field and type problems.
 */
export interface GroupRefusal {
  readonly code: 'FIELD_GROUP';
  readonly message: string;
  readonly expected: string;
  readonly found: string;
}

/**
 * Every refusal `group` yields over the members `isPresent` reports (§5.11), in the group's own
 * terms and in {@link groupViolations}' order: each chosen option's missing members first, one
 * refusal per member, and then the count of chosen options — exactly one, at most one under `?`,
 * at least one for the `+` form. `typeName` names the record in the message. Both encodings' readers
 * report through this one function, so a document draws the same refusals from either.
 */
export function groupRefusals(
  group: FieldGroup,
  isPresent: (member: string) => boolean,
  typeName: string,
): readonly GroupRefusal[] {
  const refusals: GroupRefusal[] = [];
  const options = describeGroup(group);
  for (const violation of groupViolations(group, isPresent)) {
    switch (violation.kind) {
      case 'MEMBER_MISSING': {
        const option = group.members[violation.option] ?? [];
        const chosenBy = option.find(isPresent) ?? '';
        for (const missing of violation.missing) {
          refusals.push({
            code: 'FIELD_GROUP',
            message: `'${chosenBy}' chose (${option.join(' ')}) on '${typeName}', which needs '${missing}'`,
            expected: `'${missing}' beside '${chosenBy}'`,
            found: 'missing',
          });
        }
        break;
      }
      case 'SEVERAL_CHOSEN': {
        const chosen = violation.options.length;
        refusals.push({
          code: 'FIELD_GROUP',
          message: group.optional
            ? `at most one option of (${options}) may be chosen for '${typeName}', found ${String(chosen)}`
            : `exactly one option of (${options}) must be chosen for '${typeName}', found ${String(chosen)}`,
          expected: `${group.optional ? 'at most' : 'exactly'} one option of (${options})`,
          found: `${String(chosen)} chosen`,
        });
        break;
      }
      case 'NONE_CHOSEN':
        refusals.push(
          atLeastOne(group)
            ? {
                code: 'FIELD_GROUP',
                message: `at least one of (${options}) must be present for '${typeName}'`,
                expected: `at least one of (${options})`,
                found: 'none present',
              }
            : {
                code: 'FIELD_GROUP',
                message: `exactly one option of (${options}) must be chosen for '${typeName}', found none`,
                expected: `exactly one option of (${options})`,
                found: 'none chosen',
              },
        );
        break;
    }
  }
  return refusals;
}

/**
 * A group's options as its spelling reads inside the parentheses, for a message (§5.11): options
 * separated by `|`, a member marked `?` where it is optional within its option, and the
 * at-least-one group as its members.
 */
export function describeGroup(group: FieldGroup): string {
  if (atLeastOne(group)) return (group.members[0] ?? []).join(' | ');
  const optionalMembers = group.optionalMembers ?? [];
  return group.members
    .map((option) =>
      option.map((member) => (optionalMembers.includes(member) ? `${member}?` : member)).join(' '),
    )
    .join(' | ');
}

/**
 * A group as it is written (§5.11): {@link describeGroup} parenthesised, followed by the group's
 * own `?`, or by the `+` of the at-least-one group -- so a message quotes the spelling the author
 * would have to change.
 */
export function spellGroup(group: FieldGroup): string {
  const suffix = atLeastOne(group) ? '+' : group.optional ? '?' : '';
  return `(${describeGroup(group)})${suffix}`;
}

/**
 * How a record may be realised (§5.2, §8.1) — the kernel's `meta.record_extension_type`, written
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
 * The kernel's `record` constructor's own vocabulary, resolved (§5.2, §8.1) --
 * `access_pattern`/`size_type` are fixed by the constructor (`NAMED`/`FIXED`) and never appear in
 * output, so this shape carries neither.
 *
 * **`fields` is the kernel's `field_map`**: a namespace value mapping each field's name to its
 * facts, in declaration order, which is part of the value. A name is written once, as its key.
 * The keys are values of the record's {@link nameType} -- `meta.identifier` where neither the record
 * nor a supertype states one (§5.2).
 *
 * **`groups` is conceptually OPTIONAL** but modelled as a bare, always-present array: absent and
 * empty are the same list.
 *
 * **`extension` and `discriminators` are the two record-only facts §5.2's definition marks and
 * `=?` selector lower into.** `extension` defaults to `OPEN` (see {@link RecordExtensionType});
 * `discriminators` names the fields (in declaration order) this record's members are selected by,
 * absent when the family, if any, is tag-dispatched; each is judged by the record's name type.
 *
 * **`parameters`, where present, make the record a parametric record** (§5.10): no type a position
 * names, applied by `H<args>`. A parameter stands at a field's type, at a slot of a type written in place
 * there, or as an argument of an application at either or in a parent, as a reference marked `param`;
 * its chain keeps the parents as written in {@link TypeChain.parents}. The record's own `extension` and
 * `discriminators` are each application's.
 *
 * Named `RecordBody`, not `Record` -- `Record` is a built-in TypeScript utility type and importing
 * that name here would shadow it for the whole module.
 */
export interface RecordBody extends TypeBase {
  readonly kind: 'record';
  readonly fields: Namespace<RecordField>;
  readonly groups: readonly FieldGroup[];
  readonly extension: RecordExtensionType;
  readonly discriminators?: readonly string[];
  readonly nameType?: string;
  readonly parameters?: readonly Param[];
}

/**
 * What a record states at the record level (§5.2, §5.10, §5.11): the name type its field names are values
 * of, those names in declaration order, the fields its members are selected by, the field groups, and how
 * it may be realised.
 */
export interface RecordHead {
  readonly nameType?: string;
  readonly fieldNames: readonly string[];
  readonly discriminators: readonly string[];
  readonly groups: readonly FieldGroup[];
  readonly extension: RecordExtensionType;
}

/** The head of a record, and `undefined` for any other value. */
export function recordHead(value: { readonly kind?: string } | undefined): RecordHead | undefined {
  if (value?.kind !== 'record') return undefined;
  const body = value as RecordBody;
  return {
    ...(body.nameType === undefined ? {} : { nameType: body.nameType }),
    fieldNames: [...body.fields.entries.keys()],
    discriminators: body.discriminators ?? [],
    groups: body.groups,
    extension: body.extension,
  };
}

/**
 * A record field's type as a name: the type's name, or for a type written in place its source spelling,
 * which names no entry (§4.2). What a consumer that looks a field's type up by name asks, so a type in place
 * falls out as a lookup that finds nothing rather than a failure.
 */
export function typeNameOf(field: { readonly type: TypeExpr }): string {
  return typeExprText(field.type);
}

/** A record field's type as the type it names, or `undefined` for a type written in place (§4.2). */
export function namedTypeOf(field: { readonly type: TypeExpr }): TypeRef | undefined {
  return field.type.kind === 'inline' ? undefined : field.type;
}

/** A `field_map` value holding `fields`, in the order given (§5.2, §8.1). */
export function fieldMap(
  fields: Iterable<readonly [string, RecordField]>,
  keyAnnotations?: ReadonlyMap<string, Annotations>,
): Namespace<RecordField> {
  return namespaceOf(FIELD_MAP, fields, keyAnnotations);
}

/**
 * A field seen with its name beside its facts -- a view for code that walks a record's fields in
 * order, never stored: the name is the field's key in {@link RecordBody.fields}.
 */
export interface NamedField extends RecordField {
  readonly name: string;
}

/** `body`'s fields, in declaration order, each with its name. */
export function namedFields(body: Pick<RecordBody, 'fields'>): readonly NamedField[] {
  return [...body.fields.entries].map(([name, field]) => ({ ...field, name }));
}

/** The field named `name` in `body`, with its name, or `undefined`. */
export function namedField(body: Pick<RecordBody, 'fields'>, name: string): NamedField | undefined {
  const field = body.fields.entries.get(name);
  return field === undefined ? undefined : { ...field, name };
}

/** `field` without its name -- the facts a `field_map` holds under it. */
export function unnamed(field: NamedField): RecordField {
  const { name: _name, ...facts } = field;
  void _name;
  return facts;
}

/** A `field_map` of `fields`, each keyed by its name, in the order given. */
export function fieldMapOf(
  fields: Iterable<NamedField>,
  keyAnnotations?: ReadonlyMap<string, Annotations>,
): Namespace<RecordField> {
  return fieldMap(
    [...fields].map((field) => [field.name, unnamed(field)] as const),
    keyAnnotations,
  );
}

/** The empty `field_map`. */
export const NO_FIELDS: Namespace<RecordField> = fieldMap([]);

/** `fields` with each field mapped through `map`, keys, order and key annotations unchanged. */
export function mapFields(
  fields: Namespace<RecordField>,
  map: (field: RecordField, name: string) => RecordField,
): Namespace<RecordField> {
  return fieldMap(
    [...fields.entries].map(([name, field]) => [name, map(field, name)] as const),
    fields.keyAnnotations,
  );
}

/**
 * The kernel's `array` constructor's own vocabulary, resolved (§4.2, §5.3, §8.1) —
 * `access_pattern`/`size_type` are fixed (`INDEX`/`VARIABLE`) and never appear in output.
 * Also backs `set`, whose own refinement resolves to this same shape with different field
 * values (`voidable: false`, `ordered: false`, `uniqueItems: true`).
 *
 * `voidable` says whether an element may be void (the sentinel `_` stands in it), spelled `[T?]`;
 * `ordered` says whether two values differing only in element order are distinct values, and
 * defaults to `true`. `ordered` never changes what a document may write (§7.5).
 *
 * `minItems`/`maxItems` are `bigint` because the kernel's own `min_items`/`max_items` are
 * typed `non_negative_integer`, itself a refinement of the kernel's arbitrary-precision
 * `integer` — no built-in bound ever exceeds a small count in practice, but the field type
 * itself is unbounded.
 */
export interface ArrayBody extends TypeBase {
  readonly kind: 'array';
  readonly elementType: TypeExpr;
  readonly voidable: boolean;
  readonly ordered: boolean;
  readonly uniqueItems: boolean;
  readonly minItems?: bigint;
  readonly maxItems?: bigint;
}

/**
 * The kernel's `map` constructor's own vocabulary, resolved (§4.2, §8.1) —
 * `access_pattern`/`size_type` are fixed (`NAMED`/`VARIABLE`) and never appear in output.
 *
 * **`voidable` governs the *value* side only** — the key side admits no `?` and is never void
 * ([TSON-SCHEMA] §5.3, §7.6). It defaults to `false` (every key present names a non-void value);
 * the `{K => V?}` sugar produces `true`, and only then may a map entry's value be void on the
 * wire — the entry itself, keyed by `K`, is unconditional either way. `ordered` says whether two
 * maps holding the same entries in a different order are distinct values, and defaults to
 * `false`; output keeps the order written either way (§7.5).
 */
export interface MapBody extends TypeBase {
  readonly kind: 'map';
  readonly keyType: TypeRef;
  readonly valueType: TypeExpr;
  readonly voidable: boolean;
  readonly ordered: boolean;
  readonly minItems?: bigint;
  readonly maxItems?: bigint;
}

/**
 * the kernel's `meta.tuple_element` record (§5.3, §8.1): one position of a resolved
 * {@link TupleBody}. `voidable` says whether the position may hold the void sentinel `_`, spelled
 * `(T?, U)`; a tuple position is never missing.
 */
export interface TupleElement {
  readonly elementType: TypeExpr;
  readonly voidable: boolean;
}

/**
 * The kernel's `tuple` constructor's own vocabulary, resolved (§4.2, §5.3, §8.1) —
 * `access_pattern`/`size_type` are fixed (`INDEX`/`FIXED`) and never appear in output.
 * `elements`' positional order is significant (§5.3: a tuple's positions are fixed-arity and
 * ordered), unlike the supertype-style lists elsewhere in this package.
 */
export interface TupleBody extends TypeBase {
  readonly kind: 'tuple';
  readonly elements: readonly TupleElement[];
}

/**
 * The kernel's `choice` constructor's own vocabulary, resolved (§4.1, §5.4, §8.1): a SUM-kind
 * body backing every declared choice type (`contact_method => (email | phone | address)` and
 * similar). `variants` is ordered as written, each typed `meta.type_expr`.
 *
 * `disjoint` is a resolver-derived index over `variants`: `true` or `false` by
 * discrimination-class distinctness (§5.4). Declarations never set it; on ingest it is discarded
 * and recomputed. It lives here because it is a fact about a variant list, and this is the only
 * body that has one. Read it off any value with {@link choiceDisjoint}.
 */
export interface ChoiceBody extends TypeBase {
  readonly kind: 'choice';
  readonly variants: readonly TypeExpr[];
  readonly disjoint?: boolean;
}

/**
 * The kernel's `enum_type` constructor's own vocabulary, resolved (§4.1, §7.4, §8.1): a closed
 * set of names and the identifier family they are drawn from. `nameType` is typed
 * `meta.identifier_ref` -- an identifier family -- and each member is a value of it, distinct from the
 * others under its equality. `enum` pins it to `identifier`; an author may write `!enum_type {
 * name_type: kebab  members: [...] }` for a vocabulary of the schema's own. `nameType` is fixed
 * where an enum is constructed: a refinement narrows `members` and never `nameType`. A closed set
 * of text that is no name is `text_type`'s `members` facet, not an enum.
 *
 * `members` is the kernel's `enum_set` -- `!set_type { element_type: text  min_items: 1 }`: kept
 * as an ordered array; member order is preserved for deterministic output, not semantically
 * significant. Members are held as text whatever `nameType` is.
 *
 * **Two constraints this type does not itself enforce**: at least one member (`min_items: 1`),
 * and that every member is a value of `nameType` -- the linker's.
 */
export interface EnumBody extends TypeBase {
  readonly kind: 'enum';
  /** The identifier family the members are names of; `identifier` for `!enum`. */
  readonly nameType: string;
  readonly members: readonly string[];
}

/** The kernel's `meta.type_ref`, the reference over the types (§4.2). */
export const TYPE_KIND = metaName('type_ref');

/**
 * The kernel's `meta.namespace` constructor's own vocabulary, resolved (§4.1, §5.7, §8.1): a map type
 * keyed by names. `meta.namespace` is a refinement of `meta.map`, IS-A it, whose `key_type` narrows to
 * `meta.identifier_ref` and whose `voidable` is pinned false. A namespace type is an instance, as a map type
 * is one of `map` -- the kernel's `meta.schema`, and a schema's own `api => !meta.namespace { key_type:
 * meta.identifier  value_type: method }` -- and a value of it is the map its facets describe, a
 * {@link Namespace}. `access_pattern` and `size_type` are fixed (`NAMED`/`VARIABLE`), `voidable` is fixed
 * false, and none of them appears in output.
 *
 * `keyType` names the family every key is read and judged under, an identifier family, and is always
 * stated. `ordered` and the `min_items`/`max_items` bounds are map's, and mean what a map's do: whether
 * key order is part of a value (output keeps the order written either way, §7.5) and how many entries a
 * value holds.
 */
export interface NamespaceBody extends TypeBase {
  readonly kind: 'namespace';
  readonly keyType: TypeRef;
  readonly valueType: TypeExpr;
  readonly ordered: boolean;
  readonly minItems?: bigint;
  readonly maxItems?: bigint;
}

/**
 * What the linker derives for one reference (§4.2, §5.12): whether `of` names a constructor, so the
 * values admitted are types, and the members where it does -- the names of the closure the slot admits,
 * sorted -- with each alias entry of the closure to the entry at the end of its chain, and the closure's
 * entries, which a reference read here names. `shown` is the members as a message names them.
 *
 * Derived and never written: no document states an index, so it is no part of what a reference is.
 * Absent where linking has not run.
 */
export interface ReferenceIndex {
  readonly namesTypes: boolean;
  readonly members: readonly string[];
  /** Each alias entry of the closure, to the entry at the end of its chain. */
  readonly aliases: ReadonlyMap<string, string>;
  /** The closure's entries, as the link that derived this index finally assembled them. */
  readonly entries: EntryAccess;
  readonly shown: readonly string[];
  /**
   * For a reference that names values: what a qualified name reaches in the closure of the schema that
   * linked it (§4.2, §5.12) -- the same walk a value body's names take, so a name a data document writes
   * is judged by the rule a schema's own is. Absent for a reference that names types and where linking has
   * produced nothing to reach.
   */
  readonly values?: ReferenceValues;
}

/** The closure's entries as a link left them: a lookup, since the link assembles them after the reference it indexes. */
export interface EntryAccess {
  get(name: string): unknown;
  has(name: string): boolean;
}

/**
 * What a name read under a reference that names values reaches (§4.2, §5.12): the value the name reaches.
 *
 * @throws TsonSchemaValidationError where the name reaches no value of the reference's `of`, its message
 *   saying which step failed and opening with `where`.
 */
export type ReferenceValues = (where: string, name: string) => unknown;

/**
 * The kernel's `meta.ref => meta.atom & { of: meta.type_ref }` constructor's own vocabulary, resolved (§4.2,
 * §5.12, §8.1): the one atom whose values are names, each naming an entry whose value's type, past the
 * entry's alias hops (§8.3), is `of` or IS-A it. Where `of` is a constructor the names are types', and
 * otherwise values'. `meta.ref<T>` is its construction sugar.
 *
 * `index` is the linker's derived {@link ReferenceIndex}, excluded from identity.
 */
export interface RefBody extends TypeBase {
  readonly kind: 'ref';
  readonly of: TypeRef;
  readonly index?: ReferenceIndex;
}

/**
 * The source spelling of a type expression, for a message: a name as written; a type in place as an author
 * writes it -- `[text]`, `{text => money}`, `[a, b]`, `(a | b)`, `set<text>`, `kind!`, an application as
 * `head<args>`, a record by the application it closes or its fields, and any other construction as its
 * constructor's application over its type slots.
 */
export function typeExprText(expr: TypeExpr): string {
  if (expr.kind !== 'inline') return expr.name;
  const of = expr.of;
  const head = expr.head;
  switch (of.kind) {
    case 'record':
      if (expr.application !== undefined) return applicationText(expr.application);
      return recordText(of);
    case 'dependent':
      return `${of.on}!`;
    case 'apply':
      return applicationText(of);
    case 'array':
      if (head === metaName('array') && isSetShape(of))
        return `set<${typeExprText(of.elementType)}>`;
      if (head === metaName('array')) {
        return `[${typeExprText(of.elementType)}${of.voidable ? '?' : ''}${sizeText(of.minItems, of.maxItems)}]`;
      }
      return `${head}<${typeExprText(of.elementType)}>`;
    case 'map':
      if (head === metaName('map')) {
        return `{${of.keyType.name} => ${typeExprText(of.valueType)}${of.voidable ? '?' : ''}${sizeText(of.minItems, of.maxItems)}}`;
      }
      return `${head}<${of.keyType.name}, ${typeExprText(of.valueType)}>`;
    case 'tuple': {
      const elements = of.elements.map(
        (element) => `${typeExprText(element.elementType)}${element.voidable ? '?' : ''}`,
      );
      return head === metaName('tuple')
        ? `[${elements.join(', ')}]`
        : `${head}<${elements.join(', ')}>`;
    }
    case 'choice': {
      const variants = of.variants.map(typeExprText);
      return head === metaName('choice')
        ? `(${variants.join(' | ')})`
        : `${head}<${variants.join(', ')}>`;
    }
    case 'ref':
      return `${head}<${of.of.name}>`;
    default:
      return `!${head} { ... }`;
  }
}

function applicationText(apply: {
  readonly head: TypeRef;
  readonly arguments: readonly TypeRef[];
}): string {
  return `${apply.head.name}<${apply.arguments.map((argument) => argument.name).join(' ')}>`;
}

function recordText(record: RecordBody): string {
  const written = [...record.fields.entries].map(
    ([name, field]) =>
      `${name}${field.optional ? '?' : ''}: ${typeExprText(field.type)}${field.voidable ? '?' : ''}`,
  );
  return written.length === 0 ? '{}' : `{ ${written.join('  ')} }`;
}

/** Whether `array` is what `set<T>` completes to, which the bracket form cannot spell. */
function isSetShape(array: ArrayBody): boolean {
  return (
    !array.ordered &&
    array.uniqueItems &&
    !array.voidable &&
    array.minItems === undefined &&
    array.maxItems === undefined
  );
}

function sizeText(min: bigint | undefined, max: bigint | undefined): string {
  if (min === undefined && max === undefined) return '';
  if (min !== undefined && min === max) return `; ${String(min)}`;
  return `; ${min === undefined ? '' : String(min)}..${max === undefined ? '' : String(max)}`;
}
