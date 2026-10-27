/**
 * The resolved-schema value model's root (Part 2 §4, §8.1): what a schema map's entries are
 * values of, the IS-A chain a type carries, and the type-system vocabulary every body is built
 * from -- references, applications, kinds, namespace values and cross-schema scoping.
 *
 * **An entry is its value** (§8.1). A resolved schema is a map from name to {@link Top}: a type
 * body (every atom, product and sum), a {@link Reference}, a held {@link TemplateBody}, or a
 * {@link Namespace} value. What the value's own shape cannot carry -- where the declaration sat,
 * the annotations written after `=>`, the constructor its tag names -- is the entry's
 * {@link EntryFacts}, kept beside the map rather than in it, since none of it is a field of any
 * constructor and none of it is written.
 *
 * This module, like every other module in `schema/meta`, depends on nothing but itself, sibling
 * modules in this same directory, and `core/` -- never a compiler type. Two shapes here are local
 * stand-ins for that reason: {@link Token} mirrors `ast.TokenValue`, and {@link SourcePosition}
 * (declared in `./position.js`) is structurally satisfied by `core/position.ts`'s `Position` with
 * no conversion. {@link Annotation}/{@link Annotations} are a third, minimal stand-in: the real
 * wire-annotation carrier (`src/annotations`) also exposes lookup methods, but only the data
 * shape those methods read is needed here.
 */
import type { SourcePosition } from './position.js';
import type { EnumBody, RecordBody, TemplateBody, TemplateParam } from './bodies.js';
import type { Product, Sum, ValueType, VoidType } from './algebra.js';
import type {
  IntegerType,
  FloatType,
  DecimalType,
  RationalType,
  ComplexType,
} from './atoms-numeric.js';
import type {
  TextType,
  IdentifierType,
  UriType,
  IriType,
  RegexType,
  EmailType,
  UuidType,
} from './atoms-text.js';
import type { BytesType } from './atoms-bytes.js';
import type {
  DateType,
  TimeType,
  DateTimeType,
  DurationType,
  PeriodType,
} from './atoms-temporal.js';
import type {
  Cidr4Type,
  Cidr6Type,
  HostType,
  HostnameType,
  Ipv4Type,
  Ipv6Type,
  MacType,
  MediaTypeType,
} from './atoms-network.js';

/**
 * One TSON wire-format annotation (`@name` or `@name:value`) attached to a resolved value
 * (§6, §8.1). `value` is `unknown` because its TypeScript shape depends on how the carrying
 * document was read -- bound against a governing type when one resolves, kept as a raw
 * structural fragment otherwise -- and this package, which never binds anything, cannot name
 * either. The resolver-attached `@application` carries a {@link TypeRef}.
 *
 * A local, data-only stand-in for `src/annotations`' own `Annotation`: the real carrier
 * additionally exposes lookup methods (`get`, `value`, `has`, ...), but `schema/meta`
 * depends on nothing but itself and `core/`, so only the shape those methods read travels
 * here. An absent `value` is the valueless form `@name`, distinct from a `value` holding the
 * void sentinel `_`.
 */
export interface Annotation {
  readonly name: string;
  readonly value?: unknown;
}

/**
 * Every annotation attached to one resolved value, in source order -- §3.1 permits a name to
 * repeat, so this is a list rather than a map. Always an array, never absent, where a host
 * shape declares the field: absent and empty are the same list throughout this package.
 */
export type Annotations = readonly Annotation[];

/**
 * How a raw token's text was written (§7.1, §9.4): unquoted, or quoted on one or several
 * lines. Mirrors `ast.TokenValue`'s own `TokenForm` enumeration one-for-one.
 */
export type TokenForm = 'UNQUOTED' | 'SINGLE_LINE_QUOTED' | 'MULTI_LINE_QUOTED';

/**
 * A raw, unresolved scalar literal -- a field's default/fixed value (§5.2), or a
 * type-argument's literal (§5.10: "a bare token... never annotated, never typed, never a
 * container").
 *
 * A local stand-in for `ast.TokenValue`, declared here rather than imported because
 * `schema/meta` depends on nothing but itself and `core/`. A caller on the compiler side
 * converts its own `TokenValue` into this shape field-by-field; there is deliberately no
 * shared supertype or conversion function here, since either would reintroduce the very
 * dependency this type exists to avoid.
 */
export interface Token {
  readonly text: string;
  readonly form: TokenForm;
}

