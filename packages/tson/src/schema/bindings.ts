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
 * **The one declaration-order cycle** is a type slot and the bodies it may hold in place: `meta.type_expr`
 * holds a `meta.type_inline`, whose `of` is any type body, each of which may hold type slots. The slot's binding
 * reaches {@link topBinding} through a `lazy()`; every other edge resolves eagerly, top to bottom.
 */

import {
  annotated,
  array,
  bridge,
  field,
  lazy,
  map,
  optional,
  record,
  variant,
} from '../bind/combinators.js';
import { registry } from '../bind/registry.js';
import { applyNormalization } from '../unicode/normalization.js';
import type { FieldSlot } from '../bind/binding.js';
import type {
  AnnotatedBinding,
  ArrayBinding,
  AtomBinding,
  Binding,
  BindingRef,
  BindingRegistry,
  MapBinding,
  RecordBinding,
  VariantBinding,
} from '../bind/binding.js';
import type { Annotations as WireAnnotations } from '../annotations/index.js';
import type { DataValue } from '../ast/value.js';
import type { AtomToken } from '../atom/contract.js';
import type { TokenForm as LexerTokenForm } from '../lexer/token.js';
import type { PlainDateTime, PlainTime, TsonDecimal } from '../value/types.js';
import {
  tryParseNumber,
  tryParseRational,
  type NumberForm,
  type Sign,
} from '../base/numberGrammar.js';
import { toExactDecimal, toExactInteger } from '../base/numberNarrowing.js';
import { resolveBaseType } from '../base/baseTypeResolver.js';
import { TsonReadError } from '../core/errors.js';

import type { Decimal, DeclaredType, Rational, VoidType } from './meta/algebra.js';
import type {
  Alias,
  Annotation,
  Annotations,
  ApplyBody,
  DependentBody,
  Extern,
  Namespace,
  Param,
  Token,
  TokenForm,
  Type,
  TypeBase,
  TypeChain,
  TypeExpr,
  TypeInline,
  TypeRef,
  Top,
} from './meta/typedef.js';
import { EMPTY_CHAIN, isEmptyChain, typeChain, withChain } from './meta/typedef.js';
import { fieldMap } from './meta/bodies.js';
import { withParametersMarked } from './meta/typeInline.js';
import { constructorOf as constructorPath } from './meta/typedef.js';
import {
  NET_MAP,
  NUMERIC_MAP,
  TEMPORAL_MAP,
  UNICODE_MAP,
  BINARY_MAP,
  kernelName,
  metaName,
} from './meta/kernel.js';
import { isIdentifierText } from '../unicode/identifier-profile.js';
import type {
  ChoiceBody,
  EnumBody,
  FieldGroup,
  FieldRole,
  MapBody,
  NamespaceBody,
  RecordBody,
  RecordExtensionType,
  RecordField,
  RefBody,
  TupleBody,
  TupleElement,
  ArrayBody,
} from './meta/bodies.js';
import type {
  EmailType,
  IdentifierBase,
  IdentifierType,
  IriType,
  Normalization,
  RegexType,
  TextType,
  UriType,
  UuidType,
} from './meta/atoms-text.js';
import type { BytesEncoding, BytesType } from './meta/atoms-bytes.js';
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
  PeriodType,
  TimeType,
} from './meta/atoms-temporal.js';
import type {
  Cidr4Type,
  Cidr6Type,
  HostType,
  HostnameType,
  Ipv4Type,
  Ipv6Type,
  MacType,
  MediaTypeType,
} from './meta/atoms-network.js';
import type { SourcePosition } from './meta/position.js';
import { formatIsoDuration, tryParseIsoDuration } from '../atom/temporal/isoDuration.js';
import { formatIsoPeriod, tryParseIsoPeriod } from '../atom/temporal/isoPeriod.js';

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

/**
 * A slot resolved output leaves unwritten while it holds `value` (§8.1: "fields at their default
 * values are omitted"; a FIXED field at the value its constructor pins is the constructor's
 * statement, not the instance's). Reading is unaffected: absence means the pinned or default value
 * either way.
 */
function unwrittenAt<T>(slot: FieldSlot<T>, value: T): FieldSlot<T> {
  return { ...slot, isPresent: (host: unknown) => slot.get(host) !== value };
}

/** `array()` for the common "ordered list of `E`, host type `readonly E[]`" shape -- every list-shaped field in this model (`CLAUDE.md`'s "absent and empty are the same list" fields included: the emptiness is the reader's concern, not this binding's). */
function arrayOf<E>(element: BindingRef<E>): ArrayBinding<readonly E[]> {
  return array<readonly E[], E>({
    element,
    construct: (values) => values,
    read: (host) => host,
  });
}

/**
 * `inner` with the kernel's `type => abstract top & { chain?: type_chain }` field prepended (§4.1):
 * every type body carries its chain, first among its fields as the constructor's flattened shape
 * has it. A declaration never writes one, so reading a source body leaves it absent; resolved
 * output writes it wherever it states something.
 */
function typed<T extends TypeBase>(inner: RecordBinding<T>): RecordBinding<T> {
  const chainSlot: FieldSlot<TypeChain> = {
    index: 0,
    wireName: 'chain',
    key: 'chain',
    required: false,
    unbound: false,
    binding: lazy((): Binding<TypeChain> => typeChainBinding),
    isPresent: (host: unknown) => !isEmptyChain((host as TypeBase).chain),
    get: (host: unknown) => (host as TypeBase).chain ?? EMPTY_CHAIN,
  };
  return record<T>({
    fields: [chainSlot, ...inner.fields.map((slot) => ({ ...slot, index: slot.index + 1 }))],
    construct: (slots) => {
      const [chain, ...rest] = slots as [TypeChain | undefined, ...unknown[]];
      const body = inner.construct(rest);
      if (chain === undefined) return body;
      const chained = withChain(body as unknown as Top, chain);
      // A parametric record's parents' arguments are its parameters where it declares them (§5.10).
      return (chained.kind === 'record' && chained.parameters !== undefined
        ? withParametersMarked(chained)
        : chained) as unknown as T;
    },
  });
}

// -------------------------------------------------------------------------------------------
// Primitive atom leaves
// -------------------------------------------------------------------------------------------

/**
 * Free/quoted text -- the kernel's `text` (§5.7): a `spec`/`pattern`/CIDR-network/duration-bound
 * string, kept exactly as authored. Distinct from {@link identifierBinding}: this position's
 * value is prose or a foreign-document reference, never itself a name resolved against a
 * namespace.
 */
const textBinding: Binding<string> = atom<string>('text');

/**
 * A bare, unquoted lexeme used as a name -- the kernel's `type_name`/`param_name`, each an alias
 * of `identifier` in the resolved output, and a field's name. The
 * host value is the token's own text; `form` is not carried here (§7.4/§7.7's identifier grammar
 * -- `XID_Start` initial, `XID_Continue ∪ { - }` thereafter, in NFC -- is a strict subset of the
 * unquoted-token profile, so a well-formed identifier is never written quoted, and this
 * position's TypeScript type is a plain `string`, not {@link Token}) -- see {@link tokenBinding}
 * for the position that keeps `form` too.
 *
 * **Does not itself enforce the identifier grammar.** This binding reads/writes the raw token
 * text for the wire shape `type_name`/`param_name`/`enum_set` and a field's name share; validating that
 * text against §7.7's `XID_Start`/`XID_Continue` profile is the job of a dedicated `identifier`
 * atom parser (mirroring the Java reference's `IdentifierParser`, `atom/contract.ts`'s `AtomType`
 * shape) once one exists in this port -- see this module's own report for exactly where that
 * still needs to be wired in.
 */
const identifierBinding: Binding<string> = bridge<string, AtomToken>(
  atom<AtomToken>('identifier'),
  (text) => ({ text, form: 'unquoted' }),
  (wire) => wire.text,
);

/**
 * A declared field name -- a `field_map` key, a `discriminators` element, a field group's member
 * (§5.2, §12.1): any single-line token, judged at link by its record's name type, so its host
 * value is the token's decoded text. Written unquoted where it is an identifier and single-line
 * quoted otherwise (`"@id"`, `"first name"`), so a name that is no identifier reads back as
 * itself.
 */
const declaredNameBinding: Binding<string> = bridge<string, AtomToken>(
  atom<AtomToken>('identifier'),
  (text) => ({ text, form: isIdentifierText(text) ? 'unquoted' : 'single-line' }),
  (wire) => wire.text,
);

/**
 * A URI scheme (§5.5's `scheme_name`): text whose value is the text ASCII-folded, as RFC 3986 §3.1
 * compares a scheme. Only A-Z move, so a full-width letter reaches the coherence check unchanged
 * and is refused there as the non-scheme it is.
 */
const schemeNameBinding: Binding<string> = bridge<string, string>(
  textBinding,
  (scheme) => scheme,
  (wire) => applyNormalization('ASCII_CASEFOLD', wire),
);

const booleanBinding: Binding<boolean> = atom<boolean>('boolean');

/**
 * Arbitrary-precision `integer` (§5.6) -- the kernel's own unbounded integer, host `bigint`.
 * Every counting facet in this package's model (`minLength`, `totalDigits`, `version`, ...) is
 * `non_negative_integer`-typed on the wire, itself a refinement of this same `integer` (§9), and
 * `schema/meta`'s own types now bind every one of them to `bigint` rather than narrowing to
 * `number` the way an earlier revision's model did -- this leaf is used directly at every such
 * position, with no bridge in between.
 */
const bigintBinding: Binding<bigint> = atom<bigint>('integer');

/**
 * `numeric.count` (§5.5), the type of every facet that counts something -- a length, an item count, a digit
 * count, a prefix length, a precision: `!int64 ^ { min: 0 }`. Its range stops at 2^63-1 so that every
 * implementation holds a count in a native type. The host form is `bigint`; the range is judged where the wire token is read, and a count never reaches a body outside it.
 */
const countBinding: Binding<bigint> = atom<bigint>('count');

// -------------------------------------------------------------------------------------------
// Exact-numeric bounds -- `decimal_type`/`float_type`/`rational_type`'s own `min`/
// `exclusive_min`/`max`/`exclusive_max`/`multiple_of` (§5.6, §9)
// -------------------------------------------------------------------------------------------

