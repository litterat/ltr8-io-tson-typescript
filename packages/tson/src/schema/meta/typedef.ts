/**
 * The resolved-schema value model's root (Part 2 §4, §8.1): what a schema map's entries are values
 * of, the IS-A chain a type carries, and the type-system vocabulary every body is built from --
 * references, applications, kinds, value entries and nested schema maps.
 *
 * **An entry is its value** (§8.1). A resolved schema is one map from qualified name to {@link Top}:
 * a type body (every atom, product and sum), an {@link Alias}, a held {@link TemplateBody}, or a
 * {@link ValueEntry}, an instance of an ordinary type (`orders => !api { ... }`) or a schema map
 * nested as an entry (`geo => !schema { ... }`). What the value's own shape cannot carry -- where the
 * declaration sat, the annotations written after `=>`, the constructor its tag names -- is the
 * entry's {@link EntryFacts}, kept beside the map rather than in it, since none of it is a field of
 * any constructor and none of it is written.
 *
 * An entry is a type exactly when its value is built by a constructor IS-A `meta.type` (§4.1); any
 * other entry is a value, marked by nothing but its tag. A type's `kind` literal here is its
 * constructor's member name (`record`, `integer_type`, `reference_type`); {@link constructorOf} maps
 * it to the path the kernel declares it under.
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
import type {
  EnumBody,
  RecordTemplateBody,
  ReferenceBody,
  TemplateBody,
  TemplateParam,
} from './bodies.js';
import type { Product, Sum, VoidType } from './algebra.js';
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
import {
  APPLICATION_ANNOTATION,
  FIELD_MAP,
  SCHEMA,
  SYNTHETIC_ANNOTATION,
  kernelName,
  metaName,
} from './kernel.js';

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
 * The kind of a resolved entry (§4.1, §8.1) -- its value's kind, derived by {@link entryKind} and never
 * written. The three base kinds `atom`, `product` and `sum` under `type`; ALIAS for an `alias` (§8.3);
 * VALUE for an entry whose value is an instance of an ordinary type, or a schema map nested as an entry,
 * which is no type; and TEMPLATE for a held template (§5.10's open entry over any constructor but
 * `record`), which is no type either. A record template is a type, the family base, and takes a
 * record's kind.
 */
export type EntryKind = 'ATOM' | 'PRODUCT' | 'SUM' | 'ALIAS' | 'VALUE' | 'TEMPLATE';

/**
 * A reference to a type as the kernel's `meta.type_ref` holds it (§4.2, §8.1): a qualified `name` and,
 * where an application is still open, its `arguments`. A reference without arguments is a name and
 * written as one bare token (`geo.address`); one with arguments is an application, `result<T>`, written
 * unquoted in its canonical text (`pair<text integer>`: no whitespace, one space between arguments).
 * Identity is the parsed form and never the spelling, so `result< T >` and `result<T>` are one reference.
 *
 * **One host shape for every slot that names a type.** `meta.record_field.type`, an array's
 * `element_type`, a choice's `variants`, an alias's `target`, a chain's `parents` and the
 * `@meta.application` annotation all hold a `TypeRef`; whether a slot admits an application is the
 * reading type's, never the host's. A record field's `type` additionally admits a {@link SiblingRef}
 * ({@link Reference}).
 *
 * **`arguments` non-empty means "an application"**, and appears only where an application is still
 * open (inside a record template, a held template's text, an alias's target) or where one is recorded
 * (`type_chain.parents`, `@meta.application`). A closed application lifts to an entry and is named bare
 * where it stands (§5.3). Absent and empty are the same list, so a resolver normalises an unstated
 * value to `[]`.
 *
 * `annotations` carries the wire annotations written on the reference **itself**, not the enclosing
 * field's. A reference is a hop, never a rewrite (§8.3), so no resolver-attached provenance ever lands
 * here. Excluded from a reference's identity, which is where it points.
 *
 * `kind` is absent, which is what tells a type reference from a {@link SiblingRef} when a
 * {@link Reference} is narrowed.
 */
