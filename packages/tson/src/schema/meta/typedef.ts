/**
 * The resolved-schema value model's root (Part 2 §4, §8.1): what a schema map's entries are values
 * of, the IS-A chain a type carries, and the type-system vocabulary every body is built from --
 * references, applications, kinds, value entries and nested schema maps.
 *
 * **An entry is its value** (§8.1). A resolved schema is one map from qualified name to {@link Top}:
 * a type body (every atom, product and sum), an {@link Alias} or {@link Extern}, a {@link ValueEntry}, an
 * instance of an ordinary type (`orders => !api { ... }`) or a schema map nested as an entry (`geo =>
 * !schema { ... }`), or an {@link IncompleteEntry}, a construction left open. What the value's own shape cannot carry -- where the
 * declaration sat, the annotations written after `=>`, the constructor its tag names -- is the
 * entry's {@link EntryFacts}, kept beside the map rather than in it, since none of it is a field of
 * any constructor and none of it is written.
 *
 * An entry is a type exactly when its value is built by a constructor IS-A `meta.type` (§4.1); any
 * other entry is a value, marked by nothing but its tag. A type's `kind` literal here is its
 * constructor's member name (`record`, `integer_type`, `ref`); {@link constructorOf} maps
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
import type { EnumBody, RecordField, RefBody } from './bodies.js';
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
  COMPLETION_ANNOTATION,
  FIELD_MAP,
  SCHEMA,
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
 * A reference to a type as the kernel's `meta.type_ref` holds it (§4.2, §8.1): a qualified `name`, its
 * segments joined by `.`. **A reference holds a name and nothing else**: an application, `box<T>`, is the
 * construction `meta.apply` written in place ({@link TypeInline}), and an argument list is no part of a
 * value ([TSON-DATA] §7.2.5).
 *
 * `param` marks a parameter of the enclosing parametric record (§5.10): a name looked up in the record's
 * `parameters` before the namespace, which names no entry and is never equal to the name spelled the same.
 * Only a parametric record holds one.
 *
 * `annotations` carries the wire annotations written on the reference **itself**, not the enclosing
 * field's. A reference is a hop, never a rewrite (§8.3), so no resolver-attached provenance ever lands
 * here. Excluded from a reference's identity, which is where it points.
 *
 * `kind` is absent, which is what tells a reference from a {@link TypeInline} when a {@link TypeExpr} is
 * narrowed.
 */
export interface TypeRef {
  readonly kind?: undefined;
  readonly name: string;
  readonly annotations: Annotations;
  readonly param?: true;
}

/** The unannotated reference to `name`. */
export function typeRef(name: string): TypeRef {
  return { name, annotations: [] };
}

/** Whether two references point at one thing: the same name, and both a parameter or both a name (§8.2). */
export function sameRef(a: TypeRef, b: TypeRef): boolean {
  return a.name === b.name && (a.param === true) === (b.param === true);
}

/**
 * A type written where it is used, the kernel's `meta.type_inline` (§4.2): the construction a sugar form or an
 * applied constructor denotes, or the record an application of a parametric record closes to, held at the slot
 * that wrote it, `{ of: !meta.array { element_type: text } }`. It is no entry: it has no name, nothing looks it
 * up, and its body carries no chain.
 *
 * `head` is the tag on `of`, the entry the construction applies past its alias hops (§8.3): `set<text>` is held
 * under `meta.array`. It is no field of the wrapper -- the kernel's `type_inline` declares `of` alone -- so it is
 * held beside the body, as a declared entry's tag is held in its facts. `application` is the application a record
 * in place closes, as written, held for a message and taking no part in identity.
 *
 * Identity is the head's and the body's (§8.2): two types written in place are one type when their constructor and
 * fields are equal, names as the leaves, annotations taking no part. A name and a type written in place are never
 * one type.
 */
export interface TypeInline {
  readonly kind: 'inline';
  readonly head: string;
  readonly of: Type;
  readonly application?: ApplyBody;
}

/**
 * What a type slot holds, the kernel's `meta.type_expr` (§4.2): a {@link TypeRef}, a name looked up in the closure,
 * or a {@link TypeInline}, a type written where it is used. A name is string-class and the wrapper brace-class, so
 * the two are told apart by form when read (§5.4).
 */
export type TypeExpr = TypeRef | TypeInline;

/** Whether `expr` is a type written in place. */
export function isInline(expr: TypeExpr): expr is TypeInline {
  return expr.kind === 'inline';
}

/** `expr` as the reference it is, or `undefined` where it is a type written in place. */
export function namedOf(expr: TypeExpr): TypeRef | undefined {
  return expr.kind === 'inline' ? undefined : expr;
}

