/**
 * Binding descriptors for the resolved-schema value model (`schema/meta/*.ts`), authored against
 * Wave 1's bind runtime (`bind/`) -- what turns a `*-resolved.tn` fixture (`spec/m/*-resolved.tn`)
 * back into `schema.meta` values, the way `SchemaMetaNameBinder`
 * (`tson-compiler/.../config/SchemaMetaNameBinder.java`) turns one into `schema.meta` Java records
 * by reflection. There is no reflection here -- every descriptor below is authored by hand, per
 * PORT-PLAN.md's architectural decision 2 and `bind/binding.ts`'s own top comment.
 *
 * **Deliberately outside `schema/meta`.** The zone rule in `eslint.config.js` lets `schema/meta`
 * import only itself, `core/` and `annotations/` -- precisely so the schema model can ship to a
 * browser that never compiles a schema. This module lives in `schema/` instead, and is the one
 * place in the package that imports both `schema/meta` and `bind/`.
 *
 * **Wire names are the kernel's own field names** (Part 2 §8.1's `type_definition` and its body
 * constructors), read off `tson-schema/.../meta/*.java`'s `@Field` annotations (an unannotated
 * Java field name is its own wire name -- confirmed by `RecordComponentFinder`, which reads
 * `@Field` off the accessor and falls back to the reflected name). Every `@Field`-renamed field
 * here carries a comment citing the Java source so the mapping is checkable without re-deriving
 * it.
 *
 * **A `kind` literal is never a wire field.** Every `Top` variant's TypeScript `kind` tag
 * (`'record'`, `'integer_type'`, ...) is this port's own discriminant for narrowing a union --
 * the Java original has no such component (a sealed interface needs no tag of its own), and the
 * kernel's actual polymorphism marker is the wire's own `!type-ref` before the value (§3.1),
 * which is what {@link topBinding} (a {@link VariantBinding}) matches on. Every record-shaped
 * binding below therefore synthesises `kind` in its own `construct`, not as a numbered slot.
 *
 * **The one declaration-order cycle** is {@link TypeRef} <-> {@link TypeArgument}
 * (`type_ref.arguments: [type_argument]`, `type_argument`'s `Ref` member wrapping a `type_ref`
 * right back -- `box<box<text>>`, an ordinary nested application). {@link typeRefBinding} closes
 * it with a single `lazy()` around the one edge that has to wait: `typeArgumentBinding` is
 * declared after it, so `typeRefBinding`'s own `arguments` field defers to it lazily; every other
 * edge in this graph resolves eagerly, top to bottom.
 */

import { array, bridge, field, lazy, optional, record, variant } from '../bind/combinators.js';
import { registry } from '../bind/registry.js';
import type {
  ArrayBinding,
  AtomBinding,
  Binding,
  BindingRef,
  BindingRegistry,
  RecordBinding,
  VariantBinding,
} from '../bind/binding.js';
import type { AtomToken } from '../atom/contract.js';
import type { TokenForm as LexerTokenForm } from '../lexer/token.js';
import type { PlainDateTime, PlainTime, TsonDecimal } from '../value/types.js';

import type { Decimal, Rational, Unit } from './meta/algebra.js';
import type {
  Annotation,
  Annotations,
  Extern,
  Reference,
  Token,
  TokenForm,
  TypeArgument,
  TypeArgumentRef,
  TypeArgumentValue,
  TypeDefinition,
  TypeKind,
  TypeRef,
  Top,
  UnknownType,
} from './meta/typedef.js';
import type {
  ChoiceBody,
  ElementState,
  EnumBody,
  FieldGroup,
  FieldState,
  MapBody,
  RecordBody,
  RecordField,
  TupleBody,
  TupleElement,
  ArrayBody,
} from './meta/bodies.js';
import type {
  BinaryEncoding,
  BinaryType,
  EmailType,
  RegexType,
  TextType,
  UriType,
  UuidType,
} from './meta/atoms-text.js';
import type {
  ComplexComponent,
  ComplexType,
  DecimalType,
  FloatFormat,
  FloatType,
  IntegerSize,
  IntegerType,
  RationalType,
} from './meta/atoms-numeric.js';
import type {
  CalendarDate,
  DateTimeType,
  DateType,
  DurationType,
  OffsetDateTime,
  OffsetTime,
  TimeType,
} from './meta/atoms-temporal.js';
import type { Cidr4Type, Cidr6Type, Ipv4Type, Ipv6Type, MacType } from './meta/atoms-network.js';
import type { SourcePosition } from './meta/position.js';

// -------------------------------------------------------------------------------------------
// The missing twelfth combinator
// -------------------------------------------------------------------------------------------

/**
 * Builds an {@link AtomBinding} leaf. `bind/combinators.ts`'s own top comment counts eleven
 * combinators -- `record`/`tuple`/`array`/`map`/`variant`/`bridge`/`lazy`/`field`/`optional` plus
 * `registry`/`chain` -- and deliberately none of them builds a leaf `AtomBinding`: `AtomBinding`
 * is "deliberately inert" (`binding.ts`'s own doc) precisely so `bind/` never has to depend on
 * `atom/`, and this package -- the schema.meta model -- is the first real consumer that needs one
 * at all. `bind-combinators.test.ts` (Wave 1's own test suite) already names this gap and stands
 * in an identical local helper for its own test scaffolding, licensed there only as test code;
 * this is the shipped equivalent, licensed the same way `bind/combinators.ts`'s own functions
 * are -- built honestly, object literal first, asserted once at the end, because
 * {@link BindingBase}'s phantom key is a `unique symbol` no module outside `binding.ts` can name.
 */
function atom<T>(wireType: string): Binding<T> {
  return { kind: 'atom', wireType } as unknown as AtomBinding<T>;
}

/** Spreads `{ [key]: value }` only when `value` is defined -- `exactOptionalPropertyTypes` means an absent optional property must be omitted, never assigned `undefined`, and this is that omission written once instead of at every optional field of every `construct`. */
function opt<K extends PropertyKey, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}

/** `array()` for the common "ordered list of `E`, host type `readonly E[]`" shape -- every list-shaped field in this model (`CLAUDE.md`'s "absent and empty are the same list" fields included: the emptiness is the reader's concern, not this binding's). */
function arrayOf<E>(element: BindingRef<E>): ArrayBinding<readonly E[]> {
  return array<readonly E[], E>({
    element,
    construct: (values) => values,
    read: (host) => host,
  });
}

// -------------------------------------------------------------------------------------------
// Primitive atom leaves
// -------------------------------------------------------------------------------------------

/**
 * Free/quoted text -- meta-kernel's `text` (§5.7): a `spec`/`pattern`/CIDR-network/duration-bound
 * string, kept exactly as authored. Distinct from {@link identifierBinding}: this position's
 * value is prose or a foreign-document reference, never itself a name resolved against a
 * namespace.
 */
const textBinding: Binding<string> = atom<string>('text');