export interface TypeRef {
  readonly kind?: undefined;
  readonly name: string;
  readonly arguments: readonly TypeArgument[];
  readonly annotations: Annotations;
}

/**
 * A sibling reference, `kind!`: a record field's type chosen, per instance, by the value of the field
 * `field` of the same record (§5.2, [TSON-DATA] §7.4). It stands only at a record field's type --
 * `RecordField.type` and `RecordTemplateField.type` hold a {@link Reference}, and every other slot that
 * names a type holds a {@link TypeRef}, so the position rule is the host type.
 *
 * `field` is a field name, not a type name: a sibling has no `name` to resolve as an entry and no
 * referent, since what it names differs from one instance to the next. Identity is the field alone.
 */
export interface SiblingRef {
  readonly kind: 'sibling';
  readonly field: string;
  readonly annotations: Annotations;
}

/**
 * What the kernel's `meta.reference_type` reads to, as written: a type reference or a sibling reference.
 * Typed `meta.field_type_ref` at a record field's type, and `meta.type_ref` (without the sibling)
 * everywhere else.
 */
export type Reference = TypeRef | SiblingRef;

/** Whether `reference` is a {@link SiblingRef}. */
export function isSibling(reference: Reference): reference is SiblingRef {
  return reference.kind === 'sibling';
}

/** The canonical text of a reference, what resolved output writes unquoted: `name`, `name<T>` or `field!`. */
export function referenceText(reference: Reference): string {
  if (reference.kind === 'sibling') return `${reference.field}!`;
  if (reference.arguments.length === 0) return reference.name;
  return `${reference.name}<${reference.arguments.map(argumentText).join(' ')}>`;
}

/** One argument's canonical text, as it stands inside a reference's argument list. */
export function argumentText(argument: TypeArgument): string {
  if (argument.kind === 'ref') return referenceText(argument.ref);
  const { text, form } = argument.value;
  return form === 'UNQUOTED' ? text : quotedText(text);
}

function quotedText(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code < 0x20 || code === 0x7f)
      out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * One positional argument of a resolved {@link TypeRef} (§4.2, §8.1): a reference or a token. A
 * discriminated union, `kind` being this package's own tag. **The grammar classifies; the head's
 * parameters judge**: a token that parses as a reference is a `ref`, and a `value` is a token that does
 * not -- a number or a quoted token -- or an unquoted one a resolver has judged a value at its
 * parameter. Equality is by text: `ref(red)` and an unquoted `value(red)` are one argument.
 */
export type TypeArgument = TypeArgumentRef | TypeArgumentValue;

/** A reference argument, itself possibly an application. */
export interface TypeArgumentRef {
  readonly kind: 'ref';
  readonly ref: TypeRef;
}

/** A literal argument: a token. */
export interface TypeArgumentValue {
  readonly kind: 'value';
  readonly value: Token;
}

/**
 * The kernel's `meta.type_chain` (§4.1): where a type sits in the IS-A order, carried by every
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
 * The kernel's `meta.type => abstract top & { chain?: type_chain }` (§4.1): the one field every
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
 * The kernel's `meta.alias` constructor's own vocabulary, resolved (§4.1, §8.1): an alias,
 * `!meta.alias { target: T }` -- `meta.type_name`/`meta.field_name`/`meta.param_name` (aliasing
 * `meta.identifier`), the annotation markers, and a declaration naming another entry. Composes
 * `meta.top` directly, so it carries no chain: a hop has no IS-A of its own.
 *
 * `target` is a {@link TypeRef}, an application where the alias is a partial application
 * (`uuid_pair => <B> pair<uuid B>` is `!meta.alias { target: pair<uuid B> }`), and may name a
 * constructor, since an alias of a constructor is applied as its target is (§3.3.1). **An alias is a hop,
 * never a rewrite** (§8.3): a use site naming this entry names this entry, and no walk collapses `target`
 * into whatever it in turn names before writing it out.
 */
export interface Alias {
  readonly kind: 'alias';
  readonly target: TypeRef;
}

