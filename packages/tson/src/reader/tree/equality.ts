/**
 * Structural equality over {@link Value} and the host {@link AtomValue} types it can hold -- what
 * `record.ts`'s FIXED-field check needs to compare a document-stated value against the schema's own
 * precomputed one (§5.2: "a contradicting value is a validation error"), the port of Java's plain
 * `Objects.equals` over two already-decoded values of the same reader's own output type. Also the
 * one place set-membership (`array.ts`) and map-key duplication (`map.ts`) decide two values are
 * "the same" -- so this module's own reading of value identity (below) is theirs too, and
 * `link/recordExtension.ts`/`compiler/subsumption.ts` reuse it a third time for family pin
 * distinctness, rather than each re-deriving it.
 *
 * A general recursive structural comparison rather than one written against a specific `AtomValue`
 * member: the value on either side of a FIXED check comes from running the *same* field parser twice
 * (once over the schema's own literal, once over whatever the document wrote), so whatever shape that
 * parser produces -- a bare primitive, a `bigint`, a `TsonDecimal`, a temporal/network record, or (a
 * schema-default composite is not resolved anywhere yet, per `RecordAbstractReader`'s own note, but a
 * written value could still legitimately be one) a nested {@link Value} tree -- this must compare it
 * correctly without knowing in advance which one it is.
 *
 * **Value identity, not spelling equality (Part 2 §5.5, §7.5; [TSON-DATA] §2.6, §5.2).** Two gaps a
 * field-by-field structural comparison would get wrong, both fixed by normalising *in the
 * comparison*, never in the value stored on the tree:
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
 *   and type annotation do not participate in identity at any layer" -- stated there for a map
 *   key, and the same value-space clause this module already reads for every other rule it
 *   implements, §5.5). A {@link Value} tree node carries its own `annotations` alongside the
 *   decoded content -- metadata about how the document happened to write the value, never part of
 *   the value itself -- so `pet_type: @doc:"x" dog` and `pet_type: dog` are one value: a FIXED
 *   check comparing the two (§5.2's "compared... as values") must not fail one for carrying an
 *   annotation the pin's own schema-supplied literal never had. Ignored structurally, by key,
 *   rather than by special-casing {@link AtomNode} alone, so a compound value's own nested
 *   annotations are ignored the same way wherever this module's equality is asked about one.
 */
import { compareDecimal } from '../../atom/numeric/decimalMath.js';
import {
  compareDateTime,
  daysFromCivil,
  // Referenced only from a TSDoc {@link} tag above, which the unused-vars rule cannot see -- see
  // `atom/contract.ts`'s own copy of this note.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  compareTime,
  type ComparableTime,
  type DateFields,
} from '../../atom/temporal/rfc3339.js';
import type { PlainDateTime, PlainTime, TsonDecimal } from '../../value/types.js';
import type { Value } from '../../tree/nodes.js';

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

/** Deep structural equality over two arbitrary host values -- primitives, `bigint`, `Uint8Array`, arrays, and plain records, recursively -- normalising decimal scale and temporal offset to value identity (this module's own top note) rather than comparing fields verbatim. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    return typeof a === typeof b && a === b;
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
    return aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/** {@link deepEqual} specialised to two {@link Value} tree nodes -- the shape `record.ts`'s FIXED check actually compares. */
export function valuesEqual(a: Value, b: Value): boolean {
  return deepEqual(a, b);
}
