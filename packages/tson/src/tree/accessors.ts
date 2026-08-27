/**
 * Query operations over the {@link Value} tree — navigation (`get`/`at`) and the two typed-access
 * families `tree/nodes.ts` declares as signatures only. Ported from `TsonValue`'s default methods
 * (`io.ltr8.tson.tree.TsonValue`).
 *
 * **Every function here is total.** Navigating past the end of the tree, casting an atom to the
 * wrong host type, or converting a non-numeric leaf all produce `undefined` (or, for navigation, a
 * {@link MissingNode}) rather than throwing — see this package's own work-package brief and
 * `tree/nodes.ts`'s Javadoc-derived TSDoc on {@link MissingNode}. This is a **deliberate divergence
 * from the Java**, noted here rather than left implicit: `TsonValue.at` throws
 * `IllegalArgumentException` for a pointer that doesn't start with `/`. This port keeps the
 * never-throws invariant instead — a malformed pointer is itself a failed step, so {@link at} answers
 * it the same way every other failed step answers: a {@link MissingNode} carrying the offending
 * pointer text, rather than an exception a caller chaining accessors would have to guard against
 * everywhere else it doesn't need to.
 *
 * **Two accessor families ask different questions, per this file's own scope note in `tree/nodes.ts`:**
 * {@link as}/{@link asString}/{@link asBoolean}/{@link asDecimal} *cast* — "did a read already
 * produce this host type?" — while {@link asInt}/{@link asLong}/{@link asDouble} *convert* — "what
 * number does this represent, in the target width?". A cast never changes representation; a
 * conversion may reject a value a cast would have accepted (a `text` atom never converts) and may
 * accept a value only after checking exactness (a `234.56E2` decimal converts to `asInt` because its
 * value is integral, even though it isn't stored as one).
 */

import type { TsonDecimal } from '../value/types.js';
import type {
  At,
  As,
  AsBoolean,
  AsDecimal,
  AsDouble,
  AsInt,
  AsLong,
  AsString,
  Get,
  Value,
} from './nodes.js';
import { missingNode } from './nodes.js';

// ---------------------------------------------------------------------------------------------
// RFC 6901 token escaping (§3 of the RFC; TsonMissing's own Javadoc cites it the same way)
// ---------------------------------------------------------------------------------------------

/** RFC 6901 §3: `~` becomes `~0`, `/` becomes `~1` — order matters, so a literal `~1` escapes to `~01`. */
function escapeToken(token: string): string {
  let out = '';
  for (const ch of token) {
    if (ch === '~') out += '~0';
    else if (ch === '/') out += '~1';
    else out += ch;
  }
  return out;
}