/**
 * The kind of a resolved entry (§4.1, §8.1) -- its value's kind, derived by {@link entryKind}
 * and never written. The three base kinds; REFERENCE for an alias; NAMESPACE for a namespace
 * type (a constructor IS-A the kernel's `namespace`, whose instances are maps) and for an entry
 * whose value is one of those instances, which is no type; and TEMPLATE for a held template
 * (§5.10's open entry over any constructor but `record`), which is no type either. A record
 * template is a type, the family base, and takes a record's kind.
 */
export type EntryKind = 'ATOM' | 'PRODUCT' | 'SUM' | 'REFERENCE' | 'NAMESPACE' | 'TEMPLATE';

/**
 * A resolved reference to a named entry (§8.1): the kernel's `type_ref`, the application form.
 * `name` is the only field the kernel requires, so an argument-free reference is written as the
 * bare token everywhere the positional-form rule applies (§5.6), never as `!type_ref { name: ... }`.
 *
 * **One host shape for every slot that names something.** The kernel types a slot that names the
 * type of a value by `type_kind`, which holds one bare name (`record_field.type`,
 * `array.element_type`, `choice.variants`, ...), and stands `type_ref` only where an application
 * may (`type_chain.parents`, `type_argument.name`, the `@application` annotation,
 * `reference.target`). This model carries both as a `TypeRef`, as the reference implementation
 * does: the judgement is the slot's and never the host's, a closed `type_kind` value is a
 * `TypeRef` with no arguments -- written as the same bare name -- and a record template's field
 * may name an application still open over the template's own parameters (`v: box<T>`), which a
 * bare name could not carry.
 *
 * **`arguments` non-empty means "an application"**, and appears only where an application is
 * still open (inside a record template, a held template's text, an alias's target) or where one
 * is recorded (`type_chain.parents`, `@application`). Absent and empty are the same list, so a
 * resolver normalises an unstated value to `[]`.
 *
 * `annotations` carries the wire annotations written on the reference **itself**, not the
 * enclosing field's. A reference is a hop, never a rewrite (§8.3), so no resolver-attached
 * provenance ever lands here. Excluded from a reference's identity, which is where it points.
 */
export interface TypeRef {
  readonly name: string;
  readonly arguments: readonly TypeArgument[];
  readonly annotations: Annotations;
}

/**
 * One positional argument of a resolved {@link TypeRef} (§8.1, §9): the kernel's own field
 * group `{ (name: type_ref | value: value) }`, exactly one of which is ever present (§5.11).
 * A discriminated union, `kind` being this package's own tag -- the kernel tells the two members
 * apart by which field is present.
 */
export type TypeArgument = TypeArgumentRef | TypeArgumentValue;

/** A reference argument -- the kernel's own `{ name: type_ref }` member. */
export interface TypeArgumentRef {
  readonly kind: 'ref';
  readonly ref: TypeRef;
}

/** A literal argument -- the kernel's own `{ value: value }` member. */
export interface TypeArgumentValue {
  readonly kind: 'value';
  readonly value: Token;
}

/**
 * The meta-kernel's `type_chain` (§4.1): where a type sits in the IS-A order, carried by every
 * type body as `type`'s one field, `chain`.
 *
 * - **`parents`** is what was written: a record template's parents, one of which may be an
 *   application (`<T> result<T> & { ... }`). It is the only list that ever holds an
 *   application, and a closed type that is no template carries none.
 * - **`supertypes`** is the closed chain: every entry this one IS-A, complete to a fixed point
 *   through applied parents (§5.8), each a bare name, sorted; empty for a fresh record, an
 *   instance and a subtracted record alike.
 * - **`subtypes`** is the inverse, over the entries of one schema map only (§3.3.4), computed by
 *   the linker.
 *
 * A declaration never writes the chain: the resolver computes it and the linker inverts it.
 * Absent and empty are one chain, and one list -- see {@link withChain}, which is how every body
 * is given one, and which leaves a chain with nothing in it off the body altogether.
 */
export interface TypeChain {
  readonly parents: readonly TypeRef[];
  readonly supertypes: readonly string[];
  readonly subtypes: readonly string[];
}

/** The chain of a value no declaration placed: a fresh record, an instance. */
export const EMPTY_CHAIN: TypeChain = { parents: [], supertypes: [], subtypes: [] };

/**
 * The meta-kernel's `type => abstract top & { chain?: type_chain }` (§4.1): the one field every
 * type body carries, mirroring the constructor's flattened shape, where `type`'s field comes
 * first. Optional, absent meaning {@link EMPTY_CHAIN}.
 */