/** `expr`'s name, or `undefined` where it is a type written in place. */
export function nameOf(expr: TypeExpr): string | undefined {
  return expr.kind === 'inline' ? undefined : expr.name;
}

/**
 * The kernel's `meta.apply` (§5.10): an application, `box<T>`, written in place. `head` names what is applied
 * and `arguments` supply it positionally, each a name or a parameter (`[meta.type_ref; 1..]`). In resolved output
 * it stands only inside a parametric record over one of its parameters; it is also the value of
 * `@meta.application`. It composes `meta.type` directly, being no atom, product or sum. Identity is the head and
 * the arguments.
 */
export interface ApplyBody extends TypeBase {
  readonly kind: 'apply';
  readonly head: TypeRef;
  readonly arguments: readonly TypeRef[];
}

/** The source spelling of an application, for a message: `pair<text integer>`. */
export function applyText(apply: Pick<ApplyBody, 'head' | 'arguments'>): string {
  return `${apply.head.name}<${apply.arguments.map((argument) => argument.name).join(' ')}>`;
}

/**
 * The kernel's `meta.dependent => final meta.sum & { on: text }` (§5.2): the sum in which the field `on` of the
 * enclosing record instance names the type. Written in place only, directly at a record field's type, `kind!` in
 * source; a variable bound by that record, so equal text in two records is two types.
 */
export interface DependentBody extends TypeBase {
  readonly kind: 'dependent';
  readonly on: string;
}

/** The dependent type a record field holds in place, or `undefined` where its type is no dependent type. */
export function dependentOn(expr: TypeExpr): string | undefined {
  return expr.kind === 'inline' && expr.of.kind === 'dependent' ? expr.of.on : undefined;
}

/**
 * An entry a constructor of types built with a required field absent, `nonempty => !meta.array ^ { min_items:
 * 1 }` (§5.5). It is no type: nothing is typed by it, it carries no chain and no subtype names it. It is a base for
 * `^` and a head to complete, and a completion is the plain construction of `head`. Held in a schema's namespace
 * so an import carries it as any entry, and never written: a resolved form holds complete entries only.
 *
 * `head` is the constructor it builds past its alias hops; `absent` the required fields it leaves absent, in
 * declaration order, never empty; `written` the binding record as written, the parsed node, opaque here since this
 * model names no compiler type; `bases` the incomplete entries it was built from by `^`, nearest first, each past
 * its alias hops.
 */
export interface IncompleteEntry {
  readonly kind: 'incomplete';
  readonly head: string;
  readonly absent: readonly string[];
  readonly written: object;
  readonly bases: readonly string[];
}

/** Whether `value` is an incomplete entry (§5.5). */
export function isIncomplete(value: Top | undefined): value is IncompleteEntry {
  return value?.kind === 'incomplete';
}

/**
 * The kernel's `meta.extern => meta.top & { schema: iri_reference  type: text }` (§5.13): one entry of another
 * schema under a name of this one. A hop, as an alias is, composing `meta.top` and carrying no chain.
 */
export interface Extern {
  readonly kind: 'extern';
  readonly schema: string;
  readonly type: string;
}

/**
 * The kernel's `meta.param => { name: meta.param_name  bound?: meta.type_ref }` (§5.10): one parameter of a
 * parametric record, its name and the bound an argument must IS-A, as the declaration writes it. Nothing about a
 * parameter is inferred.
 */
export interface Param {
  readonly name: string;
  readonly bound?: TypeRef;
}

/**
 * The kernel's `meta.type_chain` (§4.1): where a type sits in the IS-A order, carried by every
 * type body as `type`'s one field, `chain`.
 *
 * - **`parents`** is what was written: a parametric record's parents, one of which may be an
 *   application written in place (`<T> result<T> & { ... }`). It is the only list that ever holds an
 *   application, and a closed type carries none once linked.
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
  readonly parents: readonly TypeExpr[];
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
  parents: readonly TypeExpr[] = [],
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
export function parentsOf(value: Top | undefined): readonly TypeExpr[] {
  return chainOf(value).parents;
}

/**
 * `value` with `chain` in place of its own. A value that carries no chain (an alias, an extern, an
 * incomplete entry, a value entry) is returned as it is, and an empty chain leaves the body with no
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
 * `!meta.alias { target: T }` -- `meta.type_name`/`meta.param_name` (aliasing `meta.identifier`), the
 * annotation markers, and a declaration naming another entry. Composes `meta.top` directly, so it carries
 * no chain: a hop has no IS-A of its own.
 *
 * `target` is a {@link TypeRef}, a name (§8.3), and may name a constructor or an incomplete entry, since an
 * alias of either is applied as its target is (§3.3.1). **An alias is a hop,
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
 * which is what a qualified name's field step reads and what resolved output writes back.
 */