/** RFC 6901 §3 unescape: `~1` to `/` first, then `~0` to `~` — so `~01` decodes to `~1`, not `/`. */
function unescapeToken(token: string): string {
  let out = '';
  for (let i = 0; i < token.length; i += 1) {
    const ch = token.charAt(i);
    if (ch === '~' && token.charAt(i + 1) === '1') {
      out += '/';
      i += 1;
    } else if (ch === '~' && token.charAt(i + 1) === '0') {
      out += '~';
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------

/**
 * One field/entry lookup by (already-unescaped) string name, common to {@link RecordNode} and
 * {@link MapNode}. Neither container kind is asked to produce this for the other's key shape —
 * {@link get} and {@link step} each dispatch on `node.kind` before calling this.
 */
function getByName(node: Value, name: string): Value {
  switch (node.kind) {
    case 'record': {
      const field = node.fields.get(name);
      return field ?? missingNode(`/${escapeToken(name)}`);
    }
    case 'map': {
      for (const entry of node.entries) {
        if (asString(entry.key) === name) {
          return entry.value;
        }
      }
      return missingNode(`/${escapeToken(name)}`);
    }
    default:
      // Array, tuple, atom, absent, missing: no named field/entry exists at all. Mirrors
      // TsonValue's own default `get(String)`, which every non-record/map member inherits unchanged.
      return missingNode(`/${escapeToken(name)}`);
  }
}

/** One element lookup by index, common to {@link ArrayNode} and {@link TupleNode}. */
function getByIndex(node: Value, index: number): Value {
  if (node.kind === 'array' || node.kind === 'tuple') {
    const element = index >= 0 && index < node.elements.length ? node.elements[index] : undefined;
    return element ?? missingNode(`/${index.toString()}`);
  }
  // Record, map, atom, absent, missing: no positional element exists. Mirrors TsonValue's own
  // default `get(int)`.
  return missingNode(`/${index.toString()}`);
}

/**
 * The field/entry named `name` (record/map) or the element at `index` (array/tuple), or a
 * {@link MissingNode} pointing at that one step. Never throws. Mirrors the two `TsonValue.get`
 * overloads.
 *
 * A {@link MissingNode} receiver returns itself unchanged rather than manufacturing a fresh one —
 * mirroring `TsonMissing`'s own `get(String)`/`get(int)` overrides — so the first failure in a
 * chain is the one every later step keeps reporting, per {@link MissingNode}'s own contract.
 */
export const get: Get = (node, key) => {
  if (node.kind === 'missing') {
    return node;
  }
  return typeof key === 'number' ? getByIndex(node, key) : getByName(node, key);
};

/**
 * One RFC 6901 pointer token, dispatched the way `TsonValue.step` does: an array/tuple receiver
 * tries the token as an integer index first, falling back to a named lookup (which yields
 * {@link MissingNode} for either kind, since neither has named fields) only when the token isn't
 * one — `Number.isInteger` plus a round-trip through `String()` stands in for `Integer.parseInt`,
 * rejecting `"1.5"`, `""`, and anything with stray characters the same way a failed `parseInt` would.
 */
function step(node: Value, token: string): Value {
  if (node.kind === 'array' || node.kind === 'tuple') {
    const index = Number(token);
    if (token !== '' && Number.isInteger(index) && String(index) === token) {
      return getByIndex(node, index);
    }
    return missingNode(`/${escapeToken(token)}`);
  }
  return getByName(node, token);
}

/**
 * RFC 6901 JSON Pointer navigation from `node`. Never throws — see this file's own TSDoc for why a
 * malformed pointer (not starting with `/`) is answered as a failed step rather than an exception,
 * the one point at which this diverges from `TsonValue.at`. Mirrors the rest of it exactly: `""` is
 * `node` itself, `"/a/b"` steps into fields/indices, and any absent step yields a {@link MissingNode}
 * carrying the pointer up to and including the step that failed — not the whole pointer asked for,
 * since the remaining tokens have nothing left to step into and their outcome would say nothing
 * about the document.
 */
export const at: At = (node, pointer) => {
  if (pointer === '') {
    return node;
  }
  if (!pointer.startsWith('/')) {
    // Not a well-formed RFC 6901 pointer at all. Java throws here; this port instead reports the
    // whole malformed string as the point of failure, keeping every accessor total (see this
    // file's own TSDoc).
    return missingNode(pointer);
  }
  if (node.kind === 'missing') {
    return node; // already records where navigation failed; a later step can only be less informative
  }
  let current: Value = node;
  let from = 1;
  while (from <= pointer.length) {
    const slash = pointer.indexOf('/', from);
    const end = slash < 0 ? pointer.length : slash;
    const token = unescapeToken(pointer.slice(from, end));
    current = step(current, token);
    if (current.kind === 'missing') {
      // The step's own one-token path is relative to its receiver; re-anchor it to this node. The
      // source text is already escaped, so the prefix needs no re-escaping.
      return missingNode(pointer.slice(0, end));
    }
    from = end + 1;
  }
  return current;
};

// ---------------------------------------------------------------------------------------------
// Casting accessors ("what host type did the read produce?")
// ---------------------------------------------------------------------------------------------

/**
 * Casts an {@link AtomNode}'s held value to `T` via a runtime type guard. Returns `undefined` when
 * `node` isn't an {@link AtomNode} or its value doesn't satisfy `guard` — never throws, and never
 * converts (an `int32` atom's `number` value does not satisfy a `bigint` guard, even though the two
 * represent the same magnitude). Mirrors `TsonValue.as(Class)`.
 */
export const as: As = (node, guard) => {
  if (node.kind !== 'atom') {
    return undefined;
  }
  return guard(node.value) ? node.value : undefined;
};

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * Structural guard for {@link TsonDecimal} — the one {@link AtomValue} member with no `kind`
 * discriminant of its own, told apart from its siblings (a bigint, a plain number, a {@link Rational}
 * with `numerator`/`denominator`, a {@link Complex} with `real`/`imaginary`) by carrying a `bigint`
 * `unscaled` alongside a `number` `exponent`.
 */
function isTsonDecimal(value: unknown): value is TsonDecimal {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { unscaled?: unknown; exponent?: unknown };
  return typeof candidate.unscaled === 'bigint' && typeof candidate.exponent === 'number';
}

/** Casts to `string`. See {@link as}. */
export const asString: AsString = (node) => as(node, isString);

/** Casts to `boolean`. See {@link as}. */
export const asBoolean: AsBoolean = (node) => as(node, isBoolean);

/** Casts to the exact-decimal host type ({@link TsonDecimal}). See {@link as}. */
export const asDecimal: AsDecimal = (node) => as(node, isTsonDecimal);

// ---------------------------------------------------------------------------------------------
// Converting accessors ("what number does this represent?")
// ---------------------------------------------------------------------------------------------

/**
 * Parses the decimal string a finite JS `number` prints as (`Number.prototype.toString`'s shortest
 * round-trip form — `"123"`, `"0.1"`, `"1.5e-7"`, `"1e+21"`) into the exact {@link TsonDecimal} it
 * denotes.
 *
 * **This is the value's printed form, not its exact binary expansion**, matching
 * `TsonValue.toDecimal`'s own choice of `BigDecimal.valueOf(double)` (which parses
 * `Double.toString`) over `new BigDecimal(double)` (which would reproduce the binary value exactly,
 * e.g. `0.1000000000000000055511151231257827021181583404541015625` for `0.1`) — "the decimal a
 * value prints as is the one an author wrote and a writer emits", not an artifact of floating-point
 * storage. `numberNarrowing.ts` (`src/base/`) answers a different question — the *exact bits* a
 * float atom's token denotes — and lives out of reach of this module regardless (`tree/` may not
 * import `base/`).
 */
function decimalOfNumberPrintedForm(text: string): TsonDecimal {
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const exponentIndex = unsigned.indexOf('e');
  const mantissa = exponentIndex < 0 ? unsigned : unsigned.slice(0, exponentIndex);
  const printedExponent = exponentIndex < 0 ? 0 : Number(unsigned.slice(exponentIndex + 1));
  const dotIndex = mantissa.indexOf('.');
  const integerPart = dotIndex < 0 ? mantissa : mantissa.slice(0, dotIndex);
  const fractionPart = dotIndex < 0 ? '' : mantissa.slice(dotIndex + 1);
  const digits = integerPart + fractionPart;
  const unscaled = BigInt((negative ? '-' : '') + (digits === '' ? '0' : digits));
  const exponent = printedExponent - fractionPart.length;
  return { unscaled, exponent };
}

/**
 * This node's numeric value as an exact {@link TsonDecimal} — the one representation every
 * exactness question below is asked of — or `undefined` when it isn't an {@link AtomNode} holding a
 * finite number. A `bigint` widens with `exponent: 0`; a {@link TsonDecimal} passes through; a `number`
 * is read via its printed form (see {@link decimalOfNumberPrintedForm}); every other {@link AtomValue}
 * member (`Rational`, `Complex`, `string`, `boolean`, `Uint8Array`, every temporal/network type) has
 * no numeric reading at all and yields `undefined`, matching `TsonValue.asNumber()`'s cast-only
 * `Number` boundary — a `Rational`/`Complex` is a structured host value, not a `java.lang.Number`.
 */
function exactDecimalOf(node: Value): TsonDecimal | undefined {
  if (node.kind !== 'atom') {
    return undefined;
  }
  const value = node.value;
  if (typeof value === 'bigint') {
    return { unscaled: value, exponent: 0 };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? decimalOfNumberPrintedForm(value.toString()) : undefined;
  }
  if (isTsonDecimal(value)) {
    return value;
  }
  return undefined;
}

/**
 * The most decimal digits {@link exactIntegerOf} will materialise.
 *
 * The exponent comes from the document and is very cheap to write: `1E20000000` is eleven bytes
 * and denotes a twenty-million-digit integer. Materialising it is a memory and time amplification
 * out of all proportion to the input — measured at 1.4 s for that literal, and over 24 s for
 * `1E1000000000` before BigInt itself throws `RangeError`. An uncaught throw would also break
 * these accessors' own contract, which is to be total: they answer `undefined` for a value they
 * cannot represent and never throw.
 *
 * Ten thousand digits is far past `int64`'s nineteen and past any realistic use, while capping
 * what a short literal can cost at a few kilobytes.
 */
const MAX_EXACT_INTEGER_DIGITS = 10_000;

/** The number of decimal digits in `value`'s magnitude. */
function decimalDigitCount(value: bigint): number {
  return (value < 0n ? -value : value).toString().length;
}

/**
 * `decimal`'s value as an exact `bigint`, or `undefined` when its fractional part is real rather
 * than merely spelled with trailing zeros (`123.0` and `234.56E2` both have one; `345.6` doesn't),
 * or when the value would exceed {@link MAX_EXACT_INTEGER_DIGITS}.
 */
function exactIntegerOf(decimal: TsonDecimal): bigint | undefined {
  const { unscaled, exponent } = decimal;

  // Zero is exactly integral at every scale, and answering it costs nothing.
  if (unscaled === 0n) {
    return 0n;
  }

  const digits = decimalDigitCount(unscaled);

  if (exponent >= 0) {
    // Decide before exponentiating: the product has `digits + exponent` digits.
    if (digits + exponent > MAX_EXACT_INTEGER_DIGITS) {
      return undefined;
    }
    return unscaled * 10n ** BigInt(exponent);
  }

  const scale = -exponent;
  // A divisor with at least as many digits as the numerator cannot divide it exactly, so the
  // remainder is known without computing the power at all.
  if (scale >= digits) {
    return undefined;
  }
  const divisor = 10n ** BigInt(scale);
  return unscaled % divisor === 0n ? unscaled / divisor : undefined;
}

const MIN_INT32 = -2147483648n;
const MAX_INT32 = 2147483647n;

/**
 * This node's value as a `number` if it is a number that both is exactly integral and fits a signed
 * 32-bit `int`'s range, else `undefined` — mirroring `TsonValue.asInt()`'s own `int`-width contract
 * exactly (not merely its exactness rule): "A magnitude outside `int` range fails rather than
 * saturating or wrapping." Text is never parsed — `"42"` is a string per §4.4, and {@link asString}
 * is what reads it.
 */
export const asInt: AsInt = (node) => {
  const decimal = exactDecimalOf(node);
  if (decimal === undefined) {
    return undefined;
  }
  const integer = exactIntegerOf(decimal);
  if (integer === undefined || integer < MIN_INT32 || integer > MAX_INT32) {
    return undefined;
  }
  return Number(integer);
};

/**
 * As {@link asInt}, but converting to `bigint` with no range limit beyond exactness — see this
 * function's declared type `AsLong` in `tree/nodes.ts` for why this is a deliberate width
 * divergence from `TsonValue.asLong()`'s 64-bit `long`: a `bigint` has no upper bound, so the only
 * thing left to check is that the value is exactly integral.
 *
 * "No range limit" is a limit on the *value*, not on the work. A value wider than
 * {@link MAX_EXACT_INTEGER_DIGITS} answers `undefined`, because an exponent is cheap to write and
 * expensive to materialise, and this accessor never throws.
 */
export const asLong: AsLong = (node) => {
  const decimal = exactDecimalOf(node);
  return decimal === undefined ? undefined : exactIntegerOf(decimal);
};

/**
 * This node's numeric value as a finite `number`, rounding to the nearest representable double —
 * built by handing the exact decimal's digits to `Number()` as an exponential literal
 * (`"<unscaled>e<exponent>"`), which ECMA-262's `StringNumericValue` defines as correctly rounded to
 * the nearest `Number` value, the same guarantee `BigDecimal.doubleValue()` makes. An out-of-range
 * magnitude yields `undefined` rather than `Infinity`, so an out-of-range value can never read back
 * as a plausible one.
 */
export const asDouble: AsDouble = (node) => {
  const decimal = exactDecimalOf(node);
  if (decimal === undefined) {
    return undefined;
  }
  const value = Number(`${decimal.unscaled.toString()}e${decimal.exponent.toString()}`);
  return Number.isFinite(value) ? value : undefined;
};
