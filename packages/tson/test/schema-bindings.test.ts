import { describe, expect, it } from 'vitest';
import type { Infer } from '../src/bind/binding.js';
import {
  annotationBinding,
  arrayBodyBinding,
  binaryTypeBinding,
  bigintBinding,
  booleanBinding,
  choiceBodyBinding,
  cidr4TypeBinding,
  cidr6TypeBinding,
  complexTypeBinding,
  dateTimeTypeBinding,
  dateTypeBinding,
  decimalBinding,
  decimalTypeBinding,
  durationTypeBinding,
  elementStateBinding,
  emailTypeBinding,
  enumBodyBinding,
  externBinding,
  fieldGroupBinding,
  fieldStateBinding,
  floatTypeBinding,
  identifierBinding,
  int32Binding,
  integerSizeBinding,
  integerTypeBinding,
  ipv4TypeBinding,
  ipv6TypeBinding,
  macTypeBinding,
  mapBodyBinding,
  metaBindings,
  offsetDateTimeBinding,
  offsetTimeBinding,
  rationalBinding,
  rationalTypeBinding,
  recordBodyBinding,
  recordFieldBinding,
  referenceBinding,
  regexTypeBinding,
  sourcePositionBinding,
  textBinding,
  textTypeBinding,
  tokenBinding,
  topBinding,
  tupleBodyBinding,
  tupleElementBinding,
  typeArgumentBinding,
  typeArgumentRefBinding,
  typeArgumentValueBinding,
  typeDefinitionBinding,
  typeKindBinding,
  typeRefBinding,
  unitBinding,
  unknownTypeBinding,
  uriTypeBinding,
  uuidTypeBinding,
  valueBinding,
} from '../src/schema/bindings.js';
import type { Decimal, Rational, Unit } from '../src/schema/meta/algebra.js';
import type {
  Annotation,
  Extern,
  Reference,
  Token,
  TypeArgument,
  TypeArgumentRef,
  TypeArgumentValue,
  TypeDefinition,
  TypeKind,
  TypeRef,
  Top,
  UnknownType,
} from '../src/schema/meta/typedef.js';
import type {
  ArrayBody,
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
} from '../src/schema/meta/bodies.js';
import type {
  BinaryType,
  EmailType,
  RegexType,
  TextType,
  UriType,
  UuidType,
} from '../src/schema/meta/atoms-text.js';
import type {
  ComplexType,
  DecimalType,
  FloatType,
  IntegerSize,
  IntegerType,
  RationalType,
} from '../src/schema/meta/atoms-numeric.js';
import type {
  DateTimeType,
  DateType,
  DurationType,
  OffsetDateTime,
  OffsetTime,
} from '../src/schema/meta/atoms-temporal.js';
import type {
  Cidr4Type,
  Cidr6Type,
  Ipv4Type,
  Ipv6Type,
  MacType,
} from '../src/schema/meta/atoms-network.js';
import type { SourcePosition } from '../src/schema/meta/position.js';
import type { PlainDateTime, PlainTime } from '../src/value/types.js';

/**
 * `schema/bindings.ts` -- Work package 12. These tests exist to satisfy the brief's own explicit
 * obligation ("Check Infer<> on each: the static type a binding infers must equal the hand-written
 * type in schema/meta/. If it does not, the binding is wrong, not the type.") plus runtime coverage
 * of the parts a static check alone cannot see: bridge round-trips, the `Top`/`TypeArgument`
 * variant dispatch, the `TypeRef`<->`TypeArgument` `lazy()` cycle, and `exactOptionalPropertyTypes`
 * compliance in every hand-written `construct()`.
 */

// -------------------------------------------------------------------------------------------
// Infer<> == the hand-written schema/meta type, for every exported binding (compile-time only).
// -------------------------------------------------------------------------------------------

type AssertExact<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : ['expected', B, 'got', A]
  : ['expected', B, 'got', A];
