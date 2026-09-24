/**
 * A decoded value reduced to what it *is* ([TSON-SCHEMA] §5.5), as one canonical string key, so
 * two spellings of one value compare equal by plain string equality — what a set's duplicate
 * check (`json/schema/array.ts`) and a map's duplicate-key check (`json/schema/map.ts`) both judge
 * membership on, and what a record's FIXED-field check (`json/schema/record.ts`) compares a
 * written value against the schema's own pin with.
 *
 * **Built from `value/equality.ts`'s own normalisations** — {@link decimalIdentityKey} for the
 * exact tier, `unicode/nfc.ts`'s NFC fold for text — the same reductions the TSON text reader
 * compares with (`reader/tree/equality.ts`'s own `valuesEqual`/`deepEqual`, now hosted in
 * `value/equality.ts` precisely so a consumer under the `src/json/**` zone, which may not import
 * `reader/`, can still reach them). This module's own contribution is collapsing each reduction to
 * **one string** rather than `deepEqual`'s recursive structural comparison, which is what lets
 * every duplicate check in this package be a plain `Map<string, …>` rather than an O(n) scan —
 * `design/json-schema-directed-reading.md`'s own `ValueIdentity` note ("the peer of
 * `tson-compiler`'s `ValueIdentity`, and one whose two copies must agree") is honoured at the
 * level of *what counts as equal*, which is what that note is about; the string encoding of it is
 * this module's own, since the Java reference compares by `Object.equals`/`hashCode` and
 * TypeScript has no equivalent to reuse.
 *
 * Two identity questions, matching the Java reference's own `ValueIdentity` split:
 *
 * - {@link identityOfHost} — a **decoded host value** (what `atom/forType.ts`'s parsers produce:
 *   `bigint`, {@link TsonDecimal}, a plain `number`, a `string`, `Uint8Array`, a temporal record,
 *   …), for an atom set element or a record's FIXED check.
 * - {@link identityOfNode} — a **decoded `JsonValue` tree** ([TSON-JSON] §6.4's pairs-form
 *   compound key, or a compound set element): a `JsonNumber` compares by value and not by lexeme
 *   (so `1`/`1.0` are one key), a `JsonString` compares under NFC, member order is dropped (§6.1.6
 *   gives it none), and the reduction recurses through arrays and objects since a compound key may
 *   itself hold one.
 */
import { toNfc } from '../../unicode/nfc.js';
import {
  decimalIdentityKey,
  isTsonDecimal,
  timeOfDayWrapped,
  isPlainTime,
  isPlainDateTime,
  dateTimeInstantSeconds,
} from '../../value/equality.js';
import type { Complex, Rational } from '../../value/types.js';
import { toBigDecimal, type JsonValue } from '../tree.js';

/** A value carrying its own identity beside it — a tree-mode atom reader's own node (`json/schema/atoms.ts`'s `treeAtomKeyedReader`), whose spelling and value space are two different things. */
export interface Identified {
  readonly node: JsonValue;
  readonly identity: string;
}

/** Whether `value` is a tree-mode atom's own {@link Identified} pair, rather than a plain `JsonValue` a compound reader produced directly. */
export function isIdentified(value: unknown): value is Identified {
  return (
    typeof value === 'object' &&
    value !== null &&
    'node' in value &&
    'identity' in value &&
    typeof (value as { identity: unknown }).identity === 'string'
  );
}

function bytesKey(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function isRational(record: Record<string, unknown>): record is Record<string, unknown> & Rational {
  return typeof record.numerator === 'bigint' && typeof record.denominator === 'bigint';
}

/** `a`/`b`'s (positive) greatest common divisor, `1n` when both are zero -- Euclid's algorithm over `bigint`. */
function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x === 0n ? 1n : x;
}

/**
 * `value` reduced to its lowest terms with a positive denominator -- [TSON-DATA] §5.6/[TSON-SCHEMA]
 * §5.5's value space: `numerator`/`denominator` are preserved exactly as parsed
 * (`value/types.ts`'s own `Rational` doc), so `"1/2"` and `"2/4"` are two different host values
 * that denote one rational, and only the *identity* reduces them, never the stored fields.
 */