/**
 * A `decimal_type`/`float_type`/`rational_type` bound is a token the position's own atom reads
 * (`number`, `rational`, §5.6): the wire form is the token, uninterpreted, and the host form is the
 * exact value that atom denotes -- never [TSON-DATA] §4 base type resolution, which §7.3 removes from
 * schema scope entirely. An unquoted integer bound
 * (`min: 1`, `min: 0x10`) resolves to §4.3's `number` case with an `integer`/`based-integer`
 * form; an unquoted non-integer bound (`min: 1.0`, `min: 1e3`) resolves to the same case with a
 * `float` form. Every one of `decimalFromWire`/`rationalFromWire` below parses with the same
 * hand-written number grammar (`base/numberGrammar.ts`) every atom parser already shares --
 * `CLAUDE.md`'s "no `RegExp`" rule for the number grammar applies transitively to every reader
 * of it, this module included.
 */

/** Total over every {@link NumberForm} a bound's own token can resolve to -- `special-value` (`nan`/`infinity`) has no exact decimal or rational expansion, and a `based-integer` is no `number`; both are rejected the same way an unparsable token is. */
function decimalOfNumberForm(form: NumberForm): Decimal | undefined {
  // `number` admits the integer and float forms and no based integer (§5.6): `0x10` is refused as `!number 0x10` is.
  if (form.kind === 'integer') {
    return { unscaledValue: toExactInteger(form), scale: 0 };
  }
  if (form.kind === 'float') {
    const exact = toExactDecimal(form);
    return { unscaledValue: exact.unscaled, scale: -exact.exponent };
  }
  return undefined;
}

/**
 * `w` is whatever the atom leaf's own decoder currently hands back for this position -- see this
 * binding's own doc for why that is *not* {@link TsonDecimal} even though the underlying
 * {@link atom} leaf is labelled `'number'`. Accepts a `bigint` (an integer already narrowed one
 * level up), the token's own raw text (parsed here via `tryParseNumber`), or an already-shaped
 * {@link TsonDecimal} (defensively, in case a future decoder starts handing one back) -- total
 * over all three, never silently producing `NaN`.
 */
function decimalFromWire(w: unknown): Decimal {
  if (typeof w === 'bigint') {
    return { unscaledValue: w, scale: 0 };
  }
  if (typeof w === 'object' && w !== null && 'unscaled' in w && 'exponent' in w) {
    const d = w as TsonDecimal;
    return { unscaledValue: d.unscaled, scale: -d.exponent };
  }
  if (typeof w === 'string') {
    const form = tryParseNumber(w);
    const decimal = form === undefined ? undefined : decimalOfNumberForm(form);
    if (decimal !== undefined) return decimal;
  }
  throw notANumericBound('an exact decimal', w);
}

/**
 * `discriminators` is `[text; 1..]` (§5.2, §8.1): a family is member-dispatched exactly where
 * the list is present, so an empty list would be a second spelling of tag dispatch. It is refused
 * where it is read, so a present list is never empty for any consumer.
 */
function nonEmptyDiscriminators(
  list: readonly string[] | undefined,
): readonly string[] | undefined {
  if (list?.length === 0) {
    throw new TsonReadError({
      code: 'TYPE_MISMATCH',
      message: "'discriminators' must hold at least one field name (min_items: 1)",
    });
  }
  return list;
}

/** `expected <label>, found <w>` -- mirrors `reader/bind.ts`'s own `ATOM_CONSTRAINT_VIOLATION` shape, thrown here rather than reported directly since this module has no `ReadContext` of its own (`bind/decode.ts`'s `TsonReadError` is the seam `definitionResolver.ts`'s `bindAtomInstance` already catches and re-reports through). */
function notANumericBound(label: string, w: unknown): TsonReadError {
  const found = typeof w === 'string' ? `'${w}'` : typeof w === 'bigint' ? w.toString() : typeof w;
  return new TsonReadError({
    code: 'TYPE_MISMATCH',
    message: `expected ${label} at this 'value'-typed bound, found ${found}`,
  });
}

/**
 * Exact decimal (§5.6's `number`, SQL's exact tier) -- the kernel's `min`/`exclusive_min`/`max`/
 * `exclusive_max`/`multiple_of` escape-hatch `value` fields on {@link DecimalType}/
 * {@link FloatType}, which the Java original binds to `BigDecimal` in both families (per
 * `DecimalType.java`/`FloatType.java`'s own field types) rather than parsing through the
 * constrained family's own atom. This port's {@link Decimal} (`unscaledValue`/`scale`,
 * `BigDecimal`'s own two fields) is a different sign convention from {@link TsonDecimal}
 * (`unscaled`/`exponent`, `value = unscaled * 10^exponent`) -- `exponent = -scale` is the whole
 * of the conversion. The leaf stays labelled `'number'` (write formats through the real `number`
 * atom's own `write`, `atom/numeric/decimal.ts`) -- only the read direction ({@link
 * decimalFromWire}) is defensive about what actually arrives at a `value`-typed position, per
 * this section's own top doc.
 */
const decimalBinding: Binding<Decimal> = bridge<Decimal, unknown>(
  atom<unknown>('number'),
  (d) => ({ unscaled: d.unscaledValue, exponent: -d.scale }),
  decimalFromWire,
);

/**
 * `w` counterpart of {@link decimalFromWire} for `rational_type`'s own `value`-typed bounds
 * (`spec/m/meta.tn`). §7.6's `rational` grammar (`a/b`) is an *extended* form outside `number`
 * (`base/numberGrammar.ts`'s own doc), always quoted in practice since `/` is outside the
 * unquoted token profile (§7.1) -- `atom/numeric/rational.ts`'s own note -- so a quoted bound's
 * text is tried against it first; a bare integer bound (`min: 1`) is `number`'s own integer
 * form instead, narrowed to the rational `n/1`.
 */
function rationalFromWire(w: unknown): Rational {
  if (typeof w === 'bigint') {
    return { numerator: w, denominator: 1n };
  }
  if (typeof w === 'object' && w !== null && 'numerator' in w && 'denominator' in w) {
    return w as Rational;
  }
  if (typeof w === 'string') {
    const rational = tryParseRational(w);
    if (rational !== undefined) {
      return {
        numerator: applyGrammarSign(rational.sign, stripGrammarUnderscores(rational.numerator)),
        denominator: BigInt(stripGrammarUnderscores(rational.denominator)),
      };
    }
    const form = tryParseNumber(w);
    if (form?.kind === 'integer' || form?.kind === 'based-integer') {
      return { numerator: toExactInteger(form), denominator: 1n };
    }
  }
  throw notANumericBound('a rational (or an integer)', w);
}

/** Strips the grammar's digit-separator underscores, without a regex -- `numberNarrowing.ts`'s own private helper, restated here since `rational`'s two halves (`RationalForm.numerator`/`.denominator`) never reach that module. */
function stripGrammarUnderscores(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    const ch = digits.charAt(i);
    if (ch !== '_') out += ch;
  }
  return out;
}

function applyGrammarSign(sign: Sign | undefined, digits: string): bigint {
  const magnitude = BigInt(digits);
  return sign === 'minus' ? -magnitude : magnitude;
}