/** `const _check: AssertExact<Infer<typeof binding>, HandWrittenType> = true;` fails to compile -- with a message naming both sides -- whenever the two disagree. */

const _check1: AssertExact<Infer<typeof unitBinding>, Unit> = true;
const _check2: AssertExact<Infer<typeof rationalBinding>, Rational> = true;
const _check3: AssertExact<Infer<typeof decimalBinding>, Decimal> = true;
const _check4: AssertExact<Infer<typeof tokenBinding>, Token> = true;
const _check5: AssertExact<Infer<typeof valueBinding>, unknown> = true;
const _check6: AssertExact<Infer<typeof identifierBinding>, string> = true;
const _check7: AssertExact<Infer<typeof textBinding>, string> = true;
const _check8: AssertExact<Infer<typeof booleanBinding>, boolean> = true;
const _check9: AssertExact<Infer<typeof bigintBinding>, bigint> = true;
const _check10: AssertExact<Infer<typeof int32Binding>, number> = true;
const _check11: AssertExact<Infer<typeof typeKindBinding>, TypeKind> = true;
const _check12: AssertExact<Infer<typeof fieldStateBinding>, FieldState> = true;
const _check13: AssertExact<Infer<typeof elementStateBinding>, ElementState> = true;
const _check14: AssertExact<Infer<typeof sourcePositionBinding>, SourcePosition> = true;
const _check15: AssertExact<Infer<typeof annotationBinding>, Annotation> = true;
const _check16: AssertExact<Infer<typeof typeArgumentRefBinding>, TypeArgumentRef> = true;
const _check17: AssertExact<Infer<typeof typeArgumentValueBinding>, TypeArgumentValue> = true;
const _check18: AssertExact<Infer<typeof typeArgumentBinding>, TypeArgument> = true;
const _check19: AssertExact<Infer<typeof referenceBinding>, Reference> = true;
const _check20: AssertExact<Infer<typeof externBinding>, Extern> = true;
const _check21: AssertExact<Infer<typeof unknownTypeBinding>, UnknownType> = true;
const _check22: AssertExact<Infer<typeof integerSizeBinding>, IntegerSize> = true;
const _check23: AssertExact<Infer<typeof recordFieldBinding>, RecordField> = true;
const _check24: AssertExact<Infer<typeof fieldGroupBinding>, FieldGroup> = true;
const _check25: AssertExact<Infer<typeof tupleElementBinding>, TupleElement> = true;
const _check26: AssertExact<Infer<typeof recordBodyBinding>, RecordBody> = true;
const _check27: AssertExact<Infer<typeof arrayBodyBinding>, ArrayBody> = true;
const _check28: AssertExact<Infer<typeof mapBodyBinding>, MapBody> = true;
const _check29: AssertExact<Infer<typeof tupleBodyBinding>, TupleBody> = true;
const _check30: AssertExact<Infer<typeof choiceBodyBinding>, ChoiceBody> = true;
const _check31: AssertExact<Infer<typeof enumBodyBinding>, EnumBody> = true;
const _check32: AssertExact<Infer<typeof integerTypeBinding>, IntegerType> = true;
const _check33: AssertExact<Infer<typeof floatTypeBinding>, FloatType> = true;
const _check34: AssertExact<Infer<typeof decimalTypeBinding>, DecimalType> = true;
const _check35: AssertExact<Infer<typeof rationalTypeBinding>, RationalType> = true;
const _check36: AssertExact<Infer<typeof complexTypeBinding>, ComplexType> = true;
const _check37: AssertExact<Infer<typeof textTypeBinding>, TextType> = true;
const _check38: AssertExact<Infer<typeof binaryTypeBinding>, BinaryType> = true;
const _check39: AssertExact<Infer<typeof regexTypeBinding>, RegexType> = true;
const _check40: AssertExact<Infer<typeof uriTypeBinding>, UriType> = true;
const _check41: AssertExact<Infer<typeof emailTypeBinding>, EmailType> = true;
const _check42: AssertExact<Infer<typeof uuidTypeBinding>, UuidType> = true;
const _check43: AssertExact<Infer<typeof dateTypeBinding>, DateType> = true;
const _check44: AssertExact<Infer<typeof offsetTimeBinding>, OffsetTime> = true;
const _check45: AssertExact<Infer<typeof offsetDateTimeBinding>, OffsetDateTime> = true;
const _check46: AssertExact<Infer<typeof dateTimeTypeBinding>, DateTimeType> = true;
const _check47: AssertExact<Infer<typeof durationTypeBinding>, DurationType> = true;
const _check48: AssertExact<Infer<typeof ipv4TypeBinding>, Ipv4Type> = true;
const _check49: AssertExact<Infer<typeof ipv6TypeBinding>, Ipv6Type> = true;
const _check50: AssertExact<Infer<typeof cidr4TypeBinding>, Cidr4Type> = true;
const _check51: AssertExact<Infer<typeof cidr6TypeBinding>, Cidr6Type> = true;
const _check52: AssertExact<Infer<typeof macTypeBinding>, MacType> = true;
const _check53: AssertExact<Infer<typeof topBinding>, Top> = true;
const _check54: AssertExact<Infer<typeof typeDefinitionBinding>, TypeDefinition> = true;
const _check55: AssertExact<Infer<typeof typeRefBinding>, TypeRef> = true;