/**
 * An entry whose value is an instance of an ordinary type (§4.1): `orders => !api { ... }`, a value of
 * the namespace type `api`, or `create_order => !operation { ... }`, a value of the record type
 * `operation`. An entry is a type exactly when its value is built by a constructor IS-A `meta.type`;
 * this one is no type, nothing is typed by it, and no kind holds it. A reference names it
 * (`meta.ref<api>`), and a qualified name walks into it, by key through a namespace value and by field
 * through a record value (§5.12). A schema map nested as an entry, `geo => !schema { ... }`, is one too,
 * a value of `meta.schema` holding its members by their own names, each of them an entry of the document
 * under its path.
 *
 * `type` is the type the entry's tag names, which resolved output writes as that tag. `value` is what
 * reading the payload against it produced: this model binds nothing to host classes, so a value is held
 * generically ({@link MetaValue}).
 */
export interface ValueEntry {
  readonly kind: 'value_entry';
  readonly type: string;
  readonly value: MetaValue;
}

/**
 * A value read from a type's own vocabulary, held generically (§4.1): this model binds nothing to host
 * classes, so the values of a namespace type (an `api`'s `binding`s) and of a record type (an
 * `operation`) are carried as what they were written as. A record value holds its fields by wire name
 * ({@link MetaRecordValue}); a token at an atom-typed slot is kept as written; a name at a
 * `meta.ref<T>` slot is kept as the {@link Token} written, beside the {@link NameSlot} it was read at --
 * which is what a qualified name's field step reads and what resolved output writes back -- and an
 * application or a sibling reference as the {@link Reference} written.
 */
export type MetaValue =
  | { readonly form: 'token'; readonly token: Token; readonly slot?: NameSlot }
  | { readonly form: 'reference'; readonly reference: Reference; readonly slot?: NameSlot }
  | { readonly form: 'void' }
  | { readonly form: 'list'; readonly elements: readonly MetaValue[] }
  | {
      readonly form: 'map';
      readonly entries: readonly (readonly [MetaValue, MetaValue])[];
    }
  | MetaRecordValue
  | { readonly form: 'namespace'; readonly value: Namespace<MetaValue> }
  | { readonly form: 'schema_map'; readonly members: Namespace<Top> };

/**
 * The slot a name was read at, as its declaration typed it (§4.2, §5.12): a `meta.ref<T>` slot over a
 * constructor holds a type's name (`TYPE_NAME`), and over any other type a value's qualified name
 * (`VALUE_NAME`). `of` is the slot's reference `of`, and `type` the slot's declared type as a message
 * names it, `meta.ref<method>`. A name carries its slot's type from the read, so judging it never walks
 * back through the declarations.
 */
export interface NameSlot {
  readonly role: 'TYPE_NAME' | 'VALUE_NAME';
  readonly of: string;
  readonly type: string;
}

/**
 * A record value of a type's vocabulary: its fields by wire name, and `type`, the record type its tag
 * names where that is other than the type its position declares (a member of a family, a strict
 * subtype) -- the tag resolved output writes. A value read as its position's own type carries none,
 * whether or not it was written with a tag naming that type.
 */
export interface MetaRecordValue {
  readonly form: 'record';
  readonly type?: string;
  readonly fields: ReadonlyMap<string, MetaValue>;
}

/**
 * A value of a map type keyed by names, as a schema map and a namespace value are (§4.1): the map
 * its facets describe, with each key's annotations and the order the keys were written in. The kernel
 * declares one namespace type, `meta.schema`, and every resolved schema holds a value of it; a record's
 * `fields` are a value of the ordered, `text`-keyed `meta.field_map`, which is no namespace. A schema
 * declares its own (`api => !meta.namespace { key_type: meta.identifier  value_type: method }`), and an
 * entry applying one (`myapi => !api { ... }`) holds another, as a {@link ValueEntry}.
 *
 * `type` names the map's type, which fixes the type of its keys and values; it is the tag resolved
 * output writes where the value stands as an entry. `entries` keeps the order the keys were written
 * in; `keyAnnotations` holds the annotations written at a key's own position, present only for a key
 * that carries any.
 *
 * Equal maps are one type's values with the same keys, values and key annotations. Whether order is
 * part of the value is a facet of the type (`ordered`), so an owner whose map is ordered compares it in
 * order itself, as a record does its `fields`.
 */