/**
 * A bare, unquoted lexeme used as a name -- meta-kernel's `field_name`/`type_name`/`param_name`,
 * every one of which is a `REFERENCE`-kind alias to `token` in the resolved output
 * (`SchemaMetaNameBinder.ALIASES` maps all three to `"token"` for exactly this reason). The host
 * value is the token's own text; `form` is not carried here (an identifier is never written
 * quoted in practice, and this position's TypeScript type is a plain `string`, not
 * {@link Token}) -- see {@link tokenBinding} for the position that keeps `form` too.
 */
const identifierBinding: Binding<string> = bridge<string, AtomToken>(
  atom<AtomToken>('token'),
  (text) => ({ text, form: 'unquoted' }),
  (wire) => wire.text,
);

const booleanBinding: Binding<boolean> = atom<boolean>('boolean');

/** Arbitrary-precision `integer` (§5.6) -- the kernel's own unbounded integer, host `bigint`. */
const bigintBinding: Binding<bigint> = atom<bigint>('integer');

/**
 * A small bound narrowed to `number` (`minLength`, `totalDigits`, `version`, ...) -- every one of
 * these is kernel `integer` on the wire (arbitrary precision, per meta.tn's own note: "where the
 * type is integer, the field uses `integer?` directly"), but the Java original binds it to a
 * plain `Integer` for fields it knows never carry a value needing more than 32 bits, and this
 * port's own `schema/meta` types follow that choice (`Optional<Integer>` -> `number`, not
 * `bigint`). The bridge is honest about the mismatch rather than silently asserting `bigint` and
 * `number` are the same shape.
 */
const int32Binding: Binding<number> = bridge<number, bigint>(
  bigintBinding,
  (n) => BigInt(n),
  (b) => Number(b),
);

/**
 * Exact decimal (§5.6's `number`, SQL's exact tier) -- the kernel's `min`/`exclusive_min`/`max`/
 * `exclusive_max`/`multiple_of` escape-hatch `value` fields on {@link DecimalType}/
 * {@link FloatType}, which the Java original binds to `BigDecimal` in both families (per
 * `DecimalType.java`/`FloatType.java`'s own field types) rather than parsing through the
 * constrained family's own atom. This port's {@link Decimal} (`unscaledValue`/`scale`,
 * `BigDecimal`'s own two fields) is a different sign convention from {@link TsonDecimal}
 * (`unscaled`/`exponent`, `value = unscaled * 10^exponent`) -- `exponent = -scale` is the whole
 * of the conversion.
 */
const decimalBinding: Binding<Decimal> = bridge<Decimal, TsonDecimal>(
  atom<TsonDecimal>('number'),
  (d) => ({ unscaled: d.unscaledValue, exponent: -d.scale }),
  (w) => ({ unscaledValue: w.unscaled, scale: -w.exponent }),
);

/** Exact fraction (§5.6's `rational`) -- {@link Rational} here and `value/types.ts`'s own `Rational` share one shape (`numerator`/`denominator`, both `bigint`), so no bridge is needed. */
const rationalBinding: Binding<Rational> = atom<Rational>('rational');

/** RFC 3339 `full-date` (§5.4's `date`) -- {@link CalendarDate} is `value/types.ts`'s `PlainDate` restated field-for-field (`year`/`month`/`day`), so the atom position is reused directly with no bridge. */
const calendarDateBinding: Binding<CalendarDate> = atom<CalendarDate>('date');

/**
 * RFC 3339 `full-time` (§5.4's `time`) -- {@link OffsetTime} nests its offset inside `time`
 * (`{ time: LocalTime, offsetSeconds }`) where `value/types.ts`'s {@link PlainTime} flattens it
 * (`{ hour, minute, second, nanosecond, offset: { totalMinutes } }`); the bridge is the reshape,
 * `offsetSeconds = totalMinutes * 60`.
 */
const offsetTimeBinding: Binding<OffsetTime> = bridge<OffsetTime, PlainTime>(
  atom<PlainTime>('time'),
  (t) => ({
    hour: t.time.hour,
    minute: t.time.minute,
    second: t.time.second,
    nanosecond: t.time.nanosecond,
    offset: { totalMinutes: t.offsetSeconds / 60 },
  }),
  (w) => ({
    time: { hour: w.hour, minute: w.minute, second: w.second, nanosecond: w.nanosecond },
    offsetSeconds: w.offset.totalMinutes * 60,
  }),
);

/** RFC 3339 `date-time` (§5.4's `datetime`) -- {@link OffsetDateTime}'s `date` reuses {@link CalendarDate}/`PlainDate`'s shared shape as-is; `time`+`offsetSeconds` reshape through the same rule {@link offsetTimeBinding} states. */
const offsetDateTimeBinding: Binding<OffsetDateTime> = bridge<OffsetDateTime, PlainDateTime>(
  atom<PlainDateTime>('datetime'),
  (dt) => ({
    date: dt.date,
    time: {
      hour: dt.time.hour,
      minute: dt.time.minute,
      second: dt.time.second,
      nanosecond: dt.time.nanosecond,
      offset: { totalMinutes: dt.offsetSeconds / 60 },
    },
  }),
  (w) => ({
    date: w.date,
    time: {
      hour: w.time.hour,
      minute: w.time.minute,
      second: w.time.second,
      nanosecond: w.time.nanosecond,
    },
    offsetSeconds: w.time.offset.totalMinutes * 60,
  }),
);

/**
 * meta-kernel's `token` primitive (§4.2, §9): the canonical NFC-normalised lexeme, text plus the
 * form that produced it. §8's resolved form is a bare scalar (the same escape hatch `value`/`void`
 * share), which is why the Java original registers {@link Token} as an atom rather than binding it
 * as a two-field record (`TsonAtomContext`'s own comment: "binding it structurally writes it as
 * `{ text: ... form: ... }`... where §8's resolved form has a scalar"). `form`'s casing differs
 * from the lexer's own ({@link TokenForm}'s `UNQUOTED`/... vs. `AtomToken`'s lower-kebab forms);
 * the bridge is exactly that remap.
 */
const tokenFormFromWire: Record<LexerTokenForm, TokenForm> = {
  unquoted: 'UNQUOTED',
  'single-line': 'SINGLE_LINE_QUOTED',
  'multi-line': 'MULTI_LINE_QUOTED',
};
const tokenFormToWire: Record<TokenForm, LexerTokenForm> = {
  UNQUOTED: 'unquoted',
  SINGLE_LINE_QUOTED: 'single-line',
  MULTI_LINE_QUOTED: 'multi-line',
};
const tokenBinding: Binding<Token> = bridge<Token, AtomToken>(
  atom<AtomToken>('token'),
  (t) => ({ text: t.text, form: tokenFormToWire[t.form] }),
  (w) => ({ text: w.text, form: tokenFormFromWire[w.form] }),
);

/** meta-kernel's own escape hatch (§4.2): base-type-resolution's result, uninterpreted -- the host value carries no further constraint, hence `unknown`. */
const valueBinding: Binding<unknown> = atom<unknown>('value');

// -------------------------------------------------------------------------------------------
// Internal enumerations
// -------------------------------------------------------------------------------------------

const typeKindBinding: Binding<TypeKind> = atom<TypeKind>('type_kind');
const fieldStateBinding: Binding<FieldState> = atom<FieldState>('field_state');
const elementStateBinding: Binding<ElementState> = atom<ElementState>('element_state');
const complexComponentBinding: Binding<ComplexComponent> =
  atom<ComplexComponent>('complex_component');
