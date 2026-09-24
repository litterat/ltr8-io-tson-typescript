/**
 * `JsonValue`: a sealed, immutable tree over RFC 8259's six value kinds — the JSON encoding's
 * schemaless value model, matching `tree/nodes.ts`'s relationship to the TSON text encoding.
 *
 * **Shaped and named after [JEP 540](https://openjdk.org/jeps/540)**, the JDK's forthcoming
 * `jdk.incubator.json` — six kinds, `get`/`tryGet`/`tryValue` navigation, `as*` conversions, `of`
 * factories — mirroring the reference implementation's own choice (`design/json-lexer-stream-tree.md`):
 * "a consumer moving between the two learns one value model, and a bridge is later a mapping
 * rather than a rewrite". **This is a faithful JSON model, not a TSON one**: {@link JsonNull} is a
 * real value here, because at this layer it is one — [TSON-JSON] §7 makes JSON `null` the absent
 * sentinel's spelling *at a typed position*, and a schemaless tree has none of those (`json/index.ts`'s
 * own top note has the full reasoning for why this encoding has no schema-free record/map reading
 * to resolve `null` against in the first place).
 *
 * **No `Node` suffix, deliberately, unlike `tree/nodes.ts`.** `CLAUDE.md`'s rule exists because
 * `Record`/`Map`/`Array` are TypeScript globals that a same-named type would shadow for the whole
 * file; none of `JsonObject`/`JsonArray`/`JsonString`/`JsonNumber`/`JsonBoolean`/`JsonNull` collide
 * with a global, so the rule's own justification does not reach them, and keeping the JEP 540
 * spellings verbatim is what lets a consumer arriving from that JDK API recognise this module.
 *
 * **Nodes carry no source position**, matching `tree/nodes.ts` and for the same reason: equality
 * is over content, so two parses of one document are equal, and a value model holds values. A
 * parse failure is reported with a {@link Position} already (`json/stream.ts`'s events carry one);
 * what is lost is a position on a navigation failure, which names the step and the value instead.
 *
 * **`JsonNumber` holds the exact source lexeme, and equality is over it** — `1`, `1.0`, `1e0` are
 * three distinct nodes. [TSON-SCHEMA] §5.5 makes equality a property of a *value space*, and a
 * value space comes from a type, which this schemaless layer has none of; under a schema the three
 * are one `number` (§5.3). {@link toBigDecimal} is the one call for numeric comparison.
 *
 * **What this module keeps from JEP 540 on purpose**: `get`/`asString`/… throw, where
 * `tree/nodes.ts`'s own `Get`/`At` return a `MissingNode` instead. One method name must not carry
 * opposite semantics on the two value models a consumer of this library holds — see this file's
 * own {@link TsonJsonValueError} doc, and `IDIOM-DEBT.md`'s entry for the parallel JSON stack.
 */
import { TsonError } from '../core/errors.js';

// ---------------------------------------------------------------------------------------------
// The node union
// ---------------------------------------------------------------------------------------------

/** A JSON value — the sealed union this module exists to define. Discriminated on `kind`. */
export type JsonValue = JsonObject | JsonArray | JsonString | JsonNumber | JsonBoolean | JsonNull;

/**
 * A JSON object: member names to values, in document order. **Order is preserved and means
 * nothing** ([TSON-JSON] §6.1.6: "a decoder that requires an order has invented a rule this
 * document does not contain") — keeping it is what lets a document re-emit as it arrived, and
 * equality is over the member set rather than the order (`equalJsonValue`, below).
 */
export interface JsonObject {
  readonly kind: 'object';
  readonly members: ReadonlyMap<string, JsonValue>;
}

export interface JsonArray {
  readonly kind: 'array';
  readonly elements: readonly JsonValue[];
}

export interface JsonString {
  readonly kind: 'string';
  readonly value: string;
}

/**
 * A JSON number, held as the exact source lexeme — see this file's own top note on why equality
 * is over the lexeme and not the numeric value.
 */