export interface Namespace<V> {
  readonly kind: 'namespace_value';
  readonly type: string;
  readonly entries: ReadonlyMap<string, V>;
  readonly keyAnnotations?: ReadonlyMap<string, Annotations>;
}

export { APPLICATION_ANNOTATION, FIELD_MAP, SYNTHETIC_ANNOTATION };
/** The kernel's schema namespace type: the type of every schema map's value. */
export const SCHEMA_NAMESPACE = SCHEMA;

/** A value of `type` holding `entries`, in the order given, with `keyAnnotations` where any key carries some. */
export function namespaceOf<V>(
  type: string,
  entries: Iterable<readonly [string, V]>,
  keyAnnotations?: ReadonlyMap<string, Annotations>,
): Namespace<V> {
  const map = new Map<string, V>();
  for (const [key, value] of entries) map.set(key, value);
  return {
    kind: 'namespace_value',
    type,
    entries: map,
    ...(keyAnnotations === undefined || keyAnnotations.size === 0 ? {} : { keyAnnotations }),
  };
}

/**
 * The kernel's `atom => abstract type & {}` base kind (§4.1) -- every ATOM-kind body. {@link VoidType}
 * backs `void`; {@link EnumBody} backs `boolean` and the kernel's other enumerations; {@link ReferenceBody}
 * is the atom whose values are names; every other member is an atom constraint-vocabulary family, one per
 * `*_type` constructor (§9).
 */
export type Atom =
  | VoidType
  | EnumBody
  | ReferenceBody
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
 * The kernel's `type => abstract top & { chain?: type_chain }` (§4.1): the bodies that describe the shape
 * of a data value. `atom`, `product` and `sum` compose it, and every body here carries its
 * {@link TypeChain}.
 */
export type Type = Atom | Product | Sum;

/**
 * The kernel's structural root, `top => abstract {}` (§4.1), and what a schema map's entries are values
 * of: `schema => !meta.namespace { key_type: meta.type_name  value_type: meta.declared }`.
 *
 * Four kinds of value: a {@link Type} (every atom, product and sum body), an {@link Alias}, a held
 * {@link TemplateBody}, and a {@link ValueEntry}. The latter three carry no chain -- a hop, an
 * abbreviation and a value have no IS-A. Every member but {@link TemplateBody} carries a `kind` literal
 * (`record`, `array`, `integer_type`, `alias`, `value_entry`, ...), narrowable with an ordinary `switch`;
 * the held body has none, since the kernel's `template` declares no tag field, so code that must handle
 * it narrows with {@link isTemplateBody} first.
 */
export type Top = Type | Alias | TemplateBody | ValueEntry;

/** Whether `value` is the held, unresolved body of an open entry (§5.10), the one {@link Top} member with no `kind`. */
export function isTemplateBody(value: Top): value is TemplateBody {
  return !('kind' in value) && 'template' in value && 'parameters' in value;
}

/** Whether `value` is an entry that is a value, never a type: an instance of an ordinary type, or a schema map nested as an entry. */
export function isValueEntry(value: Top): value is ValueEntry {
  return 'kind' in value && value.kind === 'value_entry';
}

/** Whether `value` describes a type -- IS-A `type`, so carries a chain (§4.1). */
export function isType(value: Top): value is Type {
  return 'kind' in value && value.kind !== 'alias' && value.kind !== 'value_entry';
}

/**
 * Whether the entry `name`, whose value is `value`, IS-A the kernel's `meta.top` (§4.1, §4.2) -- what
 * makes it a constructor: a base kind, `meta.alias`, `meta.template`, or anything composing one. Read
 * off the chain, so it is not a fact a document can be wrong about. `meta.top` answers for itself by
 * name, being what every other answer IS-A.
 */