export type MetaValue =
  | { readonly form: 'token'; readonly token: Token; readonly slot?: NameSlot }
  | { readonly form: 'void' }
  | { readonly form: 'list'; readonly elements: readonly MetaValue[] }
  | {
      readonly form: 'map';
      readonly entries: readonly (readonly [MetaValue, MetaValue])[];
    }
  | MetaRecordValue
  | MetaHeldValue
  | { readonly form: 'namespace'; readonly value: Namespace<MetaValue> }
  | { readonly form: 'schema_map'; readonly members: Namespace<Top> };

/**
 * A dependent field's value held as written (§5.2): the type its sibling names is one of the namespace the
 * value entry sits in, which the reader of the declaring layer does not hold, so the value is judged when
 * the schema links. `value` is the value as a generic tree, which a qualified name selects in
 * (`web.value.port`); `written` is the data value as it was written, annotations and tags included, which
 * the link reads against the type the sibling names and resolved output writes back, kept opaque here
 * because this model names no compiler type. `field` is the dependent field and `sibling` the field typing
 * it, `declared` the sibling's declaration, and `named` what the sibling holds in this instance: its pin
 * wherever it is written, the value written, or its default -- absent where the sibling holds none.
 */
export interface MetaHeldValue {
  readonly form: 'held';
  readonly value: MetaValue;
  readonly written: object;
  readonly field: string;
  readonly sibling: string;
  readonly declared: RecordField;
  readonly named?: TypeRef;
}

/**
 * The slot a name was read at, as its declaration typed it (§4.2, §5.12): a `meta.ref<T>` slot over a
 * constructor holds a type's name (`TYPE_NAME`), and over any other type a value's qualified name
 * (`VALUE_NAME`). `of` is the slot's reference `of`, and `type` the slot's declared type as a message
 * names it, `meta.ref<method>`. A name carries its slot's type from the read, so judging it never walks
 * back through the declarations. `role` is how the read took the name: the link judges by what `of` names
 * over the final namespace, whichever the read guessed.
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

export { APPLICATION_ANNOTATION, COMPLETION_ANNOTATION, FIELD_MAP };
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
 * backs `void`; {@link EnumBody} backs `boolean` and the kernel's other enumerations; {@link RefBody}
 * is the atom whose values are names; every other member is an atom constraint-vocabulary family, one per
 * `*_type` constructor (§9).
 */
export type Atom =
  | VoidType
  | EnumBody
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
 * The kernel's `type => abstract top & { chain?: type_chain }` (§4.1): the bodies that describe the shape
 * of a data value. `atom`, `product` and `sum` compose it, and so does `meta.apply`, which is none of them;
 * every body here carries its {@link TypeChain}.
 */
export type Type = Atom | Product | Sum | ApplyBody;

/**
 * The kernel's structural root, `top => abstract {}` (§4.1), and what a schema map's entries are values
 * of: `schema => !meta.namespace { key_type: meta.type_name  value_type: meta.declared }`.
 *
 * A {@link Type} (every atom, product and sum body), an {@link Alias} or an {@link Extern} (the two hops), a
 * {@link ValueEntry}, or an {@link IncompleteEntry}, which is no value at all. Only a type carries a chain.
 * Every member carries a `kind` literal (`record`, `array`, `integer_type`, `alias`, `value_entry`, ...),
 * narrowable with an ordinary `switch`.
 */
export type Top = Type | Alias | Extern | ValueEntry | IncompleteEntry;

/** Whether `value` is an entry that is a value, never a type: an instance of an ordinary type, or a schema map nested as an entry. */
export function isValueEntry(value: Top): value is ValueEntry {
  return value.kind === 'value_entry';
}

/** Whether `value` describes a type -- IS-A `type`, so carries a chain (§4.1). */
export function isType(value: Top): value is Type {
  return (
    value.kind !== 'alias' &&
    value.kind !== 'value_entry' &&
    value.kind !== 'extern' &&
    value.kind !== 'incomplete'
  );
}

/**
 * Whether the entry `name`, whose value is `value`, IS-A the kernel's `meta.top` (§4.1, §4.2) -- what
 * makes it a constructor: a base kind, `meta.alias`, `meta.extern`, or anything composing one. Read off the
 * chain, so it is not a fact a document can be wrong about. `meta.top` answers for itself by name, being
 * what every other answer IS-A.
 */
export function isConstructor(value: Top, name?: string): boolean {
  return supertypesOf(value).includes(metaName('top')) || name === metaName('top');
}

/**
 * The parameters an entry whose value is `value` binds, in declaration order (§5.10) -- `[]` for every entry
 * but a parametric record, a `meta.record` carrying `parameters`.
 */