export interface JsonNumber {
  readonly kind: 'number';
  readonly literal: string;
}

export interface JsonBoolean {
  readonly kind: 'boolean';
  readonly value: boolean;
}

export interface JsonNull {
  readonly kind: 'null';
}

// ---------------------------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------------------------

export function jsonObject(members: ReadonlyMap<string, JsonValue>): JsonObject {
  return { kind: 'object', members: new Map(members) };
}

export function jsonArray(elements: readonly JsonValue[]): JsonArray {
  return { kind: 'array', elements: [...elements] };
}

export function jsonString(value: string): JsonString {
  return { kind: 'string', value };
}

/**
 * From a lexeme, which must be a well-formed RFC 8259 number (`json/lexer.ts` produces one; this
 * constructor is also reachable directly, so it checks again rather than trusting the caller —
 * `jsonValueToText`'s own contract is to emit valid JSON, which a malformed lexeme would break
 * silently).
 * @throws TsonError when `literal` is not RFC 8259's `number` grammar exactly.
 */
export function jsonNumber(literal: string): JsonNumber {
  if (!isWellFormedJsonNumberLiteral(literal)) {
    throw new TsonError(`'${literal}' is not a well-formed RFC 8259 number lexeme`);
  }
  return { kind: 'number', literal };
}

/** RFC 8259 §6's `number` grammar, checked whole-string and hand-written rather than a host regex, matching this module's own {@link parseJsonNumberLiteral}. */
function isWellFormedJsonNumberLiteral(literal: string): boolean {
  const n = literal.length;
  let i = 0;
  if (i < n && literal.charAt(i) === '-') i += 1;
  if (i >= n) return false;
  if (isAsciiDigit(literal, i) && literal.charAt(i) === '0') {
    i += 1;
  } else if (isAsciiDigit(literal, i)) {
    while (i < n && isAsciiDigit(literal, i)) i += 1;
  } else {
    return false;
  }
  if (i < n && literal.charAt(i) === '.') {
    i += 1;
    if (!(i < n && isAsciiDigit(literal, i))) return false;
    while (i < n && isAsciiDigit(literal, i)) i += 1;
  }
  if (i < n && (literal.charAt(i) === 'e' || literal.charAt(i) === 'E')) {
    i += 1;
    if (i < n && (literal.charAt(i) === '+' || literal.charAt(i) === '-')) i += 1;
    if (!(i < n && isAsciiDigit(literal, i))) return false;
    while (i < n && isAsciiDigit(literal, i)) i += 1;
  }
  return i === n;
}

/** From a `bigint`, in plain decimal — no fraction, no exponent, matching §5.3's encode rule for the exact tier. */
export function jsonNumberOfBigInt(value: bigint): JsonNumber {
  return jsonNumber(value.toString());
}

const TRUE: JsonBoolean = { kind: 'boolean', value: true };
const FALSE: JsonBoolean = { kind: 'boolean', value: false };

export function jsonBoolean(value: boolean): JsonBoolean {
  return value ? TRUE : FALSE;
}

/** The one `JsonNull` value — see {@link JSON_NULL}. */
export const JSON_NULL: JsonNull = { kind: 'null' };

export function jsonNull(): JsonNull {
  return JSON_NULL;
}

export const EMPTY_JSON_OBJECT: JsonObject = { kind: 'object', members: new Map() };
export const EMPTY_JSON_ARRAY: JsonArray = { kind: 'array', elements: [] };

// ---------------------------------------------------------------------------------------------
// Equality — over content, matching `tree/nodes.ts`'s own tree (a value model holds values).
// An object's member *order* never participates (§6.1.6); a number's *lexeme* always does (this
// file's own top note).
// ---------------------------------------------------------------------------------------------

