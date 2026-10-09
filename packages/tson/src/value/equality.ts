/**
 * Structural equality over the host {@link AtomValue} shapes the built-in vocabulary produces --
 * the value-identity layer both encodings' readers compare a document-stated value against a
 * schema-derived one with (Part 2 §5.5, §5.7; [TSON-DATA] §2.6, §5.2). Lives here, outside the
 * TSON text encoding's `reader/` module tree, so a consumer that must not depend on that tree --
 * `src/json/**`'s own ESLint zone (`eslint.config.js`) -- can still reach the one value-identity
 * function every reader in this package compares by, rather than writing a second
 * (`design/json-schema-directed-reading.md`'s `ValueIdentity` note: "the peer of
 * `tson-compiler`'s `ValueIdentity`, and one whose two copies must agree"). `reader/tree/equality.ts`
 * re-exports {@link deepEqual} and adds `valuesEqual`, the one specialisation that needs
 * `tree/nodes.ts`'s `Value` type -- a type `value/` must not import, per `tree/`'s own zone
 * ("`tree/` may import only itself, `core/`, `annotations/` and `value/`").
 *
 * **Value identity, not spelling equality.** Two gaps a field-by-field structural comparison would
 * get wrong, both fixed by normalising *in the comparison*, never in the value stored on either
 * tree:
 *
 * - **Scale is a spelling.** `1`, `1.0` and `1.00` are one `number` value, and `199.90`/`199.9` one
 *   decimal -- {@link TsonDecimal}'s `unscaled`/`exponent` pair is compared by exact value
 *   ({@link compareDecimal}, which aligns exponents before comparing), never by matching fields.
 * - **`time` and `datetime` compare as instants ([TSON-DATA] §5.4).** A `!datetime` is the
 *   instant on the UTC timeline -- {@link compareDateTime} already reads that way for ordering
 *   (`atom/temporal/rfc3339.ts`), and a full date absorbs any day-boundary crossing, so equality
 *   reuses it unchanged. A bare `!time` is the *time-of-day* in UTC on `[00:00:00, 24:00:00)`,
 *   which **wraps**: with no date to absorb a crossing, `23:30:00-02:00` and `01:30:00Z` are one
 *   value (the RFC 3339 example [TSON-DATA] §5.4 itself gives), so identity reduces the
 *   offset-adjusted instant modulo one day ({@link timeOfDayWrapped}) before comparing.
 *
 *   **This is deliberately not what {@link compareTime} does**, and that is a known, open
 *   divergence rather than an oversight: [TSON-DATA] §5.4 states "equality, ordering and bounds
 *   compare the instant" for `!time` in one breath, but {@link compareTime} (unchanged here, and
 *   used unmodified by `atom/temporal/time.ts`'s `min`/`max` bound checks) compares the
 *   offset-adjusted instant *without* wrapping, so a bound or an ordering comparison spanning a
 *   day boundary and this module's own equality can disagree on the same pair of values. Bringing
 *   ordering and bounds in line with equality is out of this change's scope -- it would alter
 *   validation behaviour for every existing `time_type` `min`/`max` facet, not just add a missing
 *   check -- so it is left exactly as it was and reported rather than silently changed either way.
 * - **Annotations are not part of a value's identity** ([TSON-DATA] §2.6: "A key's annotations
 *   and type annotation do not participate in identity at any layer"). Skipped structurally, by
 *   key, wherever both sides of a comparison carry an `annotations` field.
 * - **Text compares under NFC, a `rational` by cross-multiplication, and a NaN as one canonical
 *   value.** [TSON-DATA] §7.2.1 read narrowly could mean a plain string stays spelling-exact for
 *   comparison too ("two string values ... remain distinct strings") -- but that line is about
 *   what a decoded value *keeps* (spelling is preserved here exactly as scale and offset are, this
 *   note's own point above), not about what two spellings compare *as*. The reference
 *   implementation's own `ValueIdentity` (`tson-compiler` and `tson-json` alike) NFC-folds every
 *   string for comparison, meta.tn's own `rational_type` doc states the cross-multiplication rule
 *   outright ("2/4 equals 1/2"), and IEEE 754-2019 makes every NaN one value regardless of
 *   payload. This module follows the reference on all three -- a reported, open reading of
 *   [TSON-DATA] §7.2.1 (`IDIOM-DEBT.md` has the pinned rationale) chosen because the narrower one
 *   would put this module's own two functions, {@link deepEqual} and {@link identityKey}, in
 *   disagreement with each other over the very comparisons both encodings' readers must not
 *   disagree on.
 */
