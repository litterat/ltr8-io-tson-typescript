/**
 * How one atom leaf's host value becomes token text, and whether that text needs quoting -- the
 * shared decision `treeWriter.ts` (a {@link tree.AtomNode}) and `bindingWriter.ts` (an
 * `AtomBinding` leaf) both have to make, factored out once rather than duplicated twice. The port
 * of the reference implementation's `AtomWriter`/`VocabularyAtoms` pair, reshaped for a port
 * whose atom leaf is a value union with real per-type host shapes rather than a set of JDK
 * classes -- see this file's own notes below on exactly where that reshaping changes the answer.
 *
 * **Two-stage dispatch, in this order:**
 *
 * 1. {@link formatKnownAtom} -- when a `typeRef` is in hand *and* names a built-in vocabulary type
 *    (`reader/schemaless/vocabulary.ts`'s own table), that type's own {@link AtomType.write} is
 *    authoritative: it is what produces `int32`'s bare digits, `float32`'s `.0`-suffixed text,
 *    `uuid`'s canonical hex-and-hyphens, and so on, each exactly as that atom's own parser would
 *    read it back. Quoting is then a static property of *which* built-in name it is (see
 *    {@link UNQUOTED_VOCABULARY_TYPES}), not of the value's shape.
 *
 * 2. {@link formatDefaultAtom} -- the fallback, when there is no `typeRef`, or it names nothing
 *    the built-in vocabulary recognises (a schema-declared custom name `write/` cannot resolve
 *    without the compiler, or a hand-built node/binding carrying an arbitrary type-ref). This
 *    dispatches on the *value's own runtime shape* instead, mirroring `VocabularyAtoms.java`'s
 *    reverse `Class<?> -> Entry` map: a value shaped like a {@link Uuid}/{@link Ipv4Address}/.../
 *    {@link TsonDuration} always writes quoted with a synthesised type-ref (the same "structured
 *    values are always quoted" rule the reference's own `TsonTreeWriter.writeAtom` applies to
 *    everything its `VocabularyAtoms` reverse map matches), while a `bigint`/{@link TsonDecimal}/
 *    `boolean` writes bare and untyped -- part of the numeric ladder or the base-boolean case, for
 *    which base type resolution (§4) recovers the value with no annotation at all -- and a
 *    `string` writes quoted with no type-ref (§4.4's default, and `text`/`uri`/`email` all share
 *    this one host shape in this port, so none of the three can be inferred from it alone; see
 *    `atom/network/uri.ts`'s own note on why `!uri`'s host value is a bare `string`).
 *
 * **Why stage 1 must run first here, where the reference dispatches on host class alone.** Java's
 * `int32`..`int256` bind to `Integer`/`Long`/`BigInteger` -- classes distinct from `Double`/
 * `Float` -- so `AtomWriter.writeDefaultAtom`'s `instanceof`-style switch tells an integer family
 * from a float family for free, and `typeRef` only ever *narrows* which spelling within a family
 * (which it doesn't even need to, since e.g. every `Integer` writes the same way regardless of
 * whether it came from `int8` or `int32`). This port's {@link Int8}..{@link Int32}/{@link Uint8}..
 * {@link Uint32} are a plain `number` (`value/types.ts`'s own documented choice), the *same* host
 * shape {@link FloatType}'s `float32`/`float64` use -- so a bare `number` alone cannot say whether
 * `12` is the integer `12` or the float `12` needing the `.0` an untyped write must carry to
 * survive re-parsing as a `float` grammar form (§4.3/§4.5). Only the `typeRef` distinguishes them,
 * which is exactly why stage 1 (typeRef-driven, when available) is checked before stage 2
 * (shape-driven) rather than the other way around.
 */