export interface TypeBase {
  readonly chain?: TypeChain;
}

/** Whether `chain` states nothing: no parents, no supertypes, no subtypes. */
export function isEmptyChain(chain: TypeChain | undefined): boolean {
  return (
    chain === undefined ||
    (chain.parents.length === 0 && chain.supertypes.length === 0 && chain.subtypes.length === 0)
  );
}

/**
 * A chain in its one canonical spelling: `supertypes` sorted and without repeats, so one chain has
 * one spelling whichever order a resolver reached it in, and `subtypes` the same.
 */
export function typeChain(
  supertypes: readonly string[] = [],
  parents: readonly TypeRef[] = [],
  subtypes: readonly string[] = [],
): TypeChain {
  return {
    parents,
    supertypes: [...new Set(supertypes)].sort(),
    subtypes: [...new Set(subtypes)].sort(),
  };
}

/** `value`'s chain, {@link EMPTY_CHAIN} for a value that carries none. */
export function chainOf(value: Top | undefined): TypeChain {
  return value !== undefined && isType(value) ? (value.chain ?? EMPTY_CHAIN) : EMPTY_CHAIN;
}

/** `value`'s closed supertypes, empty for a value that carries no chain. */
export function supertypesOf(value: Top | undefined): readonly string[] {
  return chainOf(value).supertypes;
}

/** `value`'s subtypes within its schema map, empty for a value that carries no chain. */
export function subtypesOf(value: Top | undefined): readonly string[] {
  return chainOf(value).subtypes;
}

/** `value`'s written parents, empty for a value that carries no chain. */
export function parentsOf(value: Top | undefined): readonly TypeRef[] {
  return chainOf(value).parents;
}

/**
 * `value` with `chain` in place of its own. A value that carries no chain (a reference, a held
 * template, a namespace value) is returned as it is, and an empty chain leaves the body with no
 * `chain` at all -- absent and empty are one chain, so two bodies differing only there compare
 * equal structurally.
 */
export function withChain<T extends Top>(value: T, chain: TypeChain): T {
  if (!isType(value)) return value;
  const { chain: _previous, ...rest } = value as T & TypeBase;
  void _previous;
  return (isEmptyChain(chain) ? rest : { ...rest, chain }) as T;
}

/** `value` with its chain emptied: what two values are, rather than where each sits. */
export function withoutChain<T extends Top>(value: T): T {
  return withChain(value, EMPTY_CHAIN);
}

/**
 * The meta-kernel's `reference` constructor's own vocabulary, resolved (§4.1, §8.1): an alias,
 * `!reference { target: E }` -- `type_name`/`field_name`/`param_name` (aliasing `identifier`),
 * the annotation markers, and a declaration naming another entry. Composes `top` directly, so it
 * carries no chain: a hop has no IS-A of its own.
 *
 * `target` is a {@link TypeRef} judged by resolution alone, and may name a constructor, since an
 * alias of a constructor is applied as its target is (§3.3.1). **A reference is a hop, never a
 * rewrite** (§8.3): a use site naming this entry names this entry, and no walk collapses
 * `target` into whatever it in turn names before writing it out.
 */
export interface Reference {
  readonly kind: 'reference';
  readonly target: TypeRef;
}

/**
 * Which namespace a value's type may be drawn from (§7.8) -- meta.tn's `scope_kind` enum, the
 * element type of {@link Scoped.scope}.
 */
export type ScopeKind = 'LOCAL' | 'EXTERN';

/**
 * meta.tn's `scoped` constructor's own vocabulary, resolved (§7.8): the open sum, in which the
 * value names its own type and the instance names the namespaces that name may be resolved in.
 * Core's `declared`, `extern` and `dynamic` are all instances of it, distinguished only by
 * `scope`.
 *
 * `schemas` narrows the foreign namespace, when `scope` holds `EXTERN`: absent admits any
 * foreign schema; present, it maps each admitted schema's canonical URI to the type names
 * admitted from it, an empty list meaning every type that schema declares. Keys compare by
 * canonical identity (§2.2.1).
 */
export interface Scoped extends TypeBase {
  readonly kind: 'scoped';
  readonly scope: readonly ScopeKind[];
  readonly schemas?: ReadonlyMap<string, readonly string[]>;
}