const floatFormatBinding: Binding<FloatFormat> = atom<FloatFormat>('ieee_format');
const binaryEncodingBinding: Binding<BinaryEncoding> = atom<BinaryEncoding>('binary_encoding');

/**
 * §8.1's own addition to `type_definition`, not a kernel field at all (`SourcePosition`'s own
 * doc). Ported from `SourcePositionStringBridge.java`'s `"line:column:byteOffset"` compact
 * string -- the same reasoning applies here: nothing in `schema/meta` may name a real lexer
 * position, so the wire shape is a plain string this module parses by hand.
 */
const sourcePositionBinding: Binding<SourcePosition> = bridge<SourcePosition, string>(
  textBinding,
  (p) => `${String(p.line)}:${String(p.column)}:${String(p.offset)}`,
  (s) => {
    const parts = s.split(':', 3);
    return {
      line: Number(parts[0]),
      column: Number(parts[1]),
      offset: Number(parts[2]),
    };
  },
);

// -------------------------------------------------------------------------------------------
// Unit / Annotation
// -------------------------------------------------------------------------------------------

/** meta-kernel's `unit => ~atom & {}` (§4.2): the empty ATOM body backing `value`/`token`/`void`. */
const unitBinding: RecordBinding<Unit> = record<Unit>({
  fields: [],
  construct: () => ({ kind: 'unit' }),
});

/**
 * One `@name`/`@name:value` wire annotation (§3.1) -- `schema/meta`'s own local stand-in (see
 * `typedef.ts`'s module doc), never itself a `!type-ref`-tagged wire record: annotations arrive
 * through the `@...` prefix a reader captures at the position they annotate, not as an ordinary
 * `{ name, value }` value. Bound here only so {@link annotationsBinding} has an element binding to
 * carry -- see this file's own note on why `TypeRef`/`TypeDefinition`/`RecordField.annotations`
 * are bound as ordinary fields rather than through `RecordBinding.annotationsCarrier`.
 */
const annotationBinding: RecordBinding<Annotation> = record<Annotation>({
  fields: [
    field<Annotation, 'name'>(0, 'name', 'name', identifierBinding),
    // `optional()` narrows through `NonNullable<Host[K]>`, which collapses `unknown | undefined`
    // to `{}` rather than `unknown` -- `valueBinding`'s own `Binding<unknown>` does not satisfy
    // that narrower type, so this slot is built with `field()` instead. Presence here is a
    // reader-level question (the annotation's own valueless-vs-`_`-valued distinction, see
    // `Annotation`'s own doc), not something this slot's `isPresent()` needs to answer.
    field<Annotation, 'value'>(1, 'value', 'value', valueBinding),
  ],
  construct: (slots) => {
    const [name, value] = slots as [string, unknown];
    return { name, ...opt('value', value) };
  },
});

/**
 * `Annotations` (`typedef.ts`'s own local stand-in, `readonly Annotation[]`) is a *different*
 * shape from `src/annotations/index.ts`'s own `Annotations` (`{ values: readonly Annotation[] }`)
 * -- the richer carrier `bind/binding.ts`'s `RecordBinding.annotationsCarrier`/
 * `RecordOptions.annotationsCarrier` are typed against. Using the `annotationsCarrier` mechanism
 * for this position would therefore not type-check against `schema/meta`'s own model; every
 * `annotations`-typed field below is bound as an ordinary {@link field}/{@link arrayOf} slot
 * instead. See this file's own report for the full note -- a genuine mismatch between two frozen
 * artefacts (`bind/binding.ts`, Wave 1; `schema/meta`, the A2 contract), not something this module
 * can resolve on its own authority.
 */
const annotationsBinding: Binding<Annotations> = arrayOf<Annotation>(annotationBinding);

// -------------------------------------------------------------------------------------------
// TypeRef / TypeArgument -- the one declaration-order cycle
// -------------------------------------------------------------------------------------------

// Explicitly typed ahead of its own initializer -- `typeArgumentBinding` (declared below) is
// referenced from inside this one via `lazy()`, and TypeScript must know this declaration's type
// before that reference can resolve (`combinators.ts`'s own `lazy()` doc walks through exactly
// this "ergonomics cliff").
const typeRefBinding: RecordBinding<TypeRef> = record<TypeRef>({
  fields: [
    field<TypeRef, 'name'>(0, 'name', 'name', identifierBinding),
    field<TypeRef, 'arguments'>(
      1,
      'arguments',
      'arguments',
      arrayOf<TypeArgument>(lazy((): Binding<TypeArgument> => typeArgumentBinding)),
    ),
    field<TypeRef, 'annotations'>(2, 'annotations', 'annotations', annotationsBinding),
  ],
  construct: (slots) => {
    const [name, args, annotations] = slots as [string, readonly TypeArgument[], Annotations];
    return { name, arguments: args, annotations };
  },
});

/** `type_argument.Ref`'s single component is `@Field("name") TypeRef ref` (`TypeArgument.java`) -- the wire name is `name`, the host key `ref`. */
const typeArgumentRefBinding: RecordBinding<TypeArgumentRef> = record<TypeArgumentRef>({
  fields: [
    field<TypeArgumentRef, 'ref'>(
      0,
      'name',
      'ref',
      lazy((): Binding<TypeRef> => typeRefBinding),
    ),
  ],
  construct: (slots) => {
    const [ref] = slots as [TypeRef];
    return { kind: 'ref', ref };
  },
});

const typeArgumentValueBinding: RecordBinding<TypeArgumentValue> = record<TypeArgumentValue>({
  fields: [field<TypeArgumentValue, 'value'>(0, 'value', 'value', tokenBinding)],
  construct: (slots) => {
    const [value] = slots as [Token];
    return { kind: 'value', value };
  },
});

/**
 * `type_argument`'s REQUIRED field *group* (§5.11): exactly one of `name`/`value` present, never
 * both. `variant()`'s ordinary member-key convention names a wire *type*; here the two members are
 * a field-group choice, not two named types a `!type-ref` picks between, so the member keys below
 * are this union's own TypeScript discriminant values (`'ref'`/`'value'`) rather than a wire type
 * name -- documented here since it is a real departure from every other `variant()` use in this
 * file, all of which key by the wire's own `!type-ref` name (see {@link topBinding}).
 */
const typeArgumentBinding: VariantBinding<TypeArgument> = variant(
  { ref: typeArgumentRefBinding, value: typeArgumentValueBinding },
  'kind',
);

// -------------------------------------------------------------------------------------------
// Reference / Extern / UnknownType
// -------------------------------------------------------------------------------------------

const referenceBinding: RecordBinding<Reference> = record<Reference>({
  fields: [
    field<Reference, 'target'>(
      0,
      'target',
      'target',
      lazy((): Binding<TypeRef> => typeRefBinding),
    ),
  ],
  construct: (slots) => {
    const [target] = slots as [TypeRef];
    return { kind: 'reference', target };
  },
});