// -------------------------------------------------------------------------------------------
// Runtime coverage
// -------------------------------------------------------------------------------------------

describe('bridge leaves round-trip host <-> wire ([TSON-SCHEMA] §5.6, §9)', () => {
  it('decimalBinding: scale is the negated exponent (BigDecimal vs. unscaled*10^exponent)', () => {
    if (decimalBinding.kind !== 'bridge') throw new Error('expected a bridge');
    const decimal: Decimal = { unscaledValue: 12345n, scale: 2 };
    const wire = decimalBinding.toWire(decimal);
    expect(wire).toEqual({ unscaled: 12345n, exponent: -2 });
    expect(decimalBinding.fromWire(wire)).toEqual(decimal);
  });

  it('offsetTimeBinding: offsetSeconds <-> totalMinutes*60', () => {
    if (offsetTimeBinding.kind !== 'bridge') throw new Error('expected a bridge');
    const offsetTime: OffsetTime = {
      time: { hour: 10, minute: 30, second: 0, nanosecond: 0 },
      offsetSeconds: 3600,
    };
    const wire = offsetTimeBinding.toWire(offsetTime) as PlainTime;
    expect(wire.offset.totalMinutes).toBe(60);
    expect(offsetTimeBinding.fromWire(wire)).toEqual(offsetTime);
  });

  it('offsetDateTimeBinding: date passes through, time+offset reshape the same way', () => {
    if (offsetDateTimeBinding.kind !== 'bridge') throw new Error('expected a bridge');
    const offsetDateTime: OffsetDateTime = {
      date: { year: 2026, month: 8, day: 27 },
      time: { hour: 12, minute: 0, second: 0, nanosecond: 0 },
      offsetSeconds: -18000,
    };
    const wire = offsetDateTimeBinding.toWire(offsetDateTime) as PlainDateTime;
    expect(wire.date).toEqual(offsetDateTime.date);
    expect(wire.time.offset.totalMinutes).toBe(-300);
    expect(offsetDateTimeBinding.fromWire(wire)).toEqual(offsetDateTime);
  });

  it('tokenBinding: form casing round-trips (UNQUOTED <-> unquoted, etc.)', () => {
    if (tokenBinding.kind !== 'bridge') throw new Error('expected a bridge');
    const token: Token = { text: 'hello world', form: 'MULTI_LINE_QUOTED' };
    const wire = tokenBinding.toWire(token);
    expect(wire).toEqual({ text: 'hello world', form: 'multi-line' });
    expect(tokenBinding.fromWire(wire)).toEqual(token);
  });

  it('identifierBinding: a plain string round-trips through the raw lexeme, unquoted', () => {
    if (identifierBinding.kind !== 'bridge') throw new Error('expected a bridge');
    expect(identifierBinding.toWire('int32')).toEqual({ text: 'int32', form: 'unquoted' });
    expect(identifierBinding.fromWire({ text: 'int32', form: 'unquoted' })).toBe('int32');
  });

  it('int32Binding: bigint <-> number, both directions', () => {
    if (int32Binding.kind !== 'bridge') throw new Error('expected a bridge');
    expect(int32Binding.toWire(4)).toBe(4n);
    expect(int32Binding.fromWire(4n)).toBe(4);
  });

  it('sourcePositionBinding: "line:column:offset" per SourcePositionStringBridge.java', () => {
    if (sourcePositionBinding.kind !== 'bridge') throw new Error('expected a bridge');
    const position: SourcePosition = { line: 12, column: 3, offset: 481 };
    expect(sourcePositionBinding.toWire(position)).toBe('12:3:481');
    expect(sourcePositionBinding.fromWire('12:3:481')).toEqual(position);
  });
});