import { compareDecimal } from '../atom/numeric/decimalMath.js';
import {
  compareDateTime,
  daysFromCivil,
  // Referenced only from a TSDoc {@link} tag above, which the unused-vars rule cannot see -- see
  // `atom/contract.ts`'s own copy of this note.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  compareTime,
  type ComparableTime,
  type DateFields,
} from '../atom/temporal/rfc3339.js';
import { toNfc } from '../unicode/nfc.js';
import { declaredOrder, sameMembers } from './orderedness.js';
import type { Complex, PlainDateTime, PlainTime, Rational, TsonDecimal } from './types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value` carries `unscaled`/`exponent` (§5.6's exact-decimal shape, {@link TsonDecimal}) -- this module's own copy of `write/atomFraming.ts`'s shape guard. */
export function isTsonDecimal(
  value: Record<string, unknown>,
): value is Record<string, unknown> & TsonDecimal {
  return 'unscaled' in value && 'exponent' in value;
}

/** `value` carries `date`/`time` ({@link PlainDateTime}). */
export function isPlainDateTime(
  value: Record<string, unknown>,
): value is Record<string, unknown> & PlainDateTime {
  return 'date' in value && 'time' in value;
}

/** `value` carries `hour`/`minute`/`offset` ({@link PlainTime}), and no `date` -- {@link PlainDateTime} has both. */
export function isPlainTime(
  value: Record<string, unknown>,
): value is Record<string, unknown> & PlainTime {
  return 'hour' in value && 'minute' in value && 'offset' in value && !('date' in value);
}

/** {@link PlainTime}'s own `UtcOffset.totalMinutes` field, adapted to {@link ComparableTime}'s `offsetSeconds`. */
function toComparableTime(value: PlainTime): ComparableTime {
  return {
    hour: value.hour,
    minute: value.minute,
    second: value.second,
    nanosecond: value.nanosecond,
    offsetSeconds: value.offset.totalMinutes * 60,
  };
}

/** {@link PlainDateTime.date}, already {@link DateFields}-shaped. */
function toDateFields(value: PlainDateTime): DateFields {
  return value.date;
}

const SECONDS_PER_DAY = 86400;

/**
 * `value`'s offset-adjusted time-of-day, reduced into `[0, 86400)` seconds since UTC midnight --
 * the identity a bare `!time` compares by (this module's own top note): unlike
 * {@link compareTime}'s ordering, a day-boundary crossing wraps rather than landing outside the
 * range, so `23:30:00-02:00` (raw instant one day ahead) and `01:30:00Z` land on the same slot.
 */