export function isConstructor(value: Top, name?: string): boolean {
  return supertypesOf(value).includes(metaName('top')) || name === metaName('top');
}

/**
 * The parameters an entry whose value is `value` binds, in declaration order (§5.10) -- `[]` for a
 * closed entry. Two shapes carry an open entry: a record template ({@link RecordTemplateBody}, a
 * family base and itself a type) and every other open entry's held {@link TemplateBody}.
 */
export function parametersOf(value: Top | undefined): readonly TemplateParam[] {
  if (value === undefined) return [];
  if (isTemplateBody(value)) return value.parameters;
  if (value.kind === 'record_template') return value.parameters;
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

/** Whether `value` is a family base: a record template, ABSTRACT by construction (§5.10). */
export function isFamilyBase(value: Top | undefined): value is RecordTemplateBody {
  return value !== undefined && !isTemplateBody(value) && value.kind === 'record_template';
}

/**
 * `value`'s own choice-disjointness fact (§5.4, §8.1) -- present exactly when `value` is a
 * `choice`, absent for every other body shape.
 */
export function choiceDisjoint(value: Top): boolean | undefined {
  return !isTemplateBody(value) && value.kind === 'choice' ? value.disjoint : undefined;
}

/** The base kinds a record's chain is searched for, in the order the kernel declares them. */
const BASE_KIND_NAMES: readonly (readonly [string, EntryKind])[] = [
  [metaName('atom'), 'ATOM'],
  [metaName('product'), 'PRODUCT'],
  [metaName('sum'), 'SUM'],
];

/**
 * `value`'s {@link EntryKind} (§4.1, §8.1), derived and never stored. A body is the branch of
 * {@link Top} it occupies -- an instance takes its constructor's kind by being built as one (§5.5's
 * transfer) -- except a record or a record template, whose kind is the base kind its chain reaches:
 * `integer_type => atom & { ... }` is a record describing atoms, and the kind of a constructor is what
 * its instances are. The first of `meta.atom`, `meta.product` and `meta.sum` in the chain wins (`top`
 * and `type` never count), and a record whose chain reaches none is a product.
 *
 * `kernel` says whether a chain's name denotes the kernel's own entry of that name: a kind is judged by
 * where a base kind is defined, never by its spelling, so a schema's own `atom => { ... }` composed into
 * `payload => atom & { ... }` leaves `payload` a PRODUCT. Omitted, every name is taken as the kernel's.
 */
export function entryKind(value: Top, kernel: (name: string) => boolean = () => true): EntryKind {
  if (isTemplateBody(value)) return 'TEMPLATE';
  switch (value.kind) {
    case 'alias':
      return 'ALIAS';
    case 'value_entry':
      return 'VALUE';
    case 'record':
    case 'record_template': {
      const supertypes = supertypesOf(value);
      for (const [name, kind] of BASE_KIND_NAMES) {
        if (supertypes.includes(name) && kernel(name)) return kind;
      }
      return 'PRODUCT';
    }
    case 'array':
    case 'map':
    case 'namespace':
    case 'tuple':
      return 'PRODUCT';
    case 'choice':
    case 'declared_type':
      return 'SUM';
    default:
      return 'ATOM';
  }
}

/**
 * What an entry carries beyond its value (§8.1), none of it a field of any constructor and none of it
 * written: where the declaration sat, the annotations written after `=>` on the value (§6; the ones
 * written before the name are the key's), `head`, the constructor the value's tag names --
 * `!numeric.integer_type`, `!enum`, `!meta.set_type` -- which a body's shape cannot always recover, since
 * `set_type` restates `array`'s fields and `enum` and `enum_type` share one shape, `refines`, the entry a
 * `^` declaration's head names as written, `synthetic`, the key's `@meta.synthetic` mark as a schema
 * reads it, and `closes`, every application the resolver closed to this entry as it met them, an
 * expansion's among them, which carries no `@meta.application`: what lets a data read resolve an
 * application by structural identity to the entry the schema closed it to (§7.4, §8.2). (`head` rather
 * than `constructor`, which every object already answers through its prototype.)
 */
export interface EntryFacts {
  readonly position?: SourcePosition;
  readonly annotations?: Annotations;
  readonly head?: string;
  readonly refines?: string;
  readonly synthetic?: boolean;
  readonly closes?: readonly TypeRef[];
}

/** An entry with none of its facts recorded. */
export const NO_FACTS: EntryFacts = {};

/** The constructor path each body `kind` is built by, where one constructor has that shape (§9). */
const CONSTRUCTOR_OF_KIND: Readonly<Record<string, string>> = {
  record: metaName('record'),
  record_template: metaName('record_template'),
  array: metaName('array'),
  map: metaName('map'),
  namespace: metaName('namespace'),
  tuple: metaName('tuple'),
  choice: metaName('choice'),
  declared_type: metaName('declared_type'),
  enum: metaName('enum_type'),
  reference_type: metaName('reference_type'),
  void_type: metaName('void_type'),
  alias: metaName('alias'),
  integer_type: kernelName('numeric', 'integer_type'),
  decimal_type: kernelName('numeric', 'decimal_type'),
  float_type: kernelName('numeric', 'float_type'),
  rational_type: kernelName('numeric', 'rational_type'),
  complex_type: kernelName('numeric', 'complex_type'),
  text_type: kernelName('unicode', 'text_type'),
  identifier_type: kernelName('unicode', 'identifier_type'),
  regex_type: kernelName('unicode', 'regex_type'),
  iri_type: kernelName('net', 'iri_type'),
  uri_type: kernelName('net', 'uri_type'),
  email_type: kernelName('net', 'email_type'),
  uuid_type: kernelName('net', 'uuid_type'),
  ipv4_type: kernelName('net', 'ipv4_type'),
  ipv6_type: kernelName('net', 'ipv6_type'),
  cidr4_type: kernelName('net', 'cidr4_type'),
  cidr6_type: kernelName('net', 'cidr6_type'),
  mac_type: kernelName('net', 'mac_type'),
  hostname_type: kernelName('net', 'hostname_type'),
  host_type: kernelName('net', 'host_type'),
  media_type_type: kernelName('net', 'media_type_type'),
  bytes_type: kernelName('binary', 'bytes_type'),
  date_type: kernelName('temporal', 'date_type'),
  time_type: kernelName('temporal', 'time_type'),
  datetime_type: kernelName('temporal', 'datetime_type'),
  duration_type: kernelName('temporal', 'duration_type'),
  period_type: kernelName('temporal', 'period_type'),
};

/**
 * The constructor `value`'s shape is the body of, by its `kind` -- exact where one constructor has that
 * shape, and the base one where several share it (`meta.enum_type` for `enum`/`enum_type`, `meta.array`
 * for `array`/`set_type`), which is why an entry's {@link EntryFacts.head} is asked first. A value entry
 * names its own type, and a held body is `meta.template`'s.
 */
export function constructorOf(value: Top): string {
  if (isTemplateBody(value)) return metaName('template');
  if (value.kind === 'value_entry') return value.type;
  const path = CONSTRUCTOR_OF_KIND[value.kind];
  if (path === undefined) {
    throw new Error(`no constructor is recorded for a body of kind '${value.kind}'`);
  }
  return path;
}

/** The `@meta.application` an entry's key annotations record, if it closes one (§8.2). */
export function applicationOf(keyAnnotations: Annotations | undefined): TypeRef | undefined {
  const found = keyAnnotations?.find((annotation) => annotation.name === APPLICATION_ANNOTATION);
  return found?.value as TypeRef | undefined;
}

/** `keyAnnotations` with `application` recorded as the entry's `@meta.application`, any earlier one replaced. */
export function withApplication(
  keyAnnotations: Annotations | undefined,
  application: TypeRef,
): Annotations {
  return [
    { name: APPLICATION_ANNOTATION, value: application },
    ...(keyAnnotations ?? []).filter((annotation) => annotation.name !== APPLICATION_ANNOTATION),
  ];
}