function rationalIdentityKey(value: Rational): string {
  let { numerator, denominator } = value;
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  if (numerator === 0n) return 'r:0/1';
  const divisor = gcdBigInt(numerator, denominator);
  return `r:${(numerator / divisor).toString()}/${(denominator / divisor).toString()}`;
}

function isComplex(record: Record<string, unknown>): record is Record<string, unknown> & Complex {
  const real = record.real;
  const imaginary = record.imaginary;
  return (
    typeof real === 'object' &&
    real !== null &&
    isTsonDecimal(real as Record<string, unknown>) &&
    typeof imaginary === 'object' &&
    imaginary !== null &&
    isTsonDecimal(imaginary as Record<string, unknown>)
  );
}

/** `value`'s two {@link TsonDecimal} components, each reduced by {@link decimalIdentityKey} -- so `"1.50+2i"` and `"1.5+2i"` are one complex value, matching scale's own non-significance for the exact tier. */
function complexIdentityKey(value: Complex): string {
  return `c:${decimalIdentityKey(value.real)}+${decimalIdentityKey(value.imaginary)}i`;
}

/** `value` reduced to a canonical value-space identity string — the key two duplicate host values compare equal under. */
export function identityOfHost(value: unknown): string {
  if (isIdentified(value)) return value.identity;
  if (typeof value === 'boolean') return `b:${String(value)}`;
  if (typeof value === 'bigint') return `i:${value.toString()}`;
  if (typeof value === 'number') return `f:${Number.isNaN(value) ? 'nan' : value.toString()}`;
  if (typeof value === 'string') return `s:${toNfc(value)}`;
  if (value instanceof Uint8Array) return `y:${bytesKey(value)}`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (isTsonDecimal(record)) return `n:${decimalIdentityKey(record)}`;
    if (isPlainDateTime(record))
      return `dt:${dateTimeInstantSeconds(record).toString()}.${record.time.nanosecond.toString()}`;
    if (isPlainTime(record))
      return `t:${timeOfDayWrapped(record).toString()}.${record.nanosecond.toString()}`;
    if (isRational(record)) return rationalIdentityKey(record);
    if (isComplex(record)) return complexIdentityKey(record);
  }
  // Every other compound host shape (the network families: ipv4/ipv6/cidr4/cidr6/mac) has no
  // dedicated reduction here, because each already parses to a canonical field representation
  // (raw address octets, not the written text) -- two spellings of one address produce
  // structurally identical fields, so the generic fallback below already reduces them to one
  // key. A remaining, documented gap -- IDIOM-DEBT.md item 9's own closing paragraph -- is a
  // host shape added later that is *not* already canonical in its own fields; this reduction
  // would then need a dedicated case the way rational and complex now have one.
  const replacer = (_key: string, v: unknown): unknown =>
    typeof v === 'bigint' ? v.toString() : v;
  return `o:${JSON.stringify(value, replacer)}`;
}

/** `node` reduced the way {@link identityOfHost} reduces a decoded host value, but over a `JsonValue` tree — [TSON-JSON] §6.4's compound-key reduction. */
export function identityOfNode(node: JsonValue): string {
  switch (node.kind) {
    case 'number':
      return `n:${decimalIdentityKey(toBigDecimal(node))}`;
    case 'string':
      return `s:${toNfc(node.value)}`;
    case 'boolean':
      return `b:${String(node.value)}`;
    case 'null':
      return 'null';
    case 'array':
      return `[${node.elements.map(identityOfNode).join(',')}]`;
    case 'object': {
      // §6.1.6: member order carries no meaning, so two objects differing only in order are one
      // key -- sorted by the NFC-reduced name so the reduction itself carries no order either.
      const entries = [...node.members.entries()]
        .map(([name, value]) => `${toNfc(name)}:${identityOfNode(value)}`)
        .sort();
      return `{${entries.join(',')}}`;
    }
  }
}