const externBinding: RecordBinding<Extern> = record<Extern>({
  fields: [
    field<Extern, 'schema'>(0, 'schema', 'schema', textBinding),
    field<Extern, 'types'>(1, 'types', 'types', arrayOf<string>(identifierBinding)),
  ],
  construct: (slots) => {
    const [schemaUri, types] = slots as [string, readonly string[]];
    return { kind: 'extern', schema: schemaUri, types };
  },
});

const unknownTypeBinding: RecordBinding<UnknownType> = record<UnknownType>({
  fields: [],
  construct: () => ({ kind: 'unknown_type' }),
});

// -------------------------------------------------------------------------------------------
// bodies.ts -- record_field / field_group / tuple_element / the five composite bodies
// -------------------------------------------------------------------------------------------

const integerSizeBinding: RecordBinding<IntegerSize> = record<IntegerSize>({
  fields: [
    field<IntegerSize, 'bits'>(0, 'bits', 'bits', bigintBinding),
    field<IntegerSize, 'signed'>(1, 'signed', 'signed', booleanBinding),
  ],
  construct: (slots) => {
    const [bits, signed] = slots as [bigint, boolean];
    return { bits, signed };
  },
});

const recordFieldBinding: RecordBinding<RecordField> = record<RecordField>({
  fields: [
    field<RecordField, 'name'>(0, 'name', 'name', identifierBinding),
    field<RecordField, 'type'>(
      1,
      'type',
      'type',
      lazy((): Binding<TypeRef> => typeRefBinding),
    ),
    field<RecordField, 'state'>(2, 'state', 'state', fieldStateBinding),
    optional<RecordField, 'value'>(3, 'value', 'value', tokenBinding),
    field<RecordField, 'annotations'>(4, 'annotations', 'annotations', annotationsBinding),
  ],
  construct: (slots) => {
    const [name, type, state, value, annotations] = slots as [
      string,
      TypeRef,
      FieldState,
      Token | undefined,
      Annotations,
    ];
    return { name, type, state, ...opt('value', value), annotations };
  },
});

const fieldGroupBinding: RecordBinding<FieldGroup> = record<FieldGroup>({
  fields: [
    field<FieldGroup, 'members'>(0, 'members', 'members', arrayOf<string>(identifierBinding)),
    field<FieldGroup, 'state'>(1, 'state', 'state', elementStateBinding),
  ],
  construct: (slots) => {
    const [members, state] = slots as [readonly string[], ElementState];
    return { members, state };
  },
});

const tupleElementBinding: RecordBinding<TupleElement> = record<TupleElement>({
  fields: [
    field<TupleElement, 'elementType'>(
      0,
      'element_type',
      'elementType',
      lazy((): Binding<TypeRef> => typeRefBinding),
    ),
    field<TupleElement, 'state'>(1, 'state', 'state', elementStateBinding),
  ],
  construct: (slots) => {
    const [elementType, state] = slots as [TypeRef, ElementState];
    return { elementType, state };
  },
});

const recordBodyBinding: RecordBinding<RecordBody> = record<RecordBody>({
  fields: [
    field<RecordBody, 'supertypes'>(
      0,
      'supertypes',
      'supertypes',
      arrayOf<string>(identifierBinding),
    ),
    field<RecordBody, 'fields'>(1, 'fields', 'fields', arrayOf<RecordField>(recordFieldBinding)),
    field<RecordBody, 'groups'>(2, 'groups', 'groups', arrayOf<FieldGroup>(fieldGroupBinding)),
  ],
  construct: (slots) => {
    const [supertypes, fields, groups] = slots as [
      readonly string[],
      readonly RecordField[],
      readonly FieldGroup[],
    ];
    return { kind: 'record', supertypes, fields, groups };
  },
});

const arrayBodyBinding: RecordBinding<ArrayBody> = record<ArrayBody>({
  fields: [
    field<ArrayBody, 'elementType'>(
      0,
      'element_type',
      'elementType',
      lazy((): Binding<TypeRef> => typeRefBinding),
    ),
    field<ArrayBody, 'state'>(1, 'state', 'state', elementStateBinding),
    field<ArrayBody, 'unordered'>(2, 'unordered', 'unordered', booleanBinding),
    field<ArrayBody, 'uniqueItems'>(3, 'unique_items', 'uniqueItems', booleanBinding),
    optional<ArrayBody, 'minItems'>(4, 'min_items', 'minItems', bigintBinding),
    optional<ArrayBody, 'maxItems'>(5, 'max_items', 'maxItems', bigintBinding),
  ],
  construct: (slots) => {
    const [elementType, state, unordered, uniqueItems, minItems, maxItems] = slots as [
      TypeRef,
      ElementState,
      boolean,
      boolean,
      bigint | undefined,
      bigint | undefined,
    ];
    return {
      kind: 'array',
      elementType,
      state,
      unordered,
      uniqueItems,
      ...opt('minItems', minItems),
      ...opt('maxItems', maxItems),
    };
  },
});

const mapBodyBinding: RecordBinding<MapBody> = record<MapBody>({
  fields: [
    field<MapBody, 'keyType'>(
      0,
      'key_type',
      'keyType',
      lazy((): Binding<TypeRef> => typeRefBinding),
    ),
    field<MapBody, 'valueType'>(
      1,
      'value_type',
      'valueType',
      lazy((): Binding<TypeRef> => typeRefBinding),
    ),
    optional<MapBody, 'minItems'>(2, 'min_items', 'minItems', bigintBinding),
    optional<MapBody, 'maxItems'>(3, 'max_items', 'maxItems', bigintBinding),
  ],
  construct: (slots) => {
    const [keyType, valueType, minItems, maxItems] = slots as [
      TypeRef,
      TypeRef,
      bigint | undefined,
      bigint | undefined,
    ];
    return {
      kind: 'map',
      keyType,
      valueType,
      ...opt('minItems', minItems),
      ...opt('maxItems', maxItems),
    };
  },
});

const tupleBodyBinding: RecordBinding<TupleBody> = record<TupleBody>({
  fields: [
    field<TupleBody, 'elements'>(
      0,
      'elements',
      'elements',
      arrayOf<TupleElement>(tupleElementBinding),
    ),
  ],
  construct: (slots) => {
    const [elements] = slots as [readonly TupleElement[]];
    return { kind: 'tuple', elements };
  },
});

const choiceBodyBinding: RecordBinding<ChoiceBody> = record<ChoiceBody>({
  fields: [
    field<ChoiceBody, 'variants'>(
      0,
      'variants',
      'variants',
      arrayOf<TypeRef>(lazy((): Binding<TypeRef> => typeRefBinding)),
    ),
  ],
  construct: (slots) => {
    const [variants] = slots as [readonly TypeRef[]];
    return { kind: 'choice', variants };
  },
});

const enumBodyBinding: RecordBinding<EnumBody> = record<EnumBody>({
  fields: [field<EnumBody, 'members'>(0, 'members', 'members', arrayOf<string>(identifierBinding))],
  construct: (slots) => {
    const [members] = slots as [readonly string[]];
    return { kind: 'enum', members };
  },
});

// -------------------------------------------------------------------------------------------
// atoms-numeric.ts
// -------------------------------------------------------------------------------------------