/** Structural equality over `JsonValue` content — order-insensitive for an object, lexeme-exact for a number. */
export function equalJsonValue(a: JsonValue, b: JsonValue): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'object': {
      const other = b as JsonObject;
      if (a.members.size !== other.members.size) return false;
      for (const [name, value] of a.members) {
        const otherValue = other.members.get(name);
        if (otherValue === undefined || !equalJsonValue(value, otherValue)) return false;
      }
      return true;
    }
    case 'array': {
      const other = b as JsonArray;
      if (a.elements.length !== other.elements.length) return false;
      return a.elements.every((element, i) => {
        const otherElement = other.elements[i];
        return otherElement !== undefined && equalJsonValue(element, otherElement);
      });
    }
    case 'string':
      return a.value === (b as JsonString).value;
    case 'number':
      return a.literal === (b as JsonNumber).literal;
    case 'boolean':
      return a.value === (b as JsonBoolean).value;
    case 'null':
      return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Navigation and conversion, JEP 540's own vocabulary, restated as plain functions rather than
// instance methods — this module has no class to hang them on, matching `CLAUDE.md`'s own
// "idiomatic TypeScript ... no class-for-class translation".
// ---------------------------------------------------------------------------------------------

/**
 * A navigation or conversion step that found the wrong shape — the JSON tree's own analogue of
 * JEP 540's `JsonValue` throwing accessors. Distinct from every error in `core/errors.ts`: it
 * names a step through an *already-parsed* value with no schema behind it, which no TSON-text
 * error shape describes. It keeps the `Tson` prefix (`CLAUDE.md`'s "the `Tson` prefix is for
 * errors") even though it never comes from reading a document — an error name appears verbatim
 * in a stack trace and in `instanceof` checks across bundle boundaries, and that reason applies to
 * this error exactly as it does to every other one this library raises.
 */
export class TsonJsonValueError extends TsonError {
  override readonly name = 'TsonJsonValueError';
}

function kindName(value: JsonValue): string {
  switch (value.kind) {
    case 'object':
      return 'an object';
    case 'array':
      return 'an array';
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'null':
      return 'null';
  }
}

function notA(value: JsonValue, wanted: string): TsonJsonValueError {
  return new TsonJsonValueError(`this value is ${kindName(value)}, not ${wanted}`);
}

/** The value of member `name`. @throws TsonJsonValueError if `value` is not an object, or has no such member */
export function get(value: JsonValue, name: string): JsonValue {
  if (value.kind !== 'object') {
    throw new TsonJsonValueError(
      `${kindName(value)} has no members, so '${name}' cannot be read from it`,
    );
  }
  const member = value.members.get(name);
  if (member === undefined) {
    const keys = [...value.members.keys()];
    throw new TsonJsonValueError(
      `this object has no member '${name}'; it has ${keys.length === 0 ? 'none' : `[${keys.join(', ')}]`}`,
    );
  }
  return member;
}

/** The element at `index`. @throws TsonJsonValueError if `value` is not an array, or has no such element */
export function at(value: JsonValue, index: number): JsonValue {
  if (value.kind !== 'array') {
    throw new TsonJsonValueError(
      `${kindName(value)} has no elements, so index ${String(index)} cannot be read from it`,
    );
  }
  const element = value.elements[index];
  if (element === undefined) {
    throw new TsonJsonValueError(
      `this array has ${String(value.elements.length)} elements, so index ${String(index)} cannot be read from it`,
    );
  }
  return element;
}

/** The value of member `name`, or `undefined` if `value` is not an object or has no such member. */
export function tryGet(value: JsonValue, name: string): JsonValue | undefined {
  return value.kind === 'object' ? value.members.get(name) : undefined;
}

/** The element at `index`, or `undefined` if `value` is not an array or has no such element. */
export function tryAt(value: JsonValue, index: number): JsonValue | undefined {
  return value.kind === 'array' ? value.elements[index] : undefined;
}