export function timeOfDayWrapped(value: PlainTime): number {
  const raw = value.hour * 3600 + value.minute * 60 + value.second - value.offset.totalMinutes * 60;
  return ((raw % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
}

/**
 * `value`'s offset-adjusted instant in whole seconds since the epoch of its own calendar (no
 * wrapping -- a full date absorbs a day-boundary crossing, matching {@link compareDateTime}), for
 * a datetime identity key that agrees with equality without running a comparison.
 */
export function dateTimeInstantSeconds(value: PlainDateTime): number {
  return (
    daysFromCivil(value.date.year, value.date.month, value.date.day) * SECONDS_PER_DAY +
    value.time.hour * 3600 +
    value.time.minute * 60 +
    value.time.second -
    value.time.offset.totalMinutes * 60
  );
}

/**
 * A canonical string key for `value`'s numeric identity -- `unscaled`/`exponent` reduced so that
 * trailing zeros are absorbed into the exponent (`1.50` and `1.5` produce the same key), matching
 * what {@link compareDecimal} decides numerically. For bucketing a decimal by value ahead of an
 * exact {@link deepEqual}/{@link compareDecimal} comparison -- never for display or storage, where
 * the written scale is preserved untouched (this module's own top note).
 */
export function decimalIdentityKey(value: TsonDecimal): string {
  let { unscaled } = value;
  let { exponent } = value;
  if (unscaled === 0n) return '0e0';
  while (unscaled % 10n === 0n) {
    unscaled /= 10n;
    exponent += 1;
  }
  return `${unscaled.toString()}e${exponent.toString()}`;
}

/** Deep structural equality over two arbitrary host values -- primitives, `bigint`, `Uint8Array`, arrays, and plain records, recursively -- normalising decimal scale, temporal offset, text NFC form, rational reduction and NaN identity to value identity (this module's own top note) rather than comparing fields verbatim. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    return typeof a === typeof b && a === b;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return toNfc(a) === toNfc(b);
  }
  if (typeof a === 'number' && typeof b === 'number') {
    // Reached only when `a !== b` already failed above, so two ordinary reals are correctly
    // `false` here too -- this is IEEE 754-2019's "every NaN denotes the canonical quiet NaN"
    // ([TSON-DATA] §5.6), the one case a real number can equal a different-bit-pattern real
    // number under value identity without `===` already having said so.
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((element, i) => deepEqual(element, b[i]));
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) {
      if (!b.has(key) || !deepEqual(value, b.get(key))) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    if (isTsonDecimal(a) && isTsonDecimal(b)) {
      return compareDecimal(a, b) === 0;
    }
    if (isPlainDateTime(a) && isPlainDateTime(b)) {
      return (
        compareDateTime(
          toDateFields(a),
          toComparableTime(a.time),
          toDateFields(b),
          toComparableTime(b.time),
        ) === 0
      );
    }
    if (isPlainTime(a) && isPlainTime(b)) {
      return timeOfDayWrapped(a) === timeOfDayWrapped(b) && a.nanosecond === b.nanosecond;
    }
    if (isRationalValue(a) && isRationalValue(b)) {
      // meta.tn's own doc: "the token is preserved as written ... equality and constraints
      // operate on the value (2/4 equals 1/2)" -- {@link rationalIdentityKey}'s reduction to
      // lowest terms is exactly that value, so two rationals compare equal by it without a
      // separate cross-multiplication here.
      return rationalIdentityKey(a) === rationalIdentityKey(b);
    }
    // [TSON-DATA] §2.6: annotations "do not participate in identity at any layer" -- every
    // `Value` tree node but `MissingNode` carries its own `annotations` (`tree/nodes.ts`), and
    // this module's top note is where that rule reaches equality. Skipped only when BOTH sides
    // carry the key, so a shape that genuinely has no `annotations` (a bare host atom value, or
    // `MissingNode`) still compares every key it does have -- this never manufactures equality
    // between two objects of different shapes, only ignores one key both share.
    const ignoreAnnotations = 'annotations' in a && 'annotations' in b;
    const keysOf = (value: Record<string, unknown>): string[] =>
      ignoreAnnotations
        ? Object.keys(value).filter((key) => key !== 'annotations')
        : Object.keys(value);
    const aKeys = keysOf(a);
    const bKeys = keysOf(b);
    if (aKeys.length !== bKeys.length) return false;
    // [TSON-SCHEMA] §7.5: an array or map node whose type says `ordered: false` is its members,
    // not their sequence.
    const unordered = declaredOrder(a) === false || declaredOrder(b) === false;
    return aKeys.every((key) => {
      if (!Object.hasOwn(b, key)) return false;
      const left = a[key];
      const right = b[key];
      if (unordered && (key === 'elements' || key === 'entries')) {
        if (Array.isArray(left) && Array.isArray(right)) {
          return sameMembers(left as unknown[], right as unknown[], deepEqual);
        }
      }
      return deepEqual(left, right);
    });
  }
  return false;
}

// ── `identityKey`: a decoded host value's identity, as one string ────────────────────────────
//
// {@link deepEqual} answers one comparison at a time; a set's duplicate check, a map's key
// identity and a record's FIXED-field check all want *membership* -- "is this value already in
// the set/map/pin table" -- which a pairwise comparator turns into an O(n) scan. {@link
// identityKey} reduces a decoded value to the same equivalence classes {@link deepEqual} judges
// (scale is a spelling, `time`/`datetime` compare as instants, text folds to NFC, a
// `rational`/`complex` reduces to lowest terms, every NaN is one value) collapsed into one
// canonical string, so every one of those checks becomes a plain `Map<string, …>` lookup.
// `json/schema/valueIdentity.ts`'s own `identityOfHost` re-exports this function directly, for
// the JSON encoding's own membership checks; the text encoding's FIXED/set/map checks go through
// {@link deepEqual} instead (`reader/tree/equality.ts`'s own `valuesEqual`), since a `Value` tree
// node's own annotations need `deepEqual`'s structural skip and a key-reduction would have to
// recompute the same reduction on both sides of every comparison anyway -- but the two functions
// judge the same value-space equality either way, which is the property this module's own top
// note requires of them.

function bytesIdentityKey(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function isRationalValue(
  record: Record<string, unknown>,
): record is Record<string, unknown> & Rational {
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

function isComplexValue(
  record: Record<string, unknown>,
): record is Record<string, unknown> & Complex {
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

/**
 * `value` (a decoded host value -- `bigint`, {@link TsonDecimal}, a plain `number`, a `string`,
 * `Uint8Array`, a temporal record, a `Rational`/`Complex`, …) reduced to a canonical value-space
 * identity string: the key two values compare equal under, on the same terms {@link deepEqual}
 * judges pairwise. Every host shape this package's atom parsers produce is covered; a compound
 * host shape with no dedicated reduction here falls back to a structural `JSON.stringify` of its
 * own fields, which is exact but not reduced -- correct for a shape that is already canonical in
 * its own fields (the network families: `ipv4`/`ipv6`/`cidr4`/`cidr6`/`mac`, each parsed to raw
 * address octets rather than kept as written text) and a documented gap for one that might not be
 * (`IDIOM-DEBT.md`'s own entry on this function).
 */
export function identityKey(value: unknown): string {
  if (typeof value === 'boolean') return `b:${String(value)}`;
  if (typeof value === 'bigint') return `i:${value.toString()}`;
  if (typeof value === 'number') return `f:${Number.isNaN(value) ? 'nan' : value.toString()}`;
  if (typeof value === 'string') return `s:${toNfc(value)}`;
  if (value instanceof Uint8Array) return `y:${bytesIdentityKey(value)}`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (isTsonDecimal(record)) return `n:${decimalIdentityKey(record)}`;
    if (isPlainDateTime(record))
      return `dt:${dateTimeInstantSeconds(record).toString()}.${record.time.nanosecond.toString()}`;
    if (isPlainTime(record))
      return `t:${timeOfDayWrapped(record).toString()}.${record.nanosecond.toString()}`;
    if (isRationalValue(record)) return rationalIdentityKey(record);
    if (isComplexValue(record)) return complexIdentityKey(record);
  }
  const replacer = (_key: string, v: unknown): unknown =>
    typeof v === 'bigint' ? v.toString() : v;
  return `o:${JSON.stringify(value, replacer)}`;
}