const integerTypeBinding: RecordBinding<IntegerType> = record<IntegerType>({
  fields: [
    optional<IntegerType, 'size'>(0, 'size', 'size', integerSizeBinding),
    optional<IntegerType, 'min'>(1, 'min', 'min', bigintBinding),
    optional<IntegerType, 'exclusiveMin'>(2, 'exclusive_min', 'exclusiveMin', bigintBinding),
    optional<IntegerType, 'max'>(3, 'max', 'max', bigintBinding),
    optional<IntegerType, 'exclusiveMax'>(4, 'exclusive_max', 'exclusiveMax', bigintBinding),
    optional<IntegerType, 'multipleOf'>(5, 'multiple_of', 'multipleOf', bigintBinding),
  ],
  construct: (slots) => {
    const [size, min, exclusiveMin, max, exclusiveMax, multipleOf] = slots as [
      IntegerSize | undefined,
      bigint | undefined,
      bigint | undefined,
      bigint | undefined,
      bigint | undefined,
      bigint | undefined,
    ];
    return {
      kind: 'integer_type',
      ...opt('size', size),
      ...opt('min', min),
      ...opt('exclusiveMin', exclusiveMin),
      ...opt('max', max),
      ...opt('exclusiveMax', exclusiveMax),
      ...opt('multipleOf', multipleOf),
    };
  },
});

const floatTypeBinding: RecordBinding<FloatType> = record<FloatType>({
  fields: [
    field<FloatType, 'format'>(0, 'format', 'format', floatFormatBinding),
    optional<FloatType, 'min'>(1, 'min', 'min', decimalBinding),
    optional<FloatType, 'exclusiveMin'>(2, 'exclusive_min', 'exclusiveMin', decimalBinding),
    optional<FloatType, 'max'>(3, 'max', 'max', decimalBinding),
    optional<FloatType, 'exclusiveMax'>(4, 'exclusive_max', 'exclusiveMax', decimalBinding),
    field<FloatType, 'allowNan'>(5, 'allow_nan', 'allowNan', booleanBinding),
    field<FloatType, 'allowInfinity'>(6, 'allow_infinity', 'allowInfinity', booleanBinding),
    field<FloatType, 'allowSubnormal'>(7, 'allow_subnormal', 'allowSubnormal', booleanBinding),
    field<FloatType, 'allowNegativeZero'>(
      8,
      'allow_negative_zero',
      'allowNegativeZero',
      booleanBinding,
    ),
  ],
  construct: (slots) => {
    const [
      format,
      min,
      exclusiveMin,
      max,
      exclusiveMax,
      allowNan,
      allowInfinity,
      allowSubnormal,
      allowNegativeZero,
    ] = slots as [
      FloatFormat,
      Decimal | undefined,
      Decimal | undefined,
      Decimal | undefined,
      Decimal | undefined,
      boolean,
      boolean,
      boolean,
      boolean,
    ];
    return {
      kind: 'float_type',
      format,
      ...opt('min', min),
      ...opt('exclusiveMin', exclusiveMin),
      ...opt('max', max),
      ...opt('exclusiveMax', exclusiveMax),
      allowNan,
      allowInfinity,
      allowSubnormal,
      allowNegativeZero,
    };
  },
});

const decimalTypeBinding: RecordBinding<DecimalType> = record<DecimalType>({
  fields: [
    optional<DecimalType, 'min'>(0, 'min', 'min', decimalBinding),
    optional<DecimalType, 'exclusiveMin'>(1, 'exclusive_min', 'exclusiveMin', decimalBinding),
    optional<DecimalType, 'max'>(2, 'max', 'max', decimalBinding),
    optional<DecimalType, 'exclusiveMax'>(3, 'exclusive_max', 'exclusiveMax', decimalBinding),
    optional<DecimalType, 'multipleOf'>(4, 'multiple_of', 'multipleOf', decimalBinding),
    optional<DecimalType, 'totalDigits'>(5, 'total_digits', 'totalDigits', int32Binding),
    optional<DecimalType, 'fractionDigits'>(6, 'fraction_digits', 'fractionDigits', int32Binding),
  ],
  construct: (slots) => {
    const [min, exclusiveMin, max, exclusiveMax, multipleOf, totalDigits, fractionDigits] =
      slots as [
        Decimal | undefined,
        Decimal | undefined,
        Decimal | undefined,
        Decimal | undefined,
        Decimal | undefined,
        number | undefined,
        number | undefined,
      ];
    return {
      kind: 'decimal_type',
      ...opt('min', min),
      ...opt('exclusiveMin', exclusiveMin),
      ...opt('max', max),
      ...opt('exclusiveMax', exclusiveMax),
      ...opt('multipleOf', multipleOf),
      ...opt('totalDigits', totalDigits),
      ...opt('fractionDigits', fractionDigits),
    };
  },
});

const rationalTypeBinding: RecordBinding<RationalType> = record<RationalType>({
  fields: [
    optional<RationalType, 'min'>(0, 'min', 'min', rationalBinding),
    optional<RationalType, 'exclusiveMin'>(1, 'exclusive_min', 'exclusiveMin', rationalBinding),
    optional<RationalType, 'max'>(2, 'max', 'max', rationalBinding),
    optional<RationalType, 'exclusiveMax'>(3, 'exclusive_max', 'exclusiveMax', rationalBinding),
    optional<RationalType, 'multipleOf'>(4, 'multiple_of', 'multipleOf', rationalBinding),
  ],
  construct: (slots) => {
    const [min, exclusiveMin, max, exclusiveMax, multipleOf] = slots as [
      Rational | undefined,
      Rational | undefined,
      Rational | undefined,
      Rational | undefined,
      Rational | undefined,
    ];
    return {
      kind: 'rational_type',
      ...opt('min', min),
      ...opt('exclusiveMin', exclusiveMin),
      ...opt('max', max),
      ...opt('exclusiveMax', exclusiveMax),
      ...opt('multipleOf', multipleOf),
    };
  },
});

const complexTypeBinding: RecordBinding<ComplexType> = record<ComplexType>({
  fields: [field<ComplexType, 'component'>(0, 'component', 'component', complexComponentBinding)],
  construct: (slots) => {
    const [component] = slots as [ComplexComponent];
    return { kind: 'complex_type', component };
  },
});

// -------------------------------------------------------------------------------------------
// atoms-text.ts
// -------------------------------------------------------------------------------------------

const textTypeBinding: RecordBinding<TextType> = record<TextType>({
  fields: [
    optional<TextType, 'minLength'>(0, 'min_length', 'minLength', int32Binding),
    optional<TextType, 'maxLength'>(1, 'max_length', 'maxLength', int32Binding),
    optional<TextType, 'length'>(2, 'length', 'length', int32Binding),
    optional<TextType, 'pattern'>(3, 'pattern', 'pattern', textBinding),
  ],
  construct: (slots) => {
    const [minLength, maxLength, length, pattern] = slots as [
      number | undefined,
      number | undefined,
      number | undefined,
      string | undefined,
    ];
    return {
      kind: 'text_type',
      ...opt('minLength', minLength),
      ...opt('maxLength', maxLength),
      ...opt('length', length),
      ...opt('pattern', pattern),
    };
  },
});