/** `value`, or `undefined` if it is {@link JsonNull} — the one-call form of "a value, if there is one" (JEP 540's `tryValue`). */
export function tryValue(value: JsonValue): JsonValue | undefined {
  return value.kind === 'null' ? undefined : value;
}

export function asString(value: JsonValue): string {
  if (value.kind !== 'string') throw notA(value, 'a string');
  return value.value;
}

export function asBoolean(value: JsonValue): boolean {
  if (value.kind !== 'boolean') throw notA(value, 'a boolean');
  return value.value;
}

/** This object's members, unmodifiable. @throws TsonJsonValueError unless `value` is a {@link JsonObject} */
export function asMap(value: JsonValue): ReadonlyMap<string, JsonValue> {
  if (value.kind !== 'object') throw notA(value, 'an object');
  return value.members;
}

/** This array's elements, unmodifiable. @throws TsonJsonValueError unless `value` is a {@link JsonArray} */
export function asList(value: JsonValue): readonly JsonValue[] {
  if (value.kind !== 'array') throw notA(value, 'an array');
  return value.elements;
}

/**
 * The value exactly, as `{ unscaled, exponent }` (`value/types.ts`'s `TsonDecimal` shape) — full
 * precision, never lossy: the lexeme is RFC 8259, which this parses digit by digit.
 * @throws TsonJsonValueError unless `value` is a {@link JsonNumber}
 */
export function toBigDecimal(value: JsonValue): { unscaled: bigint; exponent: number } {
  if (value.kind !== 'number') throw notA(value, 'a number');
  return parseJsonNumberLiteral(value.literal);
}

/**
 * The exponent magnitude past which this function refuses to materialise `10n ** exponent` at
 * all, rather than let a handful of exponent digits in the source demand a `bigint` with a
 * million-plus decimal digits no legitimate integer literal needs. Not a §3.1 rule — this port's
 * own bound against an exponent that costs O(2^digits) to reject the ordinary way (`asBigInt`
 * below finding a nonzero remainder only after building the divisor). One million digits is a
 * few tens of milliseconds either side of the check; nothing a real document sends needs more.
 */
const MAX_MATERIALISED_EXPONENT_MAGNITUDE = 1_000_000;

/**
 * @throws TsonJsonValueError unless `value` is a {@link JsonNumber} exactly representable as a `bigint`
 * (no fractional part after removing trailing zeros), and its exponent's magnitude is at most
 * {@link MAX_MATERIALISED_EXPONENT_MAGNITUDE}.
 */
export function asBigInt(value: JsonValue): bigint {
  if (value.kind !== 'number') throw notA(value, 'a number');
  const { unscaled, exponent } = parseJsonNumberLiteral(value.literal);
  if (Math.abs(exponent) > MAX_MATERIALISED_EXPONENT_MAGNITUDE) {
    throw new TsonJsonValueError(
      `${value.literal}'s exponent is too large to materialise as an exact integer (this port ` +
        `refuses past a magnitude of ${MAX_MATERIALISED_EXPONENT_MAGNITUDE.toString()})`,
    );
  }
  if (exponent >= 0) return unscaled * 10n ** BigInt(exponent);
  const divisor = 10n ** BigInt(-exponent);
  if (unscaled % divisor !== 0n) {
    throw new TsonJsonValueError(`${value.literal} is not an integer`);
  }
  return unscaled / divisor;
}

/**
 * @throws TsonJsonValueError unless `value` is a {@link JsonNumber} exactly representable as a
 * safe-integer `number` — never rounded (§3.1: "an implementation that cannot represent the
 * digits MUST error, never round silently").
 */
export function asInt(value: JsonValue): number {
  const big = asBigInt(value);
  const asNumber = Number(big);
  if (!Number.isSafeInteger(asNumber) || BigInt(asNumber) !== big) {
    throw new TsonJsonValueError(
      `${value.kind === 'number' ? value.literal : ''} is not exactly representable as a safe integer`,
    );
  }
  return asNumber;
}