describe('topBinding -- the polymorphic type_definition.body ([TSON-SCHEMA] §4.1, §8.1)', () => {
  it('every member is keyed by the constructor name the resolved wire actually writes', () => {
    const names = topBinding.members.map((m) => m.wireName).sort();
    expect(names).toContain('record');
    expect(names).toContain('integer_type');
    expect(names).toContain('reference');
  });

  it('"set" and "array" both resolve to the same ArrayBody binding (confirmed against spec/m/meta-kernel-resolved.tn: enum_set\'s body reads !set)', () => {
    const arrayMember = topBinding.members.find((m) => m.wireName === 'array');
    const setMember = topBinding.members.find((m) => m.wireName === 'set');
    expect(setMember?.binding).toBe(arrayMember?.binding);
  });

  it('"value"/"identifier"/"void" all resolve to the same Unit binding (confirmed: all three read body: !unit {})', () => {
    const unitMember = topBinding.members.find((m) => m.wireName === 'unit');
    for (const name of ['value', 'identifier', 'void']) {
      expect(topBinding.members.find((m) => m.wireName === name)?.binding).toBe(
        unitMember?.binding,
      );
    }
  });

  it('is sealed, matching every other variant in this module', () => {
    expect(topBinding.sealed).toBe(true);
  });
});

describe('typeArgumentBinding -- the field-group choice ([TSON-SCHEMA] §5.11, §8.1)', () => {
  it('dispatches on the TypeScript-side kind discriminant', () => {
    const refValue: TypeArgumentRef = {
      kind: 'ref',
      ref: { name: 'text', arguments: [], annotations: [] },
    };
    const literalValue: TypeArgumentValue = {
      kind: 'value',
      value: { text: '3', form: 'UNQUOTED' },
    };
    expect(typeArgumentBinding.memberFor(refValue)?.wireName).toBe('ref');
    expect(typeArgumentBinding.memberFor(literalValue)?.wireName).toBe('value');
  });
});

describe('the TypeRef <-> TypeArgument declaration-order cycle ([TSON-SCHEMA] §5.10, §8.1)', () => {
  it('typeRefBinding\'s "arguments" element binding is lazy and resolves back to typeArgumentBinding', () => {
    const argumentsSlot = typeRefBinding.fields.find((f) => f.wireName === 'arguments');
    if (argumentsSlot === undefined) throw new Error('no arguments field');
    const argumentsArray = argumentsSlot.binding;
    if (argumentsArray.kind !== 'array') throw new Error('expected an array');
    const element = argumentsArray.element;
    if (element.kind !== 'lazy') throw new Error('expected the cycle-closing lazy()');
    expect(element.peek()).toBeUndefined();
    expect(element.get()).toBe(typeArgumentBinding);
  });

  it('typeArgumentRefBinding\'s own "ref" field resolves eagerly back to typeRefBinding (no cycle needed on this edge)', () => {
    const refSlot = typeArgumentRefBinding.fields[0];
    expect(refSlot?.wireName).toBe('name'); // TypeArgument.java: @Field("name") TypeRef ref
    if (refSlot?.binding.kind !== 'lazy')
      throw new Error('expected lazy (typeRefBinding not yet const-bound at this point)');
    expect(refSlot.binding.get()).toBe(typeRefBinding);
  });
});