const binaryTypeBinding: RecordBinding<BinaryType> = record<BinaryType>({
  fields: [
    field<BinaryType, 'encoding'>(0, 'encoding', 'encoding', binaryEncodingBinding),
    optional<BinaryType, 'minLength'>(1, 'min_length', 'minLength', int32Binding),
    optional<BinaryType, 'maxLength'>(2, 'max_length', 'maxLength', int32Binding),
  ],
  construct: (slots) => {
    const [encoding, minLength, maxLength] = slots as [
      BinaryEncoding,
      number | undefined,
      number | undefined,
    ];
    return {
      kind: 'binary',
      encoding,
      ...opt('minLength', minLength),
      ...opt('maxLength', maxLength),
    };
  },
});

const regexTypeBinding: RecordBinding<RegexType> = record<RegexType>({
  fields: [
    field<RegexType, 'spec'>(0, 'spec', 'spec', textBinding),
    optional<RegexType, 'minLength'>(1, 'min_length', 'minLength', int32Binding),
    optional<RegexType, 'maxLength'>(2, 'max_length', 'maxLength', int32Binding),
    optional<RegexType, 'length'>(3, 'length', 'length', int32Binding),
    optional<RegexType, 'pattern'>(4, 'pattern', 'pattern', textBinding),
  ],
  construct: (slots) => {
    const [spec, minLength, maxLength, length, pattern] = slots as [
      string,
      number | undefined,
      number | undefined,
      number | undefined,
      string | undefined,
    ];
    return {
      kind: 'regex_type',
      spec,
      ...opt('minLength', minLength),
      ...opt('maxLength', maxLength),
      ...opt('length', length),
      ...opt('pattern', pattern),
    };
  },
});

const uriTypeBinding: RecordBinding<UriType> = record<UriType>({
  fields: [
    field<UriType, 'spec'>(0, 'spec', 'spec', textBinding),
    optional<UriType, 'minLength'>(1, 'min_length', 'minLength', int32Binding),
    optional<UriType, 'maxLength'>(2, 'max_length', 'maxLength', int32Binding),
    optional<UriType, 'length'>(3, 'length', 'length', int32Binding),
    optional<UriType, 'pattern'>(4, 'pattern', 'pattern', textBinding),
    optional<UriType, 'scheme'>(5, 'scheme', 'scheme', textBinding),
  ],
  construct: (slots) => {
    const [spec, minLength, maxLength, length, pattern, scheme] = slots as [
      string,
      number | undefined,
      number | undefined,
      number | undefined,
      string | undefined,
      string | undefined,
    ];
    return {
      kind: 'uri_type',
      spec,
      ...opt('minLength', minLength),
      ...opt('maxLength', maxLength),
      ...opt('length', length),
      ...opt('pattern', pattern),
      ...opt('scheme', scheme),
    };
  },
});

const emailTypeBinding: RecordBinding<EmailType> = record<EmailType>({
  fields: [
    field<EmailType, 'spec'>(0, 'spec', 'spec', textBinding),
    optional<EmailType, 'minLength'>(1, 'min_length', 'minLength', int32Binding),
    optional<EmailType, 'maxLength'>(2, 'max_length', 'maxLength', int32Binding),
    optional<EmailType, 'length'>(3, 'length', 'length', int32Binding),
    optional<EmailType, 'pattern'>(4, 'pattern', 'pattern', textBinding),
  ],
  construct: (slots) => {
    const [spec, minLength, maxLength, length, pattern] = slots as [
      string,
      number | undefined,
      number | undefined,
      number | undefined,
      string | undefined,
    ];
    return {
      kind: 'email_type',
      spec,
      ...opt('minLength', minLength),
      ...opt('maxLength', maxLength),
      ...opt('length', length),
      ...opt('pattern', pattern),
    };
  },
});

const uuidTypeBinding: RecordBinding<UuidType> = record<UuidType>({
  fields: [optional<UuidType, 'version'>(0, 'version', 'version', int32Binding)],
  construct: (slots) => {
    const [version] = slots as [number | undefined];
    return { kind: 'uuid_type', ...opt('version', version) };
  },
});

// -------------------------------------------------------------------------------------------
// atoms-temporal.ts
// -------------------------------------------------------------------------------------------

const dateTypeBinding: RecordBinding<DateType> = record<DateType>({
  fields: [
    optional<DateType, 'min'>(0, 'min', 'min', calendarDateBinding),
    optional<DateType, 'max'>(1, 'max', 'max', calendarDateBinding),
  ],
  construct: (slots) => {
    const [min, max] = slots as [CalendarDate | undefined, CalendarDate | undefined];
    return { kind: 'date_type', ...opt('min', min), ...opt('max', max) };
  },
});

const timeTypeBinding: RecordBinding<TimeType> = record<TimeType>({
  fields: [
    optional<TimeType, 'min'>(0, 'min', 'min', offsetTimeBinding),
    optional<TimeType, 'max'>(1, 'max', 'max', offsetTimeBinding),
    optional<TimeType, 'precision'>(2, 'precision', 'precision', bigintBinding),
    optional<TimeType, 'requireTimezone'>(3, 'require_timezone', 'requireTimezone', booleanBinding),
  ],
  construct: (slots) => {
    const [min, max, precision, requireTimezone] = slots as [
      OffsetTime | undefined,
      OffsetTime | undefined,
      bigint | undefined,
      boolean | undefined,
    ];
    return {
      kind: 'time_type',
      ...opt('min', min),
      ...opt('max', max),
      ...opt('precision', precision),
      ...opt('requireTimezone', requireTimezone),
    };
  },
});

const dateTimeTypeBinding: RecordBinding<DateTimeType> = record<DateTimeType>({
  fields: [
    optional<DateTimeType, 'min'>(0, 'min', 'min', offsetDateTimeBinding),
    optional<DateTimeType, 'max'>(1, 'max', 'max', offsetDateTimeBinding),
    optional<DateTimeType, 'precision'>(2, 'precision', 'precision', bigintBinding),
    optional<DateTimeType, 'requireTimezone'>(
      3,
      'require_timezone',
      'requireTimezone',
      booleanBinding,
    ),
  ],
  construct: (slots) => {
    const [min, max, precision, requireTimezone] = slots as [
      OffsetDateTime | undefined,
      OffsetDateTime | undefined,
      bigint | undefined,
      boolean | undefined,
    ];
    return {
      kind: 'datetime_type',
      ...opt('min', min),
      ...opt('max', max),
      ...opt('precision', precision),
      ...opt('requireTimezone', requireTimezone),
    };
  },
});

/**
 * Unlike {@link dateTypeBinding}/{@link timeTypeBinding}, `min`/`max` here stay raw ISO 8601 text
 * (`DurationType`'s own doc: "deliberately... to avoid the same host-value dependency"), matching
 * `DurationType.java`'s `Optional<String>` fields exactly rather than parsing through the
 * `duration` atom's own structured host value. `textBinding` (not a `duration`-family atom) is
 * the honest label for that: this position is deliberately never parsed.
 */