export function parametersOf(value: Top | undefined): readonly Param[] {
  if (value?.kind !== 'record') return [];
  return value.parameters ?? [];
}

/** The parameter names `value` binds, in declaration order -- what an application's arity is checked against. */
export function typeParameters(value: Top | undefined): readonly string[] {
  return parametersOf(value).map((parameter) => parameter.name);
}

/** Whether `value` is a parametric record: a record with parameters (§5.10). */
export function isParametric(value: Top | undefined): boolean {
  return parametersOf(value).length > 0;
}

/**
 * `value`'s own choice-disjointness fact (§5.4, §8.1) -- present exactly when `value` is a
 * `choice`, absent for every other body shape.
 */
export function choiceDisjoint(value: Top): boolean | undefined {
  return value.kind === 'choice' ? value.disjoint : undefined;
}

/**
 * What an entry carries beyond its value (§8.1), none of it a field of any constructor and none of it
 * written: where the declaration sat, the annotations written after `=>` on the value (§6; the ones
 * written before the name are the key's), `head`, the constructor the value's tag names --
 * `!numeric.integer_type`, `!meta.record` -- which a body's shape cannot always recover, and `refines`, the
 * entry a `^` declaration's head names as written. (`head` rather than `constructor`, which every object
 * already answers through its prototype.)
 */
export interface EntryFacts {
  readonly position?: SourcePosition;
  readonly annotations?: Annotations;
  readonly head?: string;
  readonly refines?: string;
}

/** An entry with none of its facts recorded. */
export const NO_FACTS: EntryFacts = {};

/** The constructor path each body `kind` is built by, where one constructor has that shape (§9). */
const CONSTRUCTOR_OF_KIND: Readonly<Record<string, string>> = {
  record: metaName('record'),
  array: metaName('array'),
  map: metaName('map'),
  namespace: metaName('namespace'),
  tuple: metaName('tuple'),
  choice: metaName('choice'),
  declared_type: metaName('declared_type'),
  dependent: metaName('dependent'),
  apply: metaName('apply'),
  enum: metaName('enum_type'),
  ref: metaName('ref'),
  void_type: metaName('void_type'),
  alias: metaName('alias'),
  extern: metaName('extern'),
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
 * shape, and the base one where several share it (`meta.array` for an array however its entry was built),
 * which is why an entry's {@link EntryFacts.head} is asked first. A value entry names its own type, and an
 * incomplete entry the constructor it builds.
 */
export function constructorOf(value: Top): string {
  if (value.kind === 'value_entry') return value.type;
  if (value.kind === 'incomplete') return value.head;
  const path = CONSTRUCTOR_OF_KIND[value.kind];
  if (path === undefined) {
    throw new Error(`no constructor is recorded for a body of kind '${value.kind}'`);
  }
  return path;
}

/** The `@meta.application` an entry's key annotations record, if it closes one (§8.2). */
export function applicationOf(keyAnnotations: Annotations | undefined): ApplyBody | undefined {
  const found = keyAnnotations?.find((annotation) => annotation.name === APPLICATION_ANNOTATION);
  return found?.value as ApplyBody | undefined;
}

/** `keyAnnotations` with `application` recorded as the entry's `@meta.application`, any earlier one replaced. */
export function withApplication(
  keyAnnotations: Annotations | undefined,
  application: ApplyBody,
): Annotations {
  return [
    { name: APPLICATION_ANNOTATION, value: application },
    ...(keyAnnotations ?? []).filter((annotation) => annotation.name !== APPLICATION_ANNOTATION),
  ];
}

/**
 * The value of the kernel's `meta.completion` (§8.1): the incomplete entries a declared completion closed,
 * nearest first, each by its own name past alias hops. The names are text, those entries being in no resolved
 * form.
 */
export interface Completion {
  readonly of: readonly string[];
}

/** The `@meta.completion` an entry's key annotations record, if it completes an incomplete entry (§8.1). */
export function completionOf(keyAnnotations: Annotations | undefined): Completion | undefined {
  const found = keyAnnotations?.find((annotation) => annotation.name === COMPLETION_ANNOTATION);
  return found?.value as Completion | undefined;
}

/** `keyAnnotations` with `completion` recorded as the entry's `@meta.completion`, any earlier one replaced. */
export function withCompletion(
  keyAnnotations: Annotations | undefined,
  completion: Completion,
): Annotations {
  return [
    ...(keyAnnotations ?? []).filter(
      (annotation) =>
        annotation.name !== COMPLETION_ANNOTATION && annotation.name !== APPLICATION_ANNOTATION,
    ),
    { name: COMPLETION_ANNOTATION, value: completion },
    ...(keyAnnotations ?? []).filter((annotation) => annotation.name === APPLICATION_ANNOTATION),
  ];
}