/**
 * An instance of the meta-kernel's `kind_type` (§4.2): the atom whose values are the names of
 * the types built with the constructor {@link of}. `kind<uuid_type>` and `!kind_type { of:
 * uuid_type }` are one instance; a value at a position typed by it is a type name resolving to
 * one of its {@link members} -- the name, never a value of the type it names.
 *
 * `of` names a constructor of the writer's structure namespace, held as the name written.
 * **`members` is a derived index**, as {@link TypeChain.subtypes} is: absent on a declaration,
 * computed at link over the governing closure, sorted. Two kinds are one kind by `of` and the
 * chain, never by the index, since the index says what a closure holds rather than which kind
 * this is.
 */
export interface KindBody extends TypeBase {
  readonly kind: 'kind_type';
  readonly of: string;
  readonly members?: readonly string[];
}

/**
 * An instance of the meta-kernel's `ref_type` (§4.2, §5.12): the atom whose values are qualified
 * names naming a value whose type is {@link of} or IS-A it. `of` names a type of the writer's own
 * namespace, never a constructor -- a reference to a type is a kind ({@link KindBody}). Kernel
 * vocabulary only, declared in a kernel-governed schema.
 */
export interface RefBody extends TypeBase {
  readonly kind: 'ref_type';
  readonly of: string;
}

/**
 * A value read from a meta layer's own vocabulary, held generically (§4.1): this model binds
 * nothing to host classes, so the values of a namespace type a meta layer declares (an
 * `interface`'s `method`s, an `api`'s `binding`s) are carried as what they were written as. A
 * record value names the constructor its tag or its position fixes and holds its fields by wire
 * name; a name at a kind- or reference-typed slot is kept as the {@link Token} written, which is
 * what a qualified name's field step reads and what resolved output writes back.
 */
export type MetaValue =
  | { readonly form: 'token'; readonly token: Token }
  | { readonly form: 'void' }
  | { readonly form: 'list'; readonly elements: readonly MetaValue[] }
  | {
      readonly form: 'map';
      readonly entries: readonly (readonly [MetaValue, MetaValue])[];
    }
  | MetaRecordValue
  | { readonly form: 'namespace'; readonly value: Namespace<MetaValue> };

/** A record value of a meta layer's vocabulary: its constructor, where known, and its fields by wire name. */
export interface MetaRecordValue {
  readonly form: 'record';
  readonly type?: string;
  readonly fields: ReadonlyMap<string, MetaValue>;
}

/**
 * A value of a namespace type (§4.1): an instance of a constructor IS-A the kernel's
 * `namespace`, written and read as the map its facets describe, never as a record of the facets.
 * The kernel declares two namespace types and every resolved schema holds values of both: the
 * schema map is a value of `schema`, and a record's fields are a value of `field_map`
 * ({@link RecordBody.fields}). A meta layer declares its own (`api => namespace & { key_type: =
 * identifier  value_type: = method }`), and an entry applying one (`myapi => !api { ... }`) is a
 * value of it -- a value, never a type.
 *
 * `type` names the namespace constructor, which fixes the family the keys are names of and the
 * type of the values; it is the tag resolved output writes where the value stands as a schema
 * entry. `entries` keeps the order the keys were written in; `keyAnnotations` holds the
 * annotations written at a key's own position, present only for a key that carries any.
 *
 * Equal namespaces are one constructor's values with the same keys, values and key annotations.
 * Whether order is part of the value is a facet of the constructor (`ordered`), so an owner whose
 * namespace is ordered compares it in order itself, as a record does its `field_map`.
 */
export interface Namespace<V> {
  readonly kind: 'namespace';
  readonly type: string;
  readonly entries: ReadonlyMap<string, V>;
  readonly keyAnnotations?: ReadonlyMap<string, Annotations>;
}

/** The kernel's two namespace types, and the `application` and `synthetic` key annotations (§8.1, §8.2). */
export const SCHEMA_NAMESPACE = 'schema';
export const FIELD_MAP = 'field_map';
export const APPLICATION_ANNOTATION = 'application';
export const SYNTHETIC_ANNOTATION = 'synthetic';

/** A value of `type` holding `entries`, in the order given, with `keyAnnotations` where any key carries some. */
export function namespaceOf<V>(
  type: string,
  entries: Iterable<readonly [string, V]>,
  keyAnnotations?: ReadonlyMap<string, Annotations>,
): Namespace<V> {
  const map = new Map<string, V>();
  for (const [key, value] of entries) map.set(key, value);
  return {
    kind: 'namespace',
    type,
    entries: map,
    ...(keyAnnotations === undefined || keyAnnotations.size === 0 ? {} : { keyAnnotations }),
  };
}