const durationTypeBinding: RecordBinding<DurationType> = record<DurationType>({
  fields: [
    optional<DurationType, 'min'>(0, 'min', 'min', textBinding),
    optional<DurationType, 'max'>(1, 'max', 'max', textBinding),
  ],
  construct: (slots) => {
    const [min, max] = slots as [string | undefined, string | undefined];
    return { kind: 'duration_type', ...opt('min', min), ...opt('max', max) };
  },
});

// -------------------------------------------------------------------------------------------
// atoms-network.ts
// -------------------------------------------------------------------------------------------

const ipv4TypeBinding: RecordBinding<Ipv4Type> = record<Ipv4Type>({
  fields: [
    field<Ipv4Type, 'spec'>(0, 'spec', 'spec', textBinding),
    field<Ipv4Type, 'within'>(1, 'within', 'within', arrayOf<string>(textBinding)),
    field<Ipv4Type, 'excluding'>(2, 'excluding', 'excluding', arrayOf<string>(textBinding)),
  ],
  construct: (slots) => {
    const [spec, within, excluding] = slots as [string, readonly string[], readonly string[]];
    return { kind: 'ipv4_type', spec, within, excluding };
  },
});

const ipv6TypeBinding: RecordBinding<Ipv6Type> = record<Ipv6Type>({
  fields: [
    field<Ipv6Type, 'spec'>(0, 'spec', 'spec', textBinding),
    field<Ipv6Type, 'within'>(1, 'within', 'within', arrayOf<string>(textBinding)),
    field<Ipv6Type, 'excluding'>(2, 'excluding', 'excluding', arrayOf<string>(textBinding)),
  ],
  construct: (slots) => {
    const [spec, within, excluding] = slots as [string, readonly string[], readonly string[]];
    return { kind: 'ipv6_type', spec, within, excluding };
  },
});

const cidr4TypeBinding: RecordBinding<Cidr4Type> = record<Cidr4Type>({
  fields: [
    field<Cidr4Type, 'spec'>(0, 'spec', 'spec', textBinding),
    optional<Cidr4Type, 'minPrefix'>(1, 'min_prefix', 'minPrefix', int32Binding),
    optional<Cidr4Type, 'maxPrefix'>(2, 'max_prefix', 'maxPrefix', int32Binding),
    field<Cidr4Type, 'within'>(3, 'within', 'within', arrayOf<string>(textBinding)),
    field<Cidr4Type, 'excluding'>(4, 'excluding', 'excluding', arrayOf<string>(textBinding)),
  ],
  construct: (slots) => {
    const [spec, minPrefix, maxPrefix, within, excluding] = slots as [
      string,
      number | undefined,
      number | undefined,
      readonly string[],
      readonly string[],
    ];
    return {
      kind: 'cidr4_type',
      spec,
      ...opt('minPrefix', minPrefix),
      ...opt('maxPrefix', maxPrefix),
      within,
      excluding,
    };
  },
});

const cidr6TypeBinding: RecordBinding<Cidr6Type> = record<Cidr6Type>({
  fields: [
    field<Cidr6Type, 'spec'>(0, 'spec', 'spec', textBinding),
    optional<Cidr6Type, 'minPrefix'>(1, 'min_prefix', 'minPrefix', int32Binding),
    optional<Cidr6Type, 'maxPrefix'>(2, 'max_prefix', 'maxPrefix', int32Binding),
    field<Cidr6Type, 'within'>(3, 'within', 'within', arrayOf<string>(textBinding)),
    field<Cidr6Type, 'excluding'>(4, 'excluding', 'excluding', arrayOf<string>(textBinding)),
  ],
  construct: (slots) => {
    const [spec, minPrefix, maxPrefix, within, excluding] = slots as [
      string,
      number | undefined,
      number | undefined,
      readonly string[],
      readonly string[],
    ];
    return {
      kind: 'cidr6_type',
      spec,
      ...opt('minPrefix', minPrefix),
      ...opt('maxPrefix', maxPrefix),
      within,
      excluding,
    };
  },
});

const macTypeBinding: RecordBinding<MacType> = record<MacType>({
  fields: [field<MacType, 'spec'>(0, 'spec', 'spec', textBinding)],
  construct: (slots) => {
    const [spec] = slots as [string];
    return { kind: 'mac_type', spec };
  },
});

// -------------------------------------------------------------------------------------------
// Top -- the polymorphic `type_definition.body`
// -------------------------------------------------------------------------------------------

/**
 * `type_definition.body: top` (§4.1, §8.1) -- the wire's own `!type-ref` before the value picks
 * the member (§3.1), confirmed directly against `spec/m/*-resolved.tn`: `token_set`'s body reads
 * `!set { element_type: token }`, not `!array { ... }`, even though `set` shares {@link ArrayBody}'s
 * shape rather than declaring one of its own -- both wire names below resolve to
 * {@link arrayBodyBinding}. `value`/`token`/`void` are the three instances of {@link unitBinding}
 * (confirmed the same way: all three read `body: !unit {}}` in `meta-kernel-resolved.tn`).
 *
 * `data` (the meta layer's open extension point) and the held `TemplateBody` (§5.10, which "never
 * serialises and carries no `kind` tag" -- `Top`'s own doc) both have no member here: neither is
 * exercised by any bundled fixture, and `TemplateBody`'s own doc says outright that a resolved
 * output consumer never meets one. `Top` itself still names both, so the const below is typed
 * `VariantBinding<Top>` explicitly -- a narrower union in {@link BindingBase}'s covariant phantom
 * position is a subtype of the wider one, so the explicit annotation upcasts safely with no
 * assertion of its own.
 */
const topBinding: VariantBinding<Top> = variant(
  {
    record: recordBodyBinding,
    array: arrayBodyBinding,
    set: arrayBodyBinding,
    map: mapBodyBinding,
    tuple: tupleBodyBinding,
    choice: choiceBodyBinding,
    enum: enumBodyBinding,
    unit: unitBinding,
    value: unitBinding,
    token: unitBinding,
    void: unitBinding,
    reference: referenceBinding,
    unknown_type: unknownTypeBinding,
    extern: externBinding,
    integer_type: integerTypeBinding,
    float_type: floatTypeBinding,
    decimal_type: decimalTypeBinding,
    rational_type: rationalTypeBinding,
    complex_type: complexTypeBinding,
    text_type: textTypeBinding,
    binary: binaryTypeBinding,
    regex_type: regexTypeBinding,
    uri_type: uriTypeBinding,
    email_type: emailTypeBinding,
    uuid_type: uuidTypeBinding,
    date_type: dateTypeBinding,
    time_type: timeTypeBinding,
    datetime_type: dateTimeTypeBinding,
    duration_type: durationTypeBinding,
    ipv4_type: ipv4TypeBinding,
    ipv6_type: ipv6TypeBinding,
    cidr4_type: cidr4TypeBinding,
    cidr6_type: cidr6TypeBinding,
    mac_type: macTypeBinding,
  },
  // Discriminated on the host value's own `kind`. Without a discriminant (and with no per-member
  // test) `memberFor` can only ever return undefined, which bind/binding.ts defines as a write
  // error — so `type_definition.body`, the one polymorphic slot in the whole resolved-schema
  // model, could be read but never written.
  //
  // Every host kind has a member of the same name. The extra members are read-only wire aliases:
  // `set` is written as an array body (its set-ness lives in `unordered`), and `value`/`token`/
  // `void` share the unit binding. Reading still reaches them through byWireName.
  'kind',
);