import { TsonInternalError } from '../core/errors.js';
import type { AtomType } from '../atom/contract.js';
import { lookupBuiltinAtom } from '../reader/schemaless/vocabulary.js';
import { writeDecimal } from '../atom/numeric/decimalMath.js';
import { writeFloat } from '../atom/numeric/float.js';
import type { AtomValue } from '../tree/nodes.js';
import type {
  Cidr,
  Complex,
  Ipv4Address,
  Ipv6Address,
  MacAddress,
  PlainDate,
  PlainDateTime,
  PlainTime,
  Rational,
  TsonDecimal,
  TsonDuration,
  Uuid,
} from '../value/types.js';

/** One atom leaf's write-side outcome: the token text, whether it needs quoting, and -- when this stage supplied one -- its type-ref. */
export interface AtomText {
  readonly typeRef?: string;
  readonly quoted: boolean;
  readonly text: string;
}

/**
 * The built-in vocabulary names whose text is always a bare numeric token (§7.6's `integer`/
 * `float`/`hex-float`/`special-value` forms) -- the full fixed-width integer ladder, the four
 * sign-bounded refinements, and the two approximate/exact non-integer families. Every other
 * built-in name (`uuid`, `date`, `rational`, `text`, the binary/network families, ...) writes
 * quoted, matching `TsonTreeWriter.writeAtom`'s "anything the reverse map matches is always
 * `quotedString`" rule -- restated here as a name table because this port's atom host values
 * don't carry distinct JDK classes to reverse-map from.
 */
const UNQUOTED_VOCABULARY_TYPES: ReadonlySet<string> = new Set([
  'int8',
  'int16',
  'int32',
  'int64',
  'int128',
  'int256',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uint128',
  'uint256',
  'positive_integer',
  'non_negative_integer',
  'negative_integer',
  'non_positive_integer',
  'number',
  'float32',
  'float64',
]);

/**
 * Stage 1: `typeRef` names a built-in vocabulary type, so that type's own {@link AtomType.write}
 * formats `value`. Returns `undefined` when `typeRef` isn't a built-in name at all -- the caller's
 * cue to fall back to {@link formatDefaultAtom}.
 */
export function formatKnownAtom(typeRef: string, value: unknown): AtomText | undefined {
  const atomType = lookupBuiltinAtom(typeRef);
  if (atomType === undefined) return undefined;
  return { typeRef, quoted: !UNQUOTED_VOCABULARY_TYPES.has(typeRef), text: atomType.write(value) };
}

function mustLookup(typeRef: string): AtomType<unknown> {
  const atomType = lookupBuiltinAtom(typeRef);
  if (atomType === undefined) {
    throw new TsonInternalError(
      `the built-in vocabulary table is missing '${typeRef}', which this module's own shape ` +
        'dispatch expects to always be registered',
    );
  }
  return atomType;
}

/** `value` carries `unscaled`/`exponent` (§5.6's exact-decimal shape, {@link TsonDecimal}). */
function isTsonDecimal(value: object): value is TsonDecimal {
  return 'unscaled' in value && 'exponent' in value;
}

/** `value` carries `numerator`/`denominator` ({@link Rational}), disjoint from every other shape here. */
function isRational(value: object): value is Rational {
  return 'numerator' in value && 'denominator' in value;
}

/** `value` carries `real`/`imaginary` ({@link Complex}). */
function isComplex(value: object): value is Complex {
  return 'real' in value && 'imaginary' in value;
}

/** `value` carries `bytes` ({@link Uuid}) -- distinct from a bare {@link Uint8Array} binary value. */
function isUuid(value: object): value is Uuid {
  return 'bytes' in value;
}

function isIpv4(value: object): value is Ipv4Address {
  return 'kind' in value && value.kind === 'ipv4';
}

function isIpv6(value: object): value is Ipv6Address {
  return 'kind' in value && value.kind === 'ipv6';
}

function isCidr(value: object): value is Cidr {
  const kind = 'kind' in value ? value.kind : undefined;
  return kind === 'cidr4' || kind === 'cidr6';
}