/**
 * The meta-kernel's `atom => abstract type & {}` base kind (§4.1) -- every ATOM-kind body.
 * {@link ValueType} and {@link VoidType} back `value` and `void`; {@link EnumBody} backs
 * `boolean` and the kernel's other enumerations; {@link KindBody} and {@link RefBody} are the
 * atoms whose values are names; every other member is an atom constraint-vocabulary family, one
 * per `*_type` constructor (§9).
 */
export type Atom =
  | ValueType
  | VoidType
  | EnumBody
  | KindBody
  | RefBody
  | IntegerType
  | TextType
  | IdentifierType
  | UriType
  | IriType
  | RegexType
  | DecimalType
  | FloatType
  | RationalType
  | UuidType
  | BytesType
  | DateType
  | TimeType
  | DateTimeType
  | DurationType
  | PeriodType
  | Cidr4Type
  | Cidr6Type
  | EmailType
  | MacType
  | Ipv4Type
  | Ipv6Type
  | HostnameType
  | HostType
  | MediaTypeType
  | ComplexType;

/**
 * The meta-kernel's `type => abstract top & { chain?: type_chain }` (§4.1): the bodies that
 * describe the shape of a data value. `atom`, `product` and `sum` compose it, and every body here
 * carries its {@link TypeChain}.
 */
export type Type = Atom | Product | Sum;

/**
 * The meta-kernel's structural root, `top => abstract {}` (§4.1), and what a schema map's entries
 * are values of: `schema => namespace & { key_type: = type_name  value_type: = top }`.
 *
 * Four kinds of value: a {@link Type} (every atom, product and sum body), a {@link Reference}, a
 * held {@link TemplateBody}, and a {@link Namespace} value of a meta layer's vocabulary. The
 * latter three carry no chain -- a hop, an abbreviation and a value have no IS-A.
 *
 * Every member but {@link TemplateBody} carries a `kind` literal (`record`, `array`,
 * `integer_type`, `reference`, `namespace`, ...), narrowable with an ordinary `switch`; the held
 * body has none, since the kernel's `template` declares no tag field, so code that must handle it
 * narrows with {@link isTemplateBody} first.
 */
export type Top = Type | Reference | TemplateBody | Namespace<MetaValue>;

/** Whether `value` is the held, unresolved body of an open entry (§5.10), the one {@link Top} member with no `kind`. */
export function isTemplateBody(value: Top): value is TemplateBody {
  return !('kind' in value) && 'template' in value && 'parameters' in value;
}

/** Whether `value` is a namespace value of a meta layer's vocabulary -- an entry that is a value, never a type. */
export function isNamespaceValue(value: Top): value is Namespace<MetaValue> {
  return 'kind' in value && value.kind === 'namespace';
}

/** Whether `value` describes a type -- IS-A `type`, so carries a chain (§4.1). */
export function isType(value: Top): value is Type {
  return 'kind' in value && value.kind !== 'reference' && value.kind !== 'namespace';
}

/**
 * Whether the entry `name`, whose value is `value`, IS-A the meta-kernel's `top` (§4.1, §4.2) --
 * what makes it a constructor: a base kind, a namespace type, `reference`, `template`, or anything
 * composing one. Read off the chain, so it is not a fact a document can be wrong about. `top`
 * answers for itself by name, being what every other answer IS-A.
 */
export function isConstructor(value: Top, name?: string): boolean {
  return supertypesOf(value).includes('top') || name === 'top';
}

/**
 * The parameters an entry whose value is `value` binds, in declaration order (§5.10) -- `[]` for
 * a closed entry. Two shapes carry an open entry: a record template ({@link RecordBody.parameters},
 * a family base and itself a type) and every other open entry's held {@link TemplateBody}.
 */
export function parametersOf(value: Top | undefined): readonly TemplateParam[] {
  if (value === undefined) return [];
  if (isTemplateBody(value)) return value.parameters;
  if (value.kind === 'record') return value.parameters ?? [];
  return [];
}

/** The parameter names `value` binds, in declaration order -- what an application's arity is checked against. */
export function typeParameters(value: Top | undefined): readonly string[] {
  return parametersOf(value).map((parameter) => parameter.name);
}

/** Whether an entry whose value is `value` declares parameters (§5.10). */
export function isOpen(value: Top | undefined): boolean {
  return parametersOf(value).length > 0;
}

/** A record template (§5.10): a record that declares parameters. */
export type FamilyBase = RecordBody & { readonly parameters: readonly TemplateParam[] };