// -------------------------------------------------------------------------------------------
// TypeDefinition
// -------------------------------------------------------------------------------------------

/**
 * `position` is `@Unbound` in the Java original (`TypeDefinition.java`'s own doc): the kernel's
 * `type_definition` declares no such field, so it must never be matched against the wire by name.
 * `FieldSlot.unbound` is exactly that declaration; the slot is built from {@link optional} (same
 * presence/get semantics any other optional field needs for round-tripping) and then has
 * `unbound` overridden `true`, the same pattern `bind-combinators.test.ts` itself demonstrates for
 * an annotations carrier.
 */
const positionSlot = {
  ...optional<TypeDefinition, 'position'>(8, 'position', 'position', sourcePositionBinding),
  unbound: true,
};

const typeDefinitionBinding: RecordBinding<TypeDefinition> = record<TypeDefinition>({
  fields: [
    optional<TypeDefinition, 'source'>(
      0,
      'source',
      'source',
      lazy((): Binding<TypeRef> => typeRefBinding),
    ),
    field<TypeDefinition, 'kind'>(1, 'kind', 'kind', typeKindBinding),
    field<TypeDefinition, 'parameters'>(
      2,
      'parameters',
      'parameters',
      arrayOf<string>(identifierBinding),
    ),
    field<TypeDefinition, 'constructor'>(3, 'constructor', 'constructor', booleanBinding),
    field<TypeDefinition, 'supertypes'>(
      4,
      'supertypes',
      'supertypes',
      arrayOf<string>(identifierBinding),
    ),
    field<TypeDefinition, 'subtypes'>(
      5,
      'subtypes',
      'subtypes',
      arrayOf<string>(identifierBinding),
    ),
    optional<TypeDefinition, 'disjoint'>(6, 'disjoint', 'disjoint', booleanBinding),
    field<TypeDefinition, 'body'>(7, 'body', 'body', topBinding),
    positionSlot,
    field<TypeDefinition, 'annotations'>(9, 'annotations', 'annotations', annotationsBinding),
  ],
  construct: (slots) => {
    const [
      source,
      kind,
      parameters,
      constructorFlag,
      supertypes,
      subtypes,
      disjoint,
      body,
      position,
      annotations,
    ] = slots as [
      TypeRef | undefined,
      TypeKind,
      readonly string[],
      boolean,
      readonly string[],
      readonly string[],
      boolean | undefined,
      Top,
      SourcePosition | undefined,
      Annotations,
    ];
    return {
      ...opt('source', source),
      kind,
      parameters,
      constructor: constructorFlag,
      supertypes,
      subtypes,
      ...opt('disjoint', disjoint),
      body,
      ...opt('position', position),
      annotations,
    };
  },
});

// -------------------------------------------------------------------------------------------
// Public surface
// -------------------------------------------------------------------------------------------

export {
  tokenFormFromWire,
  tokenFormToWire,
  unitBinding,
  rationalBinding,
  decimalBinding,
  calendarDateBinding,
  offsetTimeBinding,
  offsetDateTimeBinding,
  tokenBinding,
  valueBinding,
  identifierBinding,
  textBinding,
  booleanBinding,
  bigintBinding,
  int32Binding,
  typeKindBinding,
  fieldStateBinding,
  elementStateBinding,
  complexComponentBinding,
  floatFormatBinding,
  binaryEncodingBinding,
  sourcePositionBinding,
  annotationBinding,
  annotationsBinding,
  typeRefBinding,
  typeArgumentRefBinding,
  typeArgumentValueBinding,
  typeArgumentBinding,
  referenceBinding,
  externBinding,
  unknownTypeBinding,
  integerSizeBinding,
  recordFieldBinding,
  fieldGroupBinding,
  tupleElementBinding,
  recordBodyBinding,
  arrayBodyBinding,
  mapBodyBinding,
  tupleBodyBinding,
  choiceBodyBinding,
  enumBodyBinding,
  integerTypeBinding,
  floatTypeBinding,
  decimalTypeBinding,
  rationalTypeBinding,
  complexTypeBinding,
  textTypeBinding,
  binaryTypeBinding,
  regexTypeBinding,
  uriTypeBinding,
  emailTypeBinding,
  uuidTypeBinding,
  dateTypeBinding,
  timeTypeBinding,
  dateTimeTypeBinding,
  durationTypeBinding,
  ipv4TypeBinding,
  ipv6TypeBinding,
  cidr4TypeBinding,
  cidr6TypeBinding,
  macTypeBinding,
  topBinding,
  typeDefinitionBinding,
};

/**
 * A ready-to-use table keyed by the kernel's own constructor/instance names, the way
 * `SchemaMetaNameBinder.INSTANCE` resolves a schema type name to a Java class -- covering exactly
 * the wire names {@link topBinding} matches on, plus `type_definition` itself (the schema-map
 * value every `*-resolved.tn` entry is). A later work package building the real
 * `BindingRegistry`/reader wiring (definition resolution, linking) is free to `chain()` this
 * behind or in front of its own tables; this is deliberately not the full
 * `SchemaMetaNameBinder`-equivalent alias set (`field_name`/`type_name`/`param_name` -> `token`,
 * and the like) since those names are use-site aliases the reference flattener (§8.3) resolves
 * away before a value reaches this registry at all -- see this file's own report for the finding.
 */
export const metaBindings: BindingRegistry = registry({
  type_definition: typeDefinitionBinding,
  record: recordBodyBinding,
  array: arrayBodyBinding,
  set: arrayBodyBinding,
  map: mapBodyBinding,
  tuple: tupleBodyBinding,
  choice: choiceBodyBinding,
  enum: enumBodyBinding,
  unit: unitBinding,
  value: unitBinding,
  token: unitBinding,
  void: unitBinding,
  reference: referenceBinding,
  unknown_type: unknownTypeBinding,
  extern: externBinding,
  integer_type: integerTypeBinding,
  float_type: floatTypeBinding,
  decimal_type: decimalTypeBinding,
  rational_type: rationalTypeBinding,
  complex_type: complexTypeBinding,
  text_type: textTypeBinding,
  binary: binaryTypeBinding,
  regex_type: regexTypeBinding,
  uri_type: uriTypeBinding,
  email_type: emailTypeBinding,
  uuid_type: uuidTypeBinding,
  date_type: dateTypeBinding,
  time_type: timeTypeBinding,
  datetime_type: dateTimeTypeBinding,
  duration_type: durationTypeBinding,
  ipv4_type: ipv4TypeBinding,
  ipv6_type: ipv6TypeBinding,
  cidr4_type: cidr4TypeBinding,
  cidr6_type: cidr6TypeBinding,
  mac_type: macTypeBinding,
  integer_size: integerSizeBinding,
  record_field: recordFieldBinding,
  field_group: fieldGroupBinding,
  tuple_element: tupleElementBinding,
  type_ref: typeRefBinding,
  type_argument: typeArgumentBinding,
});