/** `value` carries `octets` ({@link MacAddress}) with no `kind` -- {@link Ipv4Address}/{@link Ipv6Address} both have one. */
function isMacAddress(value: object): value is MacAddress {
  return 'octets' in value && !('kind' in value);
}

function isPlainDateTime(value: object): value is PlainDateTime {
  return 'date' in value && 'time' in value;
}

function isPlainDate(value: object): value is PlainDate {
  return 'year' in value && 'month' in value && 'day' in value;
}

function isPlainTime(value: object): value is PlainTime {
  return 'hour' in value && 'minute' in value && 'offset' in value;
}

function isTsonDuration(value: object): value is TsonDuration {
  return 'period' in value && 'clock' in value;
}

/**
 * §4.3's default number resolution never produces a fractional part with no visible `.`/exponent
 * for anything but an *integer* form -- so an exact decimal that happens to be whole (`unscaled:
 * 12n, exponent: 0`) still has to write with one, or a bare re-parse narrows it back to a
 * `bigint`, a different {@link AtomValue} kind than what was written. Mirrors {@link writeFloat}'s
 * own `.0`-suffix rule, applied to the exact-decimal side of the numeric ladder instead of the
 * approximate one.
 */
function writeDefaultDecimal(value: TsonDecimal): string {
  const text = writeDecimal(value);
  return text.includes('.') ? text : `${text}.0`;
}

/**
 * Stage 2: no known-vocabulary formatting applied (see this file's own top note), so `value`'s
 * own runtime shape decides. Every {@link AtomValue} variant is handled; unlike Java's reverse
 * map this cannot silently miss a host class, because there is a closed union to switch over
 * rather than open-ended `instanceof` -- see the final `throw` below.
 */
export function formatDefaultAtom(value: AtomValue): AtomText {
  if (typeof value === 'bigint') {
    return { quoted: false, text: value.toString() };
  }
  if (typeof value === 'boolean') {
    return { quoted: false, text: value ? 'true' : 'false' };
  }
  if (typeof value === 'string') {
    return { quoted: true, text: value };
  }
  if (typeof value === 'number') {
    return { quoted: false, text: writeFloat(value) };
  }
  if (value instanceof Uint8Array) {
    return { typeRef: 'base64', quoted: true, text: mustLookup('base64').write(value) };
  }
  if (isTsonDecimal(value)) {
    return { quoted: false, text: writeDefaultDecimal(value) };
  }
  if (isRational(value)) {
    return { typeRef: 'rational', quoted: true, text: mustLookup('rational').write(value) };
  }
  if (isComplex(value)) {
    return { typeRef: 'complex', quoted: true, text: mustLookup('complex').write(value) };
  }
  if (isUuid(value)) {
    return { typeRef: 'uuid', quoted: true, text: mustLookup('uuid').write(value) };
  }
  if (isIpv4(value)) {
    return { typeRef: 'ipv4', quoted: true, text: mustLookup('ipv4').write(value) };
  }
  if (isIpv6(value)) {
    return { typeRef: 'ipv6', quoted: true, text: mustLookup('ipv6').write(value) };
  }
  if (isCidr(value)) {
    return { typeRef: value.kind, quoted: true, text: mustLookup(value.kind).write(value) };
  }
  if (isMacAddress(value)) {
    return { typeRef: 'mac', quoted: true, text: mustLookup('mac').write(value) };
  }
  if (isPlainDateTime(value)) {
    return { typeRef: 'datetime', quoted: true, text: mustLookup('datetime').write(value) };
  }
  if (isPlainDate(value)) {
    return { typeRef: 'date', quoted: true, text: mustLookup('date').write(value) };
  }
  if (isPlainTime(value)) {
    return { typeRef: 'time', quoted: true, text: mustLookup('time').write(value) };
  }
  if (isTsonDuration(value)) {
    return { typeRef: 'duration', quoted: true, text: mustLookup('duration').write(value) };
  }
  throw new TsonInternalError(
    `don't know how to write an atom value of shape ${JSON.stringify(value)}`,
  );
}