/** Exact fraction (§5.6's `rational`) -- {@link Rational} here and `value/types.ts`'s own `Rational` share one shape (`numerator`/`denominator`, both `bigint`), so the write direction needs no reshaping; only the read direction is defensive, per {@link rationalFromWire}'s own doc. */
const rationalBinding: Binding<Rational> = bridge<Rational, unknown>(
  atom<unknown>('rational'),
  (r) => r,
  rationalFromWire,
);

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
 * A raw token, text plus the form that produced it -- the shape {@link RecordField.value} needs for a
 * fixed or default value (§5.2, §9): unlike {@link identifierBinding}, this position keeps `form`
 * because the value is read back exactly as spelled, quoting included. §8's resolved form is a bare
 * scalar, which is why the Java original registers {@link Token} as an atom rather than binding it
 * as a two-field record (`TsonAtomContext`'s own comment:
 * "binding it structurally writes it as `{ text: ... form: ... }`... where §8's resolved form has
 * a scalar"). `form`'s casing differs from the lexer's own ({@link TokenForm}'s `UNQUOTED`/... vs.
 * `AtomToken`'s lower-kebab forms); the bridge is exactly that remap.
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

/** A token at a position whose own atom reads it later, uninterpreted -- the host value carries no further constraint, hence `unknown`. */
const valueBinding: Binding<unknown> = atom<unknown>('value');

// -------------------------------------------------------------------------------------------
// Internal enumerations
// -------------------------------------------------------------------------------------------

// The kernel declares no `type_kind` (§4.1, §8.1): a resolved entry's kind is derived
// (`typeKind`, `schema/meta/typedef.ts`) rather than carried, so there is no such atom to bind.
const fieldRoleBinding: Binding<FieldRole> = atom<FieldRole>('field_role');
const recordExtensionTypeBinding: Binding<RecordExtensionType> =
  atom<RecordExtensionType>('record_extension_type');
const normalizationBinding: Binding<Normalization> = atom<Normalization>('normalization');
const identifierBaseBinding: Binding<IdentifierBase> = atom<IdentifierBase>('identifier_base');
const complexComponentBinding: Binding<ComplexComponent> =
  atom<ComplexComponent>('complex_component');
const floatFormatBinding: Binding<FloatFormat> = atom<FloatFormat>('ieee_format');
const bytesEncodingBinding: Binding<BytesEncoding> = atom<BytesEncoding>('bytes_encoding');

/**
 * An entry's source position, this package's own fact (`EntryFacts.position`), not a kernel field
 * at all (`SourcePosition`'s own doc). Ported from `SourcePositionStringBridge.java`'s `"line:column:byteOffset"` compact
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
// ValueType, VoidType / Annotation
// -------------------------------------------------------------------------------------------

/** The kernel's `meta.void_type => atom & {}` (§4.2): the empty ATOM body backing `void`. */
const voidTypeBinding: RecordBinding<VoidType> = typed(
  record<VoidType>({
    fields: [],
    construct: () => ({ kind: 'void_type' }),
  }),
);

/**
 * One `@name`/`@name:value` wire annotation (§3.1) -- `schema/meta`'s own local stand-in (see
 * `typedef.ts`'s module doc), never itself a `!type-ref`-tagged wire record: annotations arrive
 * through the `@...` prefix a reader captures at the position they annotate, not as an ordinary
 * `{ name, value }` value. Bound here only so {@link annotationsBinding} has an element binding to
 * carry -- see this file's own note on why `RecordField.annotations` are bound as
 * ordinary fields rather than through `RecordBinding.annotationsCarrier`. {@link TypeRef}'s own
 * `annotations` is different again: it names the wire annotations on the reference *value itself*
 * (§3.1), so it goes through {@link typeRefAnnotatedBinding}'s `annotated()` wrapper instead of
 * either mechanism -- see that binding's own doc.
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
// A value position's own wire annotations (§3.1) -- what `annotated()` positions decode/encode
// -------------------------------------------------------------------------------------------

/**
 * One wire annotation's optional `@name:value` argument, decoded via §4 base type resolution --
 * the same "no declared type in scope" treatment `metaReader.ts`'s own `decodeBaseValue` gives
 * the token's base value, restated here rather than imported from there since
 * `metaReader.ts` already imports this module (the reverse direction would cycle). A non-token
 * argument (a nested record/array/map) has no §4 base type to resolve to and is not representable
 * at this position yet -- annotation arguments this package's own bundled schemas carry are all
 * bare or quoted tokens (`@since:"0.35.0"`, `@lang:en`, in practice).
 */
function annotationArgumentValue(argument: DataValue | undefined): unknown {
  if (argument === undefined) return undefined;
  const core = argument.coreValue;
  if (core.kind !== 'token') return undefined;
  const base = resolveBaseType(core);
  switch (base.kind) {
    case 'boolean':
      return base.value;
    case 'string':
      return base.text;
    case 'number':
      return base.form.kind === 'integer' || base.form.kind === 'based-integer'
        ? toExactInteger(base.form)
        : core.text;
  }
}

/**
 * {@link annotationArgumentValue}'s write-direction inverse: an unquoted token for every scalar
 * this module's own annotation arguments carry. Mirrors `bind/encode.ts`'s own
 * `defaultAtomEncoder` -- not a general-purpose value writer, honest about the values this
 * position actually sees rather than pretending to handle every host value.
 *
 * There is no spelling of absence here and no host `null` to write one from: the notation carries
 * no `null` keyword (§4.4), so the bare token would read back as the string `"null"`. A value this
 * function cannot spell returns `undefined` and the argument is left off, which is what an absent
 * annotation argument already means (§6).
 */
function annotationArgumentDataValue(value: unknown): DataValue | undefined {
  if (value === undefined) return undefined;
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint'
        ? String(value)
        : undefined;
  if (text === undefined) return undefined;
  return { annotations: [], coreValue: { kind: 'token', text, form: 'unquoted' } };
}

/** `bind/`'s own wire-annotation carrier (`{ values: readonly ast.Annotation[] }`) turned into this package's own {@link Annotations} (`readonly Annotation[]`, §6/§8.1's local stand-in) -- the read direction every {@link annotated} position over a `type_ref`-typed value needs. */
function annotationsFromWire(wire: WireAnnotations): Annotations {
  return wire.values.map((a) => ({
    name: a.name,
    ...opt('value', annotationArgumentValue(a.value)),
  }));
}

/** {@link annotationsFromWire}'s write-direction inverse. */
function annotationsToWire(annotations: Annotations): WireAnnotations {
  return {
    values: annotations.map((a) => ({
      name: a.name,
      ...opt('value', annotationArgumentDataValue(a.value)),
    })),
  };
}

// -------------------------------------------------------------------------------------------
// References and type slots (§4.2)
// -------------------------------------------------------------------------------------------

/**
 * `meta.type_ref` and every `meta.ref`, the position that names something: one token, a qualified name. The leaf
 * is an atom whose decoder reads the name and whose encoder writes it back (`referenceAtoms.ts`).
 */
const typeRefBinding: Binding<TypeRef> = atom<TypeRef>('type_ref');

/**
 * {@link typeRefBinding} wrapped so a reader/writer at a reference position recovers the wire annotations written
 * on the reference *value itself* (§3.1) into {@link TypeRef.annotations}. Every field slot below that holds a
 * `TypeRef` binds through this wrapper.
 */
const typeRefAnnotatedBinding: AnnotatedBinding<TypeRef> = annotated<TypeRef>({
  value: typeRefBinding,
  construct: (value, annotations) => ({
    ...(value as TypeRef),
    annotations: annotationsFromWire(annotations),
  }),
  unwrap: (host) => host,
  annotationsOf: (host) => annotationsToWire(host.annotations),
});

/**
 * The kernel's `meta.type_inline => { of: meta.type }` (§4.2): a type written in place, its body read under the
 * constructor its `of` is tagged with, which becomes the inline type's `head`.
 */
const typeInlineBinding: RecordBinding<TypeInline> = record<TypeInline>({
  fields: [
    {
      index: 0,
      wireName: 'of',
      key: 'of',
      required: true,
      unbound: false,
      binding: lazy((): Binding<Top> => topBinding),
      isPresent: () => true,
      get: (host: unknown) => headed((host as TypeInline).of, (host as TypeInline).head),
    } satisfies FieldSlot<Top>,
  ],
  construct: (slots) => {
    const [of] = slots as [Type & Headed];
    const head = of[APPLIED] ?? constructorPath(of);
    return { kind: 'inline', head, of: unheaded(of) };
  },
});

/**
 * The kernel's `meta.type_expr => @meta.disjoint ( meta.type_ref | meta.type_inline )` (§4.2): what a type slot
 * holds, a name or a type written in place, told apart by form -- a token is a name and a braced record the
 * wrapper -- and written untagged.
 */
const typeExprBinding: VariantBinding<TypeExpr> = variant(
  { [metaName('type_ref')]: typeRefAnnotatedBinding, [metaName('type_inline')]: typeInlineBinding },
  undefined,
  { untagged: true },
);
Object.assign(typeExprBinding, {
  memberFor: (value: unknown) =>
    typeExprBinding.members[(value as TypeExpr).kind === 'inline' ? 1 : 0],
});

/**
 * The kernel's `meta.type_chain => { parents?: [meta.type_expr]  supertypes?: set<meta.type_ref>  subtypes?:
 * set<meta.type_ref> }` (§4.1). Each list is written only where it holds something; `supertypes` and `subtypes`
 * are sets, read back in the canonical sorted spelling.
 */
const typeChainBinding: RecordBinding<TypeChain> = record<TypeChain>({
  fields: [
    {
      ...field<TypeChain, 'parents'>(0, 'parents', 'parents', arrayOf<TypeExpr>(typeExprBinding)),
      required: false,
      isPresent: (host: unknown) => (host as TypeChain).parents.length > 0,
    },
    {
      ...field<TypeChain, 'supertypes'>(
        1,
        'supertypes',
        'supertypes',
        arrayOf<string>(identifierBinding),
      ),
      required: false,
      isPresent: (host: unknown) => (host as TypeChain).supertypes.length > 0,
    },
    {
      ...field<TypeChain, 'subtypes'>(
        2,
        'subtypes',
        'subtypes',
        arrayOf<string>(identifierBinding),
      ),
      required: false,
      isPresent: (host: unknown) => (host as TypeChain).subtypes.length > 0,
    },
  ],
  construct: (slots) => {
    const [parents, supertypes, subtypes] = slots as [
      readonly TypeExpr[] | undefined,
      readonly string[] | undefined,
      readonly string[] | undefined,
    ];
    return typeChain(supertypes ?? [], parents ?? [], subtypes ?? []);
  },
});

// -------------------------------------------------------------------------------------------
// Alias / DeclaredType
// -------------------------------------------------------------------------------------------

/** The kernel's `meta.alias => top & { target: type_ref }` (§4.1, §8.3): an alias, a hop that composes `top` and carries no chain. */
const aliasBinding: RecordBinding<Alias> = record<Alias>({
  fields: [field<Alias, 'target'>(0, 'target', 'target', typeRefAnnotatedBinding)],
  construct: (slots) => {
    const [target] = slots as [TypeRef];
    return { kind: 'alias', target };
  },
});

/** The kernel's `meta.declared_type => sum & {}` (§7.8): the open sum over the closure, an empty body. */
const declaredTypeBinding: RecordBinding<DeclaredType> = typed(
  record<DeclaredType>({
    fields: [],
    construct: () => ({ kind: 'declared_type' }),
  }),
);

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

/**
 * The kernel's `record_field` (§5.2, §8.1). A field's name is not one of its facts -- it is the
 * field's key in `record.fields` ({@link fieldMapBinding}).
 */
const recordFieldBinding: RecordBinding<RecordField> = record<RecordField>({
  fields: [
    field<RecordField, 'type'>(0, 'type', 'type', typeExprBinding),
    field<RecordField, 'optional'>(1, 'optional', 'optional', booleanBinding),
    field<RecordField, 'voidable'>(2, 'voidable', 'voidable', booleanBinding),
    field<RecordField, 'role'>(3, 'role', 'role', fieldRoleBinding),
    optional<RecordField, 'value'>(4, 'value', 'value', tokenBinding),
    field<RecordField, 'annotations'>(5, 'annotations', 'annotations', annotationsBinding),
  ],
  construct: (slots) => {
    const [type, optionalFlag, voidable, role, value, annotations] = slots as [
      TypeExpr,
      boolean,
      boolean,
      FieldRole,
      Token | undefined,
      Annotations,
    ];
    return {
      type,
      optional: optionalFlag,
      voidable,
      role,
      ...opt('value', value),
      annotations,
    };
  },
});

/**
 * The kernel's `field_map` (§5.2, §8.1): a record's fields as the map from each declared name to
 * its facts, in declaration order -- a namespace value, written and read as the map, never as a
 * record of `namespace`'s facets.
 */
const fieldMapBinding: MapBinding<Namespace<RecordField>> = map<
  Namespace<RecordField>,
  string,
  RecordField
>({
  key: declaredNameBinding,
  value: recordFieldBinding,
  construct: (entries) => fieldMap(entries),
  read: (host) => host.entries,
});

/**
 * `field_group.members` is `[[text; 1..]; 1..]` and `optional_members` is `[text; 1..]`
 * (§5.11, §8.1): a group has an option, an option has a member, and an absent `optional_members`
 * is the one spelling of "no member marked". An empty list at any of the three is refused where it
 * is read, so a group that is present is never degenerate for any consumer.
 */
function nonEmptyGroupLists(
  members: readonly (readonly string[])[],
  optionalMembers: readonly string[] | undefined,
): Pick<FieldGroup, 'members' | 'optionalMembers'> {
  const refuse = (what: string): never => {
    throw new TsonReadError({
      code: 'TYPE_MISMATCH',
      message: `a field group's ${what} (min_items: 1)`,
    });
  };
  if (members.length === 0) refuse("'members' must hold at least one option");
  if (members.some((option) => option.length === 0)) {
    refuse(
      'options must each hold at least one field name -- an option holding no field can never be chosen',
    );
  }
  if (optionalMembers?.length === 0) {
    refuse("'optional_members' must hold at least one field name -- absent, not empty, names none");
  }
  return { members, ...(optionalMembers === undefined ? {} : { optionalMembers }) };
}

const fieldGroupBinding: RecordBinding<FieldGroup> = record<FieldGroup>({
  fields: [
    field<FieldGroup, 'members'>(
      0,
      'members',
      'members',
      arrayOf<readonly string[]>(arrayOf<string>(declaredNameBinding)),
    ),
    optional<FieldGroup, 'optionalMembers'>(
      1,
      'optional_members',
      'optionalMembers',
      arrayOf<string>(declaredNameBinding),
    ),
    field<FieldGroup, 'optional'>(2, 'optional', 'optional', booleanBinding),
  ],
  construct: (slots) => {
    const [members, optionalMembers, optionalFlag] = slots as [
      readonly (readonly string[])[],
      readonly string[] | undefined,
      boolean,
    ];
    return {
      ...nonEmptyGroupLists(members, optionalMembers),
      optional: optionalFlag,
    };
  },
});

const tupleElementBinding: RecordBinding<TupleElement> = record<TupleElement>({
  fields: [
    field<TupleElement, 'elementType'>(0, 'element_type', 'elementType', typeExprBinding),
    field<TupleElement, 'voidable'>(1, 'voidable', 'voidable', booleanBinding),
  ],
  construct: (slots) => {
    const [elementType, voidable] = slots as [TypeExpr, boolean];
    return { elementType, voidable };
  },
});

/** The kernel's `meta.param => { name: meta.param_name  bound?: meta.type_ref }` (§5.10). */
const paramBinding: RecordBinding<Param> = record<Param>({
  fields: [
    field<Param, 'name'>(0, 'name', 'name', identifierBinding),
    optional<Param, 'bound'>(1, 'bound', 'bound', typeRefAnnotatedBinding),
  ],
  construct: (slots) => {
    const [name, bound] = slots as [string, TypeRef | undefined];
    return { name, ...opt('bound', bound) };
  },
});

/**
 * The kernel's `meta.record` (§5.2, §8.1). `parameters`, where present, make it a parametric record (§5.10): a
 * name among its field types that one of them declares is read as that parameter.
 */
const recordBodyBinding: RecordBinding<RecordBody> = typed(
  record<RecordBody>({
    fields: [
      optional<RecordBody, 'parameters'>(
        0,
        'parameters',
        'parameters',
        arrayOf<Param>(paramBinding),
      ),
      field<RecordBody, 'fields'>(1, 'fields', 'fields', fieldMapBinding),
      field<RecordBody, 'groups'>(2, 'groups', 'groups', arrayOf<FieldGroup>(fieldGroupBinding)),
      field<RecordBody, 'extension'>(3, 'extension', 'extension', recordExtensionTypeBinding),
      optional<RecordBody, 'discriminators'>(
        4,
        'discriminators',
        'discriminators',
        arrayOf<string>(declaredNameBinding),
      ),
      optional<RecordBody, 'nameType'>(5, 'name_type', 'nameType', identifierBinding),
    ],
    construct: (slots) => {
      const [parameters, fields, groups, extension, discriminators, nameType] = slots as [
        readonly Param[] | undefined,
        Namespace<RecordField>,
        readonly FieldGroup[],
        RecordExtensionType,
        readonly string[] | undefined,
        string | undefined,
      ];
      if (parameters?.length === 0) {
        throw new TsonReadError({
          code: 'TYPE_MISMATCH',
          message:
            "a parametric record declares at least one parameter ('parameters' min_items: 1); a record with none states none (§5.10)",
        });
      }
      const body: RecordBody = {
        kind: 'record',
        fields,
        groups,
        extension,
        ...opt('discriminators', nonEmptyDiscriminators(discriminators)),
        ...opt('nameType', nameType),
        ...opt('parameters', parameters),
      };
      return parameters === undefined ? body : withParametersMarked(body);
    },
  }),
);

/**
 * The constructor an entry's value is tagged with (its `EntryFacts.head`), carried on the body into
 * {@link topBinding}'s write path (see `memberFor` below).
 */
const APPLIED = Symbol('appliedConstructor');
interface Headed {
  readonly [APPLIED]?: string;
}

const arrayBodyBinding: RecordBinding<ArrayBody> = typed(
  record<ArrayBody>({
    fields: [
      field<ArrayBody, 'elementType'>(0, 'element_type', 'elementType', typeExprBinding),
      field<ArrayBody, 'voidable'>(1, 'voidable', 'voidable', booleanBinding),
      field<ArrayBody, 'ordered'>(2, 'ordered', 'ordered', booleanBinding),
      field<ArrayBody, 'uniqueItems'>(3, 'unique_items', 'uniqueItems', booleanBinding),
      optional<ArrayBody, 'minItems'>(4, 'min_items', 'minItems', countBinding),
      optional<ArrayBody, 'maxItems'>(5, 'max_items', 'maxItems', countBinding),
    ],
    construct: (slots) => {
      const [elementType, voidable, ordered, uniqueItems, minItems, maxItems] = slots as [
        TypeExpr,
        boolean,
        boolean,
        boolean,
        bigint | undefined,
        bigint | undefined,
      ];
      return {
        kind: 'array',
        elementType,
        voidable,
        ordered,
        uniqueItems,
        ...opt('minItems', minItems),
        ...opt('maxItems', maxItems),
      };
    },
  }),
);

const mapBodyBinding: RecordBinding<MapBody> = typed(
  record<MapBody>({
    fields: [
      field<MapBody, 'keyType'>(0, 'key_type', 'keyType', typeRefAnnotatedBinding),
      field<MapBody, 'valueType'>(1, 'value_type', 'valueType', typeExprBinding),
      field<MapBody, 'voidable'>(2, 'voidable', 'voidable', booleanBinding),
      field<MapBody, 'ordered'>(3, 'ordered', 'ordered', booleanBinding),
      optional<MapBody, 'minItems'>(4, 'min_items', 'minItems', countBinding),
      optional<MapBody, 'maxItems'>(5, 'max_items', 'maxItems', countBinding),
    ],
    construct: (slots) => {
      const [keyType, valueType, voidable, ordered, minItems, maxItems] = slots as [
        TypeRef,
        TypeExpr,
        boolean,
        boolean,
        bigint | undefined,
        bigint | undefined,
      ];
      return {
        kind: 'map',
        keyType,
        valueType,
        voidable,
        ordered,
        ...opt('minItems', minItems),
        ...opt('maxItems', maxItems),
      };
    },
  }),
);

/**
 * `meta.namespace`'s `voidable`, pinned false (`voidable?: = false`): a body may restate the pin, which the
 * schema's reader holds it to, and the host keeps nothing for it, so it is never written (§5.5, §8.1).
 */
const namespaceVoidableSlot: FieldSlot<boolean> = {
  index: 2,
  wireName: 'voidable',
  key: 'voidable',
  required: false,
  unbound: false,
  binding: booleanBinding,
  isPresent: () => false,
  get: () => false,
};

/**
 * The kernel's `meta.namespace` (§4.1, §8.1): a refinement of `meta.map` whose `key_type` is an
 * identifier family, `voidable` is pinned false and `access_pattern`/`size_type` are fixed, so none of
 * those three is written. An instance, `schema => !meta.namespace { key_type: meta.type_name  value_type:
 * meta.declared }`, is a namespace type.
 */
const namespaceBodyBinding: RecordBinding<NamespaceBody> = typed(
  record<NamespaceBody>({
    fields: [
      field<NamespaceBody, 'keyType'>(0, 'key_type', 'keyType', typeRefAnnotatedBinding),
      field<NamespaceBody, 'valueType'>(1, 'value_type', 'valueType', typeExprBinding),
      namespaceVoidableSlot,
      field<NamespaceBody, 'ordered'>(3, 'ordered', 'ordered', booleanBinding),
      optional<NamespaceBody, 'minItems'>(4, 'min_items', 'minItems', countBinding),
      optional<NamespaceBody, 'maxItems'>(5, 'max_items', 'maxItems', countBinding),
    ],
    construct: (slots) => {
      const [keyType, valueType, , ordered, minItems, maxItems] = slots as [
        TypeRef,
        TypeExpr,
        boolean | undefined,
        boolean,
        bigint | undefined,
        bigint | undefined,
      ];
      return {
        kind: 'namespace',
        keyType,
        valueType,
        ordered,
        ...opt('minItems', minItems),
        ...opt('maxItems', maxItems),
      };
    },
  }),
);

const tupleBodyBinding: RecordBinding<TupleBody> = typed(
  record<TupleBody>({
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
  }),
);

/**
 * `choice`'s own vocabulary, resolved (§5.4, §8.1). `disjoint` is a resolver-derived index over
 * the variant list -- true or false by discrimination-class distinctness -- and lives here rather
 * than on `type_definition` because a variant list is the only thing it is a fact about, which is
 * what makes "recorded on every choice and absent on every other definition" structural.
 *
 * It is bound, and optional, for the two directions a resolved document travels: written on the
 * way out, and read back on the way in, where §8.1 requires an ingesting processor to discard and
 * recompute it. A binding that omitted it would refuse every resolved choice a conforming
 * processor writes.
 */
const choiceBodyBinding: RecordBinding<ChoiceBody> = typed(
  record<ChoiceBody>({
    fields: [
      field<ChoiceBody, 'variants'>(0, 'variants', 'variants', arrayOf<TypeExpr>(typeExprBinding)),
      optional<ChoiceBody, 'disjoint'>(1, 'disjoint', 'disjoint', booleanBinding),
    ],
    construct: (slots) => {
      const [variants, disjoint] = slots as [readonly TypeExpr[], boolean | undefined];
      return { kind: 'choice', variants, ...opt('disjoint', disjoint) };
    },
  }),
);

const enumBodyBinding: RecordBinding<EnumBody> = typed(
  record<EnumBody>({
    fields: [
      // `name_type` names the identifier family the members are names of.
      field<EnumBody, 'nameType'>(0, 'name_type', 'nameType', identifierBinding),
      // `enum_set` is `!meta.set_type { element_type: text  min_items: 1 }` (§7.4): members are held as
      // text whatever the name type is, and judged by it at link.
      field<EnumBody, 'members'>(1, 'members', 'members', arrayOf<string>(textBinding)),
    ],
    construct: (slots) => {
      const [nameType, members] = slots as [string, readonly string[]];
      return { kind: 'enum', nameType, members };
    },
  }),
);

// -------------------------------------------------------------------------------------------
// meta.ref, meta.apply, meta.dependent, meta.extern
// -------------------------------------------------------------------------------------------

/**
 * The kernel's `meta.ref => meta.atom & { of: meta.type_ref }` (§4.2, §5.12): the one atom whose values are names.
 * The linker's derived index is no field.
 */
const refBodyBinding: RecordBinding<RefBody> = typed(
  record<RefBody>({
    fields: [field<RefBody, 'of'>(0, 'of', 'of', typeRefAnnotatedBinding)],
    construct: (slots) => {
      const [of] = slots as [TypeRef];
      return { kind: 'ref', of };
    },
  }),
);

/** The kernel's `meta.apply => final meta.type & { head: meta.type_ref  arguments: [meta.type_ref; 1..] }` (§5.10). */
const applyBodyBinding: RecordBinding<ApplyBody> = typed(
  record<ApplyBody>({
    fields: [
      field<ApplyBody, 'head'>(0, 'head', 'head', typeRefAnnotatedBinding),
      field<ApplyBody, 'arguments'>(
        1,
        'arguments',
        'arguments',
        arrayOf<TypeRef>(typeRefAnnotatedBinding),
      ),
    ],
    construct: (slots) => {
      const [head, argumentsWritten] = slots as [TypeRef, readonly TypeRef[]];
      if (argumentsWritten.length === 0) {
        throw new TsonReadError({
          code: 'TYPE_MISMATCH',
          message: `an application has at least one argument ('arguments' min_items: 1): '${head.name}' (§5.10)`,
        });
      }
      return { kind: 'apply', head, arguments: argumentsWritten };
    },
  }),
);

/** The kernel's `meta.dependent => final meta.sum & { on: text }` (§5.2). */
const dependentBodyBinding: RecordBinding<DependentBody> = typed(
  record<DependentBody>({
    fields: [field<DependentBody, 'on'>(0, 'on', 'on', textBinding)],
    construct: (slots) => {
      const [on] = slots as [string];
      return { kind: 'dependent', on };
    },
  }),
);

/** The kernel's `meta.extern => meta.top & { schema: iri_reference  type: text }` (§5.13): a hop, no chain. */
const externBinding: RecordBinding<Extern> = record<Extern>({
  fields: [
    field<Extern, 'schema'>(0, 'schema', 'schema', textBinding),
    field<Extern, 'type'>(1, 'type', 'type', textBinding),
  ],
  construct: (slots) => {
    const [schema, type] = slots as [string, string];
    return { kind: 'extern', schema, type };
  },
});

// -------------------------------------------------------------------------------------------
// atoms-numeric.ts
// -------------------------------------------------------------------------------------------

const integerTypeBinding: RecordBinding<IntegerType> = typed(
  record<IntegerType>({
    fields: [
      optional<IntegerType, 'size'>(0, 'size', 'size', integerSizeBinding),
      optional<IntegerType, 'min'>(1, 'min', 'min', bigintBinding),
      optional<IntegerType, 'exclusiveMin'>(2, 'exclusive_min', 'exclusiveMin', bigintBinding),
      optional<IntegerType, 'max'>(3, 'max', 'max', bigintBinding),
      optional<IntegerType, 'exclusiveMax'>(4, 'exclusive_max', 'exclusiveMax', bigintBinding),
      optional<IntegerType, 'multipleOf'>(5, 'multiple_of', 'multipleOf', bigintBinding),
      optional<IntegerType, 'members'>(6, 'members', 'members', arrayOf<bigint>(bigintBinding)),
    ],
    construct: (slots) => {
      const [size, min, exclusiveMin, max, exclusiveMax, multipleOf, members] = slots as [
        IntegerSize | undefined,
        bigint | undefined,
        bigint | undefined,
        bigint | undefined,
        bigint | undefined,
        bigint | undefined,
        readonly bigint[] | undefined,
      ];
      return {
        kind: 'integer_type',
        ...opt('size', size),
        ...opt('min', min),
        ...opt('exclusiveMin', exclusiveMin),
        ...opt('max', max),
        ...opt('exclusiveMax', exclusiveMax),
        ...opt('multipleOf', multipleOf),
        ...opt('members', members),
      };
    },
  }),
);

const floatTypeBinding: RecordBinding<FloatType> = typed(
  record<FloatType>({
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
  }),
);

const decimalTypeBinding: RecordBinding<DecimalType> = typed(
  record<DecimalType>({
    fields: [
      optional<DecimalType, 'min'>(0, 'min', 'min', decimalBinding),
      optional<DecimalType, 'exclusiveMin'>(1, 'exclusive_min', 'exclusiveMin', decimalBinding),
      optional<DecimalType, 'max'>(2, 'max', 'max', decimalBinding),
      optional<DecimalType, 'exclusiveMax'>(3, 'exclusive_max', 'exclusiveMax', decimalBinding),
      optional<DecimalType, 'multipleOf'>(4, 'multiple_of', 'multipleOf', decimalBinding),
      optional<DecimalType, 'totalDigits'>(5, 'total_digits', 'totalDigits', countBinding),
      optional<DecimalType, 'fractionDigits'>(6, 'fraction_digits', 'fractionDigits', countBinding),
      optional<DecimalType, 'members'>(7, 'members', 'members', arrayOf<Decimal>(decimalBinding)),
    ],
    construct: (slots) => {
      const [
        min,
        exclusiveMin,
        max,
        exclusiveMax,
        multipleOf,
        totalDigits,
        fractionDigits,
        members,
      ] = slots as [
        Decimal | undefined,
        Decimal | undefined,
        Decimal | undefined,
        Decimal | undefined,
        Decimal | undefined,
        bigint | undefined,
        bigint | undefined,
        readonly Decimal[] | undefined,
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
        ...opt('members', members),
      };
    },
  }),
);

const rationalTypeBinding: RecordBinding<RationalType> = typed(
  record<RationalType>({
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
  }),
);

const complexTypeBinding: RecordBinding<ComplexType> = typed(
  record<ComplexType>({
    fields: [field<ComplexType, 'component'>(0, 'component', 'component', complexComponentBinding)],
    construct: (slots) => {
      const [component] = slots as [ComplexComponent];
      return { kind: 'complex_type', component };
    },
  }),
);

// -------------------------------------------------------------------------------------------
// atoms-text.ts
// -------------------------------------------------------------------------------------------

const textTypeBinding: RecordBinding<TextType> = typed(
  record<TextType>({
    fields: [
      optional<TextType, 'minLength'>(0, 'min_length', 'minLength', countBinding),
      optional<TextType, 'maxLength'>(1, 'max_length', 'maxLength', countBinding),
      optional<TextType, 'length'>(2, 'length', 'length', countBinding),
      optional<TextType, 'pattern'>(3, 'pattern', 'pattern', textBinding),
      // `text_member_set => !set_type { element_type: text  min_items: 1 }` (§7.4): a value set on
      // the text tier itself, reached the same way `integer_type.members`/`decimal_type.members` are.
      optional<TextType, 'members'>(4, 'members', 'members', arrayOf<string>(textBinding)),
      field<TextType, 'normalization'>(5, 'normalization', 'normalization', normalizationBinding),
    ],
    construct: (slots) => {
      const [minLength, maxLength, length, pattern, members, normalization] = slots as [
        bigint | undefined,
        bigint | undefined,
        bigint | undefined,
        string | undefined,
        readonly string[] | undefined,
        Normalization,
      ];
      return {
        kind: 'text_type',
        ...opt('minLength', minLength),
        ...opt('maxLength', maxLength),
        ...opt('length', length),
        ...opt('pattern', pattern),
        ...opt('members', members),
        normalization,
      };
    },
  }),
);

const identifierTypeBinding: RecordBinding<IdentifierType> = typed(
  record<IdentifierType>({
    fields: [
      unwrittenAt(
        field<IdentifierType, 'spec'>(0, 'spec', 'spec', textBinding),
        'https://www.unicode.org/reports/tr31/',
      ),
      optional<IdentifierType, 'minLength'>(1, 'min_length', 'minLength', countBinding),
      optional<IdentifierType, 'maxLength'>(2, 'max_length', 'maxLength', countBinding),
      optional<IdentifierType, 'length'>(3, 'length', 'length', countBinding),
      optional<IdentifierType, 'pattern'>(4, 'pattern', 'pattern', textBinding),
      optional<IdentifierType, 'members'>(5, 'members', 'members', arrayOf<string>(textBinding)),
      field<IdentifierType, 'normalization'>(
        6,
        'normalization',
        'normalization',
        normalizationBinding,
      ),
      field<IdentifierType, 'start'>(7, 'start', 'start', identifierBaseBinding),
      field<IdentifierType, 'continue'>(8, 'continue', 'continue', identifierBaseBinding),
      optional<IdentifierType, 'startAdd'>(9, 'start_add', 'startAdd', textBinding),
      optional<IdentifierType, 'continueAdd'>(10, 'continue_add', 'continueAdd', textBinding),
      optional<IdentifierType, 'medial'>(11, 'medial', 'medial', textBinding),
      optional<IdentifierType, 'exclude'>(12, 'exclude', 'exclude', textBinding),
    ],
    construct: (slots) => {
      const [
        spec,
        minLength,
        maxLength,
        length,
        pattern,
        members,
        normalization,
        start,
        continueBase,
        startAdd,
        continueAdd,
        medial,
        exclude,
      ] = slots as [
        string,
        bigint | undefined,
        bigint | undefined,
        bigint | undefined,
        string | undefined,
        readonly string[] | undefined,
        Normalization,
        IdentifierBase,
        IdentifierBase,
        string | undefined,
        string | undefined,
        string | undefined,
        string | undefined,
      ];
      return {
        kind: 'identifier_type',
        spec,
        ...opt('minLength', minLength),
        ...opt('maxLength', maxLength),
        ...opt('length', length),
        ...opt('pattern', pattern),
        ...opt('members', members),
        normalization,
        start,
        continue: continueBase,
        ...opt('startAdd', startAdd),
        ...opt('continueAdd', continueAdd),
        ...opt('medial', medial),
        ...opt('exclude', exclude),
      };
    },
  }),
);

const bytesTypeBinding: RecordBinding<BytesType> = typed(
  record<BytesType>({
    fields: [
      field<BytesType, 'encoding'>(0, 'encoding', 'encoding', bytesEncodingBinding),
      optional<BytesType, 'minLength'>(1, 'min_length', 'minLength', countBinding),
      optional<BytesType, 'maxLength'>(2, 'max_length', 'maxLength', countBinding),
    ],
    construct: (slots) => {
      const [encoding, minLength, maxLength] = slots as [
        BytesEncoding,
        bigint | undefined,
        bigint | undefined,
      ];
      return {
        kind: 'bytes_type',
        encoding,
        ...opt('minLength', minLength),
        ...opt('maxLength', maxLength),
      };
    },
  }),
);

const regexTypeBinding: RecordBinding<RegexType> = typed(
  record<RegexType>({
    fields: [
      unwrittenAt(
        field<RegexType, 'spec'>(0, 'spec', 'spec', textBinding),
        'https://www.rfc-editor.org/rfc/rfc9485',
      ),
      optional<RegexType, 'minLength'>(1, 'min_length', 'minLength', countBinding),
      optional<RegexType, 'maxLength'>(2, 'max_length', 'maxLength', countBinding),
      optional<RegexType, 'length'>(3, 'length', 'length', countBinding),
      optional<RegexType, 'pattern'>(4, 'pattern', 'pattern', textBinding),
      optional<RegexType, 'members'>(5, 'members', 'members', arrayOf<string>(textBinding)),
      unwrittenAt(
        field<RegexType, 'normalization'>(
          6,
          'normalization',
          'normalization',
          normalizationBinding,
        ),
        'NONE',
      ),
    ],
    construct: (slots) => {
      const [spec, minLength, maxLength, length, pattern, members, normalization] = slots as [
        string,
        bigint | undefined,
        bigint | undefined,
        bigint | undefined,
        string | undefined,
        readonly string[] | undefined,
        Normalization,
      ];
      return {
        kind: 'regex_type',
        spec,
        ...opt('minLength', minLength),
        ...opt('maxLength', maxLength),
        ...opt('length', length),
        ...opt('pattern', pattern),
        ...opt('members', members),
        normalization,
      };
    },
  }),
);

/** `uri_type` and `iri_type` share a shape; `kind` is the only difference. */
function uriFamilyBinding<T extends UriType | IriType>(kind: T['kind']): RecordBinding<T> {
  return typed(
    record<T>({
      fields: [
        unwrittenAt(
          field<T, 'spec'>(0, 'spec', 'spec', textBinding),
          kind === 'uri_type'
            ? 'https://www.rfc-editor.org/rfc/rfc3986'
            : 'https://www.rfc-editor.org/rfc/rfc3987',
        ),
        optional<T, 'minLength'>(1, 'min_length', 'minLength', countBinding),
        optional<T, 'maxLength'>(2, 'max_length', 'maxLength', countBinding),
        optional<T, 'length'>(3, 'length', 'length', countBinding),
        optional<T, 'pattern'>(4, 'pattern', 'pattern', textBinding),
        optional<T, 'members'>(5, 'members', 'members', arrayOf<string>(textBinding)),
        optional<T, 'schemes'>(6, 'schemes', 'schemes', arrayOf<string>(schemeNameBinding)),
        field<T, 'allowRelative'>(7, 'allow_relative', 'allowRelative', booleanBinding),
        field<T, 'allowFragment'>(8, 'allow_fragment', 'allowFragment', booleanBinding),
        unwrittenAt(
          field<T, 'normalization'>(9, 'normalization', 'normalization', normalizationBinding),
          'NONE',
        ),
      ],
      construct: (slots) => {
        const [
          spec,
          minLength,
          maxLength,
          length,
          pattern,
          members,
          schemes,
          allowRelative,
          allowFragment,
          normalization,
        ] = slots as [
          string,
          bigint | undefined,
          bigint | undefined,
          bigint | undefined,
          string | undefined,
          readonly string[] | undefined,
          readonly string[] | undefined,
          boolean,
          boolean,
          Normalization,
        ];
        return {
          kind,
          spec,
          ...opt('minLength', minLength),
          ...opt('maxLength', maxLength),
          ...opt('length', length),
          ...opt('pattern', pattern),
          ...opt('members', members),
          ...opt('schemes', schemes),
          allowRelative,
          allowFragment,
          normalization,
        } as unknown as T;
      },
    }),
  );
}

const uriTypeBinding: RecordBinding<UriType> = uriFamilyBinding<UriType>('uri_type');
const iriTypeBinding: RecordBinding<IriType> = uriFamilyBinding<IriType>('iri_type');

const emailTypeBinding: RecordBinding<EmailType> = typed(
  record<EmailType>({
    fields: [
      unwrittenAt(
        field<EmailType, 'spec'>(0, 'spec', 'spec', textBinding),
        'https://www.rfc-editor.org/rfc/rfc5322',
      ),
      optional<EmailType, 'minLength'>(1, 'min_length', 'minLength', countBinding),
      optional<EmailType, 'maxLength'>(2, 'max_length', 'maxLength', countBinding),
      optional<EmailType, 'length'>(3, 'length', 'length', countBinding),
      optional<EmailType, 'pattern'>(4, 'pattern', 'pattern', textBinding),
      optional<EmailType, 'members'>(5, 'members', 'members', arrayOf<string>(textBinding)),
      unwrittenAt(
        field<EmailType, 'normalization'>(
          6,
          'normalization',
          'normalization',
          normalizationBinding,
        ),
        'NONE',
      ),
    ],
    construct: (slots) => {
      const [spec, minLength, maxLength, length, pattern, members, normalization] = slots as [
        string,
        bigint | undefined,
        bigint | undefined,
        bigint | undefined,
        string | undefined,
        readonly string[] | undefined,
        Normalization,
      ];
      return {
        kind: 'email_type',
        spec,
        ...opt('minLength', minLength),
        ...opt('maxLength', maxLength),
        ...opt('length', length),
        ...opt('pattern', pattern),
        ...opt('members', members),
        normalization,
      };
    },
  }),
);

const uuidTypeBinding: RecordBinding<UuidType> = typed(
  record<UuidType>({
    fields: [optional<UuidType, 'version'>(0, 'version', 'version', countBinding)],
    construct: (slots) => {
      const [version] = slots as [bigint | undefined];
      return { kind: 'uuid_type', ...opt('version', version) };
    },
  }),
);

// -------------------------------------------------------------------------------------------
// atoms-temporal.ts
// -------------------------------------------------------------------------------------------

const dateTypeBinding: RecordBinding<DateType> = typed(
  record<DateType>({
    fields: [
      optional<DateType, 'min'>(0, 'min', 'min', calendarDateBinding),
      optional<DateType, 'exclusiveMin'>(1, 'exclusive_min', 'exclusiveMin', calendarDateBinding),
      optional<DateType, 'max'>(2, 'max', 'max', calendarDateBinding),
      optional<DateType, 'exclusiveMax'>(3, 'exclusive_max', 'exclusiveMax', calendarDateBinding),
    ],
    construct: (slots) => {
      const [min, exclusiveMin, max, exclusiveMax] = slots as [
        CalendarDate | undefined,
        CalendarDate | undefined,
        CalendarDate | undefined,
        CalendarDate | undefined,
      ];
      return {
        kind: 'date_type',
        ...opt('min', min),
        ...opt('exclusiveMin', exclusiveMin),
        ...opt('max', max),
        ...opt('exclusiveMax', exclusiveMax),
      };
    },
  }),
);

const timeTypeBinding: RecordBinding<TimeType> = typed(
  record<TimeType>({
    fields: [
      optional<TimeType, 'min'>(0, 'min', 'min', offsetTimeBinding),
      optional<TimeType, 'exclusiveMin'>(1, 'exclusive_min', 'exclusiveMin', offsetTimeBinding),
      optional<TimeType, 'max'>(2, 'max', 'max', offsetTimeBinding),
      optional<TimeType, 'exclusiveMax'>(3, 'exclusive_max', 'exclusiveMax', offsetTimeBinding),
      optional<TimeType, 'fractionDigits'>(4, 'fraction_digits', 'fractionDigits', countBinding),
    ],
    construct: (slots) => {
      const [min, exclusiveMin, max, exclusiveMax, fractionDigits] = slots as [
        OffsetTime | undefined,
        OffsetTime | undefined,
        OffsetTime | undefined,
        OffsetTime | undefined,
        bigint | undefined,
      ];
      return {
        kind: 'time_type',
        ...opt('min', min),
        ...opt('exclusiveMin', exclusiveMin),
        ...opt('max', max),
        ...opt('exclusiveMax', exclusiveMax),
        ...opt('fractionDigits', fractionDigits),
      };
    },
  }),
);

const dateTimeTypeBinding: RecordBinding<DateTimeType> = typed(
  record<DateTimeType>({
    fields: [
      optional<DateTimeType, 'min'>(0, 'min', 'min', offsetDateTimeBinding),
      optional<DateTimeType, 'exclusiveMin'>(
        1,
        'exclusive_min',
        'exclusiveMin',
        offsetDateTimeBinding,
      ),
      optional<DateTimeType, 'max'>(2, 'max', 'max', offsetDateTimeBinding),
      optional<DateTimeType, 'exclusiveMax'>(
        3,
        'exclusive_max',
        'exclusiveMax',
        offsetDateTimeBinding,
      ),
      optional<DateTimeType, 'fractionDigits'>(
        4,
        'fraction_digits',
        'fractionDigits',
        countBinding,
      ),
    ],
    construct: (slots) => {
      const [min, exclusiveMin, max, exclusiveMax, fractionDigits] = slots as [
        OffsetDateTime | undefined,
        OffsetDateTime | undefined,
        OffsetDateTime | undefined,
        OffsetDateTime | undefined,
        bigint | undefined,
      ];
      return {
        kind: 'datetime_type',
        ...opt('min', min),
        ...opt('exclusiveMin', exclusiveMin),
        ...opt('max', max),
        ...opt('exclusiveMax', exclusiveMax),
        ...opt('fractionDigits', fractionDigits),
      };
    },
  }),
);

/**
 * `duration_type`'s own `min`/`exclusive_min`/`max`/`exclusive_max`/`multiple_of` (§5.5, §9): the
 * a token read under `duration`'s own atom (§5.2, §7.4) -- so the resolved value is `duration`'s own value space, a signed count of nanoseconds
 * (`atoms-temporal.ts`'s own `DurationType` doc), not the raw token. Parses the same way
 * `atom/temporal/isoDuration.ts` does rather than inventing a second reading of the grammar.
 */
function durationBoundFromWire(w: unknown): bigint {
  if (typeof w === 'bigint') return w;
  if (typeof w === 'string') {
    const nanoseconds = tryParseIsoDuration(w);
    if (nanoseconds !== undefined) return nanoseconds;
  }
  throw notANumericBound('a duration (RFC 3339 Appendix A, §5.5)', w);
}

const durationBoundBinding: Binding<bigint> = bridge<bigint, unknown>(
  atom<unknown>('duration'),
  (nanoseconds) => formatIsoDuration(nanoseconds),
  durationBoundFromWire,
);

const durationTypeBinding: RecordBinding<DurationType> = typed(
  record<DurationType>({
    fields: [
      optional<DurationType, 'min'>(0, 'min', 'min', durationBoundBinding),
      optional<DurationType, 'exclusiveMin'>(
        1,
        'exclusive_min',
        'exclusiveMin',
        durationBoundBinding,
      ),
      optional<DurationType, 'max'>(2, 'max', 'max', durationBoundBinding),
      optional<DurationType, 'exclusiveMax'>(
        3,
        'exclusive_max',
        'exclusiveMax',
        durationBoundBinding,
      ),
      optional<DurationType, 'fractionDigits'>(
        4,
        'fraction_digits',
        'fractionDigits',
        countBinding,
      ),
      optional<DurationType, 'multipleOf'>(5, 'multiple_of', 'multipleOf', durationBoundBinding),
    ],
    construct: (slots) => {
      const [min, exclusiveMin, max, exclusiveMax, fractionDigits, multipleOf] = slots as [
        bigint | undefined,
        bigint | undefined,
        bigint | undefined,
        bigint | undefined,
        bigint | undefined,
        bigint | undefined,
      ];
      return {
        kind: 'duration_type',
        ...opt('min', min),
        ...opt('exclusiveMin', exclusiveMin),
        ...opt('max', max),
        ...opt('exclusiveMax', exclusiveMax),
        ...opt('fractionDigits', fractionDigits),
        ...opt('multipleOf', multipleOf),
      };
    },
  }),
);

/**
 * `period_type`'s own `min`/`exclusive_min`/`max`/`exclusive_max`/`multiple_of` (§5.5, §9): the
 * same `value`-escape-hatch treatment {@link durationBoundBinding}'s own doc states in full,
 * `period`'s value space (a signed integer count of months) in place of `duration`'s.
 */
function periodBoundFromWire(w: unknown): bigint {
  if (typeof w === 'bigint') return w;
  if (typeof w === 'string') {
    const months = tryParseIsoPeriod(w);
    if (months !== undefined) return months;
  }
  throw notANumericBound('a period (RFC 3339 Appendix A, §5.5)', w);
}

const periodBoundBinding: Binding<bigint> = bridge<bigint, unknown>(
  atom<unknown>('period'),
  (months) => formatIsoPeriod(months),
  periodBoundFromWire,
);

const periodTypeBinding: RecordBinding<PeriodType> = typed(
  record<PeriodType>({
    fields: [
      optional<PeriodType, 'min'>(0, 'min', 'min', periodBoundBinding),
      optional<PeriodType, 'exclusiveMin'>(1, 'exclusive_min', 'exclusiveMin', periodBoundBinding),
      optional<PeriodType, 'max'>(2, 'max', 'max', periodBoundBinding),
      optional<PeriodType, 'exclusiveMax'>(3, 'exclusive_max', 'exclusiveMax', periodBoundBinding),
      optional<PeriodType, 'multipleOf'>(4, 'multiple_of', 'multipleOf', periodBoundBinding),
    ],
    construct: (slots) => {
      const [min, exclusiveMin, max, exclusiveMax, multipleOf] = slots as [
        bigint | undefined,
        bigint | undefined,
        bigint | undefined,
        bigint | undefined,
        bigint | undefined,
      ];
      return {
        kind: 'period_type',
        ...opt('min', min),
        ...opt('exclusiveMin', exclusiveMin),
        ...opt('max', max),
        ...opt('exclusiveMax', exclusiveMax),
        ...opt('multipleOf', multipleOf),
      };
    },
  }),
);

// -------------------------------------------------------------------------------------------
// atoms-network.ts
// -------------------------------------------------------------------------------------------

const ipv4TypeBinding: RecordBinding<Ipv4Type> = typed(
  record<Ipv4Type>({
    fields: [
      unwrittenAt(
        field<Ipv4Type, 'spec'>(0, 'spec', 'spec', textBinding),
        'https://www.rfc-editor.org/rfc/rfc3986',
      ),
      field<Ipv4Type, 'within'>(1, 'within', 'within', arrayOf<string>(textBinding)),
      field<Ipv4Type, 'excluding'>(2, 'excluding', 'excluding', arrayOf<string>(textBinding)),
    ],
    construct: (slots) => {
      const [spec, within, excluding] = slots as [string, readonly string[], readonly string[]];
      return { kind: 'ipv4_type', spec, within, excluding };
    },
  }),
);

const ipv6TypeBinding: RecordBinding<Ipv6Type> = typed(
  record<Ipv6Type>({
    fields: [
      unwrittenAt(
        field<Ipv6Type, 'spec'>(0, 'spec', 'spec', textBinding),
        'https://www.rfc-editor.org/rfc/rfc4291',
      ),
      field<Ipv6Type, 'within'>(1, 'within', 'within', arrayOf<string>(textBinding)),
      field<Ipv6Type, 'excluding'>(2, 'excluding', 'excluding', arrayOf<string>(textBinding)),
    ],
    construct: (slots) => {
      const [spec, within, excluding] = slots as [string, readonly string[], readonly string[]];
      return { kind: 'ipv6_type', spec, within, excluding };
    },
  }),
);

const cidr4TypeBinding: RecordBinding<Cidr4Type> = typed(
  record<Cidr4Type>({
    fields: [
      unwrittenAt(
        field<Cidr4Type, 'spec'>(0, 'spec', 'spec', textBinding),
        'https://www.rfc-editor.org/rfc/rfc4632',
      ),
      optional<Cidr4Type, 'minPrefix'>(1, 'min_prefix', 'minPrefix', countBinding),
      optional<Cidr4Type, 'maxPrefix'>(2, 'max_prefix', 'maxPrefix', countBinding),
      field<Cidr4Type, 'within'>(3, 'within', 'within', arrayOf<string>(textBinding)),
      field<Cidr4Type, 'excluding'>(4, 'excluding', 'excluding', arrayOf<string>(textBinding)),
    ],
    construct: (slots) => {
      const [spec, minPrefix, maxPrefix, within, excluding] = slots as [
        string,
        bigint | undefined,
        bigint | undefined,
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
  }),
);

const cidr6TypeBinding: RecordBinding<Cidr6Type> = typed(
  record<Cidr6Type>({
    fields: [
      unwrittenAt(
        field<Cidr6Type, 'spec'>(0, 'spec', 'spec', textBinding),
        'https://www.rfc-editor.org/rfc/rfc4291',
      ),
      optional<Cidr6Type, 'minPrefix'>(1, 'min_prefix', 'minPrefix', countBinding),
      optional<Cidr6Type, 'maxPrefix'>(2, 'max_prefix', 'maxPrefix', countBinding),
      field<Cidr6Type, 'within'>(3, 'within', 'within', arrayOf<string>(textBinding)),
      field<Cidr6Type, 'excluding'>(4, 'excluding', 'excluding', arrayOf<string>(textBinding)),
    ],
    construct: (slots) => {
      const [spec, minPrefix, maxPrefix, within, excluding] = slots as [
        string,
        bigint | undefined,
        bigint | undefined,
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
  }),
);

const macTypeBinding: RecordBinding<MacType> = typed(
  record<MacType>({
    fields: [
      unwrittenAt(
        field<MacType, 'spec'>(0, 'spec', 'spec', textBinding),
        'https://www.rfc-editor.org/rfc/rfc9542',
      ),
    ],
    construct: (slots) => {
      const [spec] = slots as [string];
      return { kind: 'mac_type', spec };
    },
  }),
);

const hostnameTypeBinding: RecordBinding<HostnameType> = typed(
  record<HostnameType>({
    fields: [
      unwrittenAt(
        field<HostnameType, 'spec'>(0, 'spec', 'spec', textBinding),
        'https://www.rfc-editor.org/rfc/rfc5890',
      ),
      field<HostnameType, 'allowIdn'>(1, 'allow_idn', 'allowIdn', booleanBinding),
    ],
    construct: (slots) => {
      const [spec, allowIdn] = slots as [string, boolean];
      return { kind: 'hostname_type', spec, allowIdn };
    },
  }),
);

const hostTypeBinding: RecordBinding<HostType> = typed(
  record<HostType>({
    fields: [
      unwrittenAt(
        field<HostType, 'spec'>(0, 'spec', 'spec', textBinding),
        'https://www.rfc-editor.org/rfc/rfc3987',
      ),
    ],
    construct: (slots) => {
      const [spec] = slots as [string];
      return { kind: 'host_type', spec };
    },
  }),
);

const mediaTypeTypeBinding: RecordBinding<MediaTypeType> = typed(
  record<MediaTypeType>({
    fields: [
      unwrittenAt(
        field<MediaTypeType, 'spec'>(0, 'spec', 'spec', textBinding),
        'https://www.rfc-editor.org/rfc/rfc6838',
      ),
      field<MediaTypeType, 'allowParameters'>(
        1,
        'allow_parameters',
        'allowParameters',
        booleanBinding,
      ),
      optional<MediaTypeType, 'types'>(2, 'types', 'types', arrayOf<string>(textBinding)),
      optional<MediaTypeType, 'suffixes'>(3, 'suffixes', 'suffixes', arrayOf<string>(textBinding)),
    ],
    construct: (slots) => {
      const [spec, allowParameters, types, suffixes] = slots as [
        string,
        boolean,
        readonly string[] | undefined,
        readonly string[] | undefined,
      ];
      return {
        kind: 'media_type_type',
        spec,
        allowParameters,
        ...opt('types', types),
        ...opt('suffixes', suffixes),
      };
    },
  }),
);

// -------------------------------------------------------------------------------------------
// Top -- an entry's value
// -------------------------------------------------------------------------------------------

/**
 * An entry's value, and the body a type written in place holds (§4.1, §4.2, §8.1) -- the wire's own `!type-ref`
 * before the value picks the member (§3.1). A body is written under the constructor its entry's facts name, never
 * one guessed from its shape; a body with no recorded head is written under its base constructor.
 *
 * A value of a namespace type or of a record type a schema declares has no member here: its tag is that schema's
 * type, which this table cannot name in advance.
 *
 * Read as a type written in place, the member's wire name is the inline type's `head`: `fromMember` hands it back
 * on the value, under {@link APPLIED}, for {@link typeInlineBinding} to take.
 */
const topBinding: VariantBinding<Top> = variant(
  {
    [metaName('record')]: recordBodyBinding,
    [metaName('array')]: arrayBodyBinding,
    [metaName('map')]: mapBodyBinding,
    [metaName('namespace')]: namespaceBodyBinding,
    [metaName('tuple')]: tupleBodyBinding,
    [metaName('choice')]: choiceBodyBinding,
    [metaName('enum_type')]: enumBodyBinding,
    [metaName('ref')]: refBodyBinding,
    [metaName('apply')]: applyBodyBinding,
    [metaName('dependent')]: dependentBodyBinding,
    [metaName('void_type')]: voidTypeBinding,
    [metaName('declared_type')]: declaredTypeBinding,
    [metaName('alias')]: aliasBinding,
    [metaName('extern')]: externBinding,
    [kernelName(NUMERIC_MAP, 'integer_type')]: integerTypeBinding,
    [kernelName(NUMERIC_MAP, 'float_type')]: floatTypeBinding,
    [kernelName(NUMERIC_MAP, 'decimal_type')]: decimalTypeBinding,
    [kernelName(NUMERIC_MAP, 'rational_type')]: rationalTypeBinding,
    [kernelName(NUMERIC_MAP, 'complex_type')]: complexTypeBinding,
    [kernelName(UNICODE_MAP, 'text_type')]: textTypeBinding,
    [kernelName(UNICODE_MAP, 'identifier_type')]: identifierTypeBinding,
    [kernelName(UNICODE_MAP, 'regex_type')]: regexTypeBinding,
    [kernelName(BINARY_MAP, 'bytes_type')]: bytesTypeBinding,
    [kernelName(NET_MAP, 'iri_type')]: iriTypeBinding,
    [kernelName(NET_MAP, 'uri_type')]: uriTypeBinding,
    [kernelName(NET_MAP, 'email_type')]: emailTypeBinding,
    [kernelName(NET_MAP, 'uuid_type')]: uuidTypeBinding,
    [kernelName(NET_MAP, 'ipv4_type')]: ipv4TypeBinding,
    [kernelName(NET_MAP, 'ipv6_type')]: ipv6TypeBinding,
    [kernelName(NET_MAP, 'cidr4_type')]: cidr4TypeBinding,
    [kernelName(NET_MAP, 'cidr6_type')]: cidr6TypeBinding,
    [kernelName(NET_MAP, 'mac_type')]: macTypeBinding,
    [kernelName(NET_MAP, 'hostname_type')]: hostnameTypeBinding,
    [kernelName(NET_MAP, 'host_type')]: hostTypeBinding,
    [kernelName(NET_MAP, 'media_type_type')]: mediaTypeTypeBinding,
    [kernelName(TEMPORAL_MAP, 'date_type')]: dateTypeBinding,
    [kernelName(TEMPORAL_MAP, 'time_type')]: timeTypeBinding,
    [kernelName(TEMPORAL_MAP, 'datetime_type')]: dateTimeTypeBinding,
    [kernelName(TEMPORAL_MAP, 'duration_type')]: durationTypeBinding,
    [kernelName(TEMPORAL_MAP, 'period_type')]: periodTypeBinding,
  },
  // Discriminated on the host value's own `kind`, every host kind having a member of its constructor's name.
  'kind',
  { fromMember: (value, wireName) => headed(value as Top, wireName) },
);

// The constructor a body is written under (§8.1) is a fact about the entry, not about the body. {@link headed}
// hands the variant the body tagged with that name under {@link APPLIED}, and `memberFor` honours the tag where
// the named member writes the body's own shape. A body with no recorded head is written under its base
// constructor.
const memberByWireName = new Map(topBinding.members.map((member) => [member.wireName, member]));
Object.assign(topBinding, {
  memberFor: (value: unknown) => {
    if (typeof value !== 'object' || value === null) return undefined;
    const held = value as Top & Headed;
    if (!('kind' in held) || held.kind === 'value_entry' || held.kind === 'incomplete') {
      return undefined;
    }
    const applied = held[APPLIED];
    const natural = memberByWireName.get(constructorPath(held));
    if (natural === undefined) return undefined;
    if (applied === undefined) return natural;
    const named = memberByWireName.get(applied);
    return named?.binding === natural.binding ? named : natural;
  },
});

/** A value, tagged with the constructor its entry's facts name (`head`), for {@link topBinding} to write under. */
function headed(body: Top, head: string | undefined): Top {
  return head === undefined ? body : Object.assign({}, body, { [APPLIED]: head });
}

/** `body` without the constructor {@link headed} tagged it with. */
function unheaded<T extends Top>(body: T & Headed): T {
  if (body[APPLIED] === undefined) return body;
  const { [APPLIED]: _head, ...rest } = body;
  void _head;
  return rest as unknown as T;
}

// -------------------------------------------------------------------------------------------
// Public surface
// -------------------------------------------------------------------------------------------

export {
  tokenFormFromWire,
  tokenFormToWire,
  voidTypeBinding,
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
  fieldRoleBinding,
  normalizationBinding,
  identifierBaseBinding,
  recordExtensionTypeBinding,
  complexComponentBinding,
  floatFormatBinding,
  bytesEncodingBinding,
  sourcePositionBinding,
  annotationBinding,
  annotationsBinding,
  typeRefBinding,
  typeRefAnnotatedBinding,
  typeExprBinding,
  typeInlineBinding,
  aliasBinding,
  externBinding,
  declaredTypeBinding,
  integerSizeBinding,
  recordFieldBinding,
  fieldGroupBinding,
  paramBinding,
  tupleElementBinding,
  recordBodyBinding,
  arrayBodyBinding,
  mapBodyBinding,
  namespaceBodyBinding,
  tupleBodyBinding,
  choiceBodyBinding,
  enumBodyBinding,
  refBodyBinding,
  applyBodyBinding,
  dependentBodyBinding,
  integerTypeBinding,
  floatTypeBinding,
  decimalTypeBinding,
  rationalTypeBinding,
  complexTypeBinding,
  textTypeBinding,
  bytesTypeBinding,
  identifierTypeBinding,
  regexTypeBinding,
  uriTypeBinding,
  iriTypeBinding,
  emailTypeBinding,
  uuidTypeBinding,
  dateTypeBinding,
  timeTypeBinding,
  dateTimeTypeBinding,
  durationTypeBinding,
  periodTypeBinding,
  ipv4TypeBinding,
  ipv6TypeBinding,
  cidr4TypeBinding,
  cidr6TypeBinding,
  macTypeBinding,
  topBinding,
  typeChainBinding,
  fieldMapBinding,
  declaredNameBinding,
  hostnameTypeBinding,
  hostTypeBinding,
  mediaTypeTypeBinding,
  headed,
};

/**
 * A ready-to-use table keyed by the kernel's own constructor/instance names, the way
 * `SchemaMetaNameBinder.INSTANCE` resolves a schema type name to a Java class -- covering exactly
 * the wire names {@link topBinding} matches on, plus the kernel's supporting records. A later work
 * package building the real `BindingRegistry`/reader wiring (definition resolution, linking) is
 * free to `chain()` this behind or in front of its own tables; this is deliberately not the full
 * `SchemaMetaNameBinder`-equivalent alias set (`type_name`/`param_name` -> `identifier`, and the
 * like), since those are entry *names*, not value shapes -- {@link topBinding} dispatches on the
 * applied-constructor tag a body's own wire form carries (`record`, `array`, `alias`, ...), and an
 * alias's own body reads through the `alias` tag like any other's, whether or not a use site elsewhere
 * names it (§8.3: a use site keeps the author's own name and is never rewritten past it).
 */
export const metaBindings: BindingRegistry = registry({
  ...Object.fromEntries(topBinding.members.map((member) => [member.wireName, member.binding])),
  [metaName('type_chain')]: typeChainBinding,
  [kernelName(NUMERIC_MAP, 'integer_size')]: integerSizeBinding,
  [metaName('record_field')]: recordFieldBinding,
  [metaName('field_group')]: fieldGroupBinding,
  [metaName('param')]: paramBinding,
  [metaName('tuple_element')]: tupleElementBinding,
  [metaName('type_ref')]: typeRefAnnotatedBinding,
  [metaName('type_inline')]: typeInlineBinding,
});