describe('construct() round-trips the wire-name mapping ([TSON-SCHEMA] §8.1)', () => {
  it('typeRefBinding.construct builds a TypeRef from ordered slots', () => {
    const built = typeRefBinding.construct(['int32', [], []]);
    expect(built).toEqual({ name: 'int32', arguments: [], annotations: [] });
  });

  it('recordFieldBinding wire names match RecordField.java field-for-field (no @Field renames)', () => {
    expect(recordFieldBinding.fields.map((f) => f.wireName)).toEqual([
      'name',
      'type',
      'state',
      'value',
      'annotations',
    ]);
  });

  it('recordFieldBinding.construct omits an absent optional "value" rather than writing undefined (exactOptionalPropertyTypes)', () => {
    const type: TypeRef = { name: 'text', arguments: [], annotations: [] };
    const withoutValue = recordFieldBinding.construct(['x', type, 'REQUIRED', undefined, []]);
    expect('value' in withoutValue).toBe(false);
    const withValue = recordFieldBinding.construct([
      'x',
      type,
      'REQUIRED_DEFAULT',
      { text: '3', form: 'UNQUOTED' },
      [],
    ]);
    expect(withValue.value).toEqual({ text: '3', form: 'UNQUOTED' });
  });

  it('arrayBodyBinding wire names carry the Java @Field renames (element_type, unique_items, min_items, max_items)', () => {
    expect(arrayBodyBinding.fields.map((f) => f.wireName)).toEqual([
      'element_type',
      'state',
      'unordered',
      'unique_items',
      'min_items',
      'max_items',
    ]);
  });

  it('integerTypeBinding.construct synthesises kind and omits every absent bound', () => {
    const built = integerTypeBinding.construct([
      undefined,
      1n,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(built).toEqual({ kind: 'integer_type', min: 1n });
  });

  it('typeDefinitionBinding.construct synthesises no kind of its own (kind is a real, required field here) and omits absent optionals', () => {
    const body = unitBinding.construct([]);
    const built = typeDefinitionBinding.construct([
      undefined, // source
      'ATOM', // kind
      [], // parameters
      false, // constructor
      ['top'], // supertypes
      [], // subtypes
      undefined, // disjoint
      body, // body
      undefined, // position
      [], // annotations
    ]);
    expect(built.kind).toBe('ATOM');
    expect('source' in built).toBe(false);
    expect('disjoint' in built).toBe(false);
    expect('position' in built).toBe(false);
    expect(built.supertypes).toEqual(['top']);
  });

  it('the position slot is unbound (never matched against the wire by name), per @Unbound in TypeDefinition.java', () => {
    const positionSlot = typeDefinitionBinding.fields.find((f) => f.wireName === 'position');
    expect(positionSlot?.unbound).toBe(true);
    expect(typeDefinitionBinding.byWireName.has('position')).toBe(false);
  });
});

describe('metaBindings -- the constructor-name lookup table ([TSON-SCHEMA] §8.1)', () => {
  it('resolves every Top-variant wire name to the same binding topBinding itself uses', () => {
    for (const member of topBinding.members) {
      expect(metaBindings.get(member.wireName)).toBe(member.binding);
    }
  });

  it('resolves "type_definition" to typeDefinitionBinding', () => {
    expect(metaBindings.get('type_definition')).toBe(typeDefinitionBinding);
  });

  it('returns undefined for a name outside the kernel/meta/core vocabulary', () => {
    expect(metaBindings.get('not_a_real_type')).toBeUndefined();
  });
});