/** Whether `value` is a family base: a record that declares parameters, ABSTRACT by construction (§5.10). */
export function isFamilyBase(value: Top | undefined): value is FamilyBase {
  return value !== undefined && !isTemplateBody(value) && value.kind === 'record' && isOpen(value);
}

/**
 * `value`'s own choice-disjointness fact (§5.4, §8.1) -- present exactly when `value` is a
 * {@link ChoiceBody}, absent for every other body shape.
 */
export function choiceDisjoint(value: Top): boolean | undefined {
  return !isTemplateBody(value) && value.kind === 'choice' ? value.disjoint : undefined;
}

/** The base kinds a record's chain is searched for, in the order the kernel declares them. */
const BASE_KIND_NAMES: readonly (readonly [string, EntryKind])[] = [
  ['atom', 'ATOM'],
  ['product', 'PRODUCT'],
  ['sum', 'SUM'],
  ['namespace', 'NAMESPACE'],
];

/**
 * `value`'s {@link EntryKind} (§4.1, §8.1), derived and never stored. A body is the branch of
 * {@link Top} it occupies -- an instance takes its constructor's kind by being built as one (§5.5's
 * transfer) -- except a record, whose kind is the base kind its chain reaches: `integer_type =>
 * atom & { ... }` is a record describing atoms, and the kind of a constructor is what its
 * instances are. The first of `atom`, `product`, `sum` and `namespace` in the chain wins (`top`
 * and `type` never count), and a record whose chain reaches none is a product.
 *
 * `kernel` says whether a chain's name denotes the meta-kernel's own entry of that name: a kind is
 * judged by where a base kind is defined, never by its spelling, so a schema's own `namespace =>
 * { ... }` composed into `payload => namespace & { ... }` leaves `payload` a PRODUCT. Omitted, every
 * name is taken as the kernel's.
 */
export function entryKind(value: Top, kernel: (name: string) => boolean = () => true): EntryKind {
  if (isTemplateBody(value)) return 'TEMPLATE';
  switch (value.kind) {
    case 'reference':
      return 'REFERENCE';
    case 'namespace':
      return 'NAMESPACE';
    case 'record': {
      const supertypes = supertypesOf(value);
      for (const [name, kind] of BASE_KIND_NAMES) {
        if (supertypes.includes(name) && kernel(name)) return kind;
      }
      return 'PRODUCT';
    }
    case 'array':
    case 'map':
    case 'tuple':
      return 'PRODUCT';
    case 'choice':
    case 'scoped':
      return 'SUM';
    default:
      return 'ATOM';
  }
}

/**
 * What an entry carries beyond its value (§8.1), none of it a field of any constructor and none of
 * it written: where the declaration sat, the annotations written after `=>` on the value (§6; the
 * ones written before the name are the key's), and `head`, the constructor the value's tag names
 * -- `!integer_type`, `!enum`, `!set_type` -- which a body's shape cannot always recover, since
 * `set_type` restates `array`'s fields and `enum` and `enum_type` share one shape. (`head` rather
 * than `constructor`, which every object already answers through its prototype.)
 */
export interface EntryFacts {
  readonly position?: SourcePosition;
  readonly annotations?: Annotations;
  readonly head?: string;
}

/** An entry with none of its facts recorded. */
export const NO_FACTS: EntryFacts = {};

/**
 * The constructor `value`'s shape is the body of, by its `kind` -- exact where one constructor has
 * that shape, and the base one where several share it (`array` for `array`/`set_type`, `enum_type`
 * for `enum`/`enum_type`), which is why an entry's {@link EntryFacts.head} is asked first. A
 * namespace value names its own constructor, and a held body is `template`'s.
 */
export function constructorOf(value: Top): string {
  if (isTemplateBody(value)) return 'template';
  if (value.kind === 'namespace') return value.type;
  if (value.kind === 'enum') return 'enum_type';
  return value.kind;
}

/** The `@application` an entry's key annotations record, if it closes one (§8.2). */
export function applicationOf(keyAnnotations: Annotations | undefined): TypeRef | undefined {
  const found = keyAnnotations?.find((annotation) => annotation.name === APPLICATION_ANNOTATION);
  return found?.value as TypeRef | undefined;
}

/** `keyAnnotations` with `application` recorded as the entry's `@application`, any earlier one replaced. */
export function withApplication(
  keyAnnotations: Annotations | undefined,
  application: TypeRef,
): Annotations {
  return [
    { name: APPLICATION_ANNOTATION, value: application },
    ...(keyAnnotations ?? []).filter((annotation) => annotation.name !== APPLICATION_ANNOTATION),
  ];
}