/**
 * The nearest `number`, rounding where the digits do not fit — the one conversion allowed to lose
 * (approximate atoms round onto the binary grid by their own contract, §5.4).
 * @throws TsonJsonValueError unless `value` is a {@link JsonNumber}
 */
export function asDouble(value: JsonValue): number {
  if (value.kind !== 'number') throw notA(value, 'a number');
  return Number(value.literal);
}

/**
 * Parses an RFC 8259 number lexeme into `{ unscaled, exponent }` such that
 * `value = unscaled * 10^exponent` — no floating-point intermediate, so `199.90` and
 * `1234567890123456789012345.6789` both survive exactly, and the exponent digits themselves are
 * read through `bigint`, never `Number()`, so an exponent run too long to fit a JS number errors
 * rather than silently rounding or overflowing to `Infinity` (§3.1: "an implementation that
 * cannot represent the digits MUST error, never round silently" — this is that rule applied to
 * the exponent, not only the mantissa). This is the read half of §5.3's "digits and scale are
 * preserved", shared by every caller that needs the exact numeric value rather than the lexeme
 * ({@link toBigDecimal}, {@link asBigInt}, {@link asInt} above).
 * @throws TsonJsonValueError when `literal` is not a well-formed RFC 8259 number, or its exponent
 * does not fit exactly in a JS safe integer.
 */
export function parseJsonNumberLiteral(literal: string): { unscaled: bigint; exponent: number } {
  if (!isWellFormedJsonNumberLiteral(literal)) {
    throw new TsonJsonValueError(`'${literal}' is not a well-formed RFC 8259 number lexeme`);
  }
  let i = 0;
  let negative = false;
  if (literal.charAt(i) === '-') {
    negative = true;
    i += 1;
  }
  let intPart = '';
  while (i < literal.length && isAsciiDigit(literal, i)) {
    intPart += literal.charAt(i);
    i += 1;
  }
  let fracPart = '';
  if (literal.charAt(i) === '.') {
    i += 1;
    while (i < literal.length && isAsciiDigit(literal, i)) {
      fracPart += literal.charAt(i);
      i += 1;
    }
  }
  let explicitExponent = 0n;
  const e = literal.charAt(i);
  if (e === 'e' || e === 'E') {
    i += 1;
    let expNegative = false;
    if (literal.charAt(i) === '+') {
      i += 1;
    } else if (literal.charAt(i) === '-') {
      expNegative = true;
      i += 1;
    }
    let expDigits = '';
    while (i < literal.length && isAsciiDigit(literal, i)) {
      expDigits += literal.charAt(i);
      i += 1;
    }
    const magnitude = BigInt(expDigits === '' ? '0' : expDigits);
    explicitExponent = expNegative ? -magnitude : magnitude;
  }
  const digits = intPart + fracPart;
  const magnitude = BigInt(digits === '' ? '0' : digits);
  const exponent = toSafeExponent(explicitExponent - BigInt(fracPart.length), literal);
  return { unscaled: negative ? -magnitude : magnitude, exponent };
}

/** `value`, exactly as a JS `number` — throwing rather than rounding or overflowing when it does not fit one exactly (`Number.isSafeInteger`'s own bound). */
function toSafeExponent(value: bigint, literal: string): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber) || BigInt(asNumber) !== value) {
    throw new TsonJsonValueError(
      `'${literal}' has an exponent too large to represent exactly as a safe integer (§3.1 ` +
        `requires an error here, never a silently rounded scale)`,
    );
  }
  return asNumber;
}

function isAsciiDigit(text: string, i: number): boolean {
  const c = text.charCodeAt(i);
  return c >= 0x30 && c <= 0x39;
}

// Serialization (`toJsonText`/`toDisplayString`) lives in `json/write.ts` rather than here, so
// this module never depends on the emitter — `json/write.ts` imports `JsonValue` from here, not
// the reverse, keeping the dependency one-directional.
