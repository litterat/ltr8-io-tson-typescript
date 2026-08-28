/**
 * Conformance-harness bridge from the real built-in atom vocabulary (`atom/`, §5) to the suite's
 * own `ExpectedVocabularyValue` shape (`sidecar.ts`).
 *
 * A vocabulary-layer subject is always a single bare `!type-ref value` data-value (the suite's own
 * README, "Vocabulary-layer vectors"), so this module parses it with the real Tier 3 parser to
 * recover the token an atom reads, then dispatches on `type-ref` to one of the built-in
 * vocabulary's unconstrained instances (`int32 => !integer_type { size: { bits: 32 signed: true }
 * }`, `uuid => !uuid_type {}`, and so on -- meta.tn's own built-in table, §5) and converts the
 * resulting host value into the suite's own host-representation-neutral shape.
 *
 * **Why this conversion is not simply `AtomType.write`.** `write` is each atom's own *round-trip*
 * inverse -- text that reads back to an equivalent value, in that atom's own canonical spelling
 * (`contract.ts`'s own doc). The suite's `value` asks a different, narrower question for three
 * families specifically:
 *
 * - `rational`: the suite compares by *reduced* value (`-2/4` and `-1/2` are the same vector's
 *   answer, README: "compared by value, not written form"), where `write` deliberately preserves
 *   the unreduced form it was given (`rational.ts`'s own doc).
 * - The binary family and `ipv6`: the suite wants a raw hex dump of the decoded bytes, not a
 *   re-encoding in the atom's own alphabet (`write` on a `base64` atom re-emits base64) or the
 *   colon-grouped text form (`formatIpv6`) -- README: "a plain hex string... not an RFC 4291 §2.2
 *   text form", specifically to sidestep a host `InetAddress`-shaped ambiguity no implementation
 *   here has anyway.
 * - `complex`: the suite wants the two exact-decimal components split out (`{ real, imaginary }`),
 *   not `write`'s own combined `a+bi` notation.
 *
 * Every other family's `write(read(token))` already *is* the suite's canonical text, so those go
 * through unchanged.
 */

import { TsonInternalError } from '../../packages/tson/src/core/errors.js';
import { fromBytes, runSync } from '../../packages/tson/src/io/bytes.js';
import { parseDocument } from '../../packages/tson/src/compiler/dataParser.js';
import type { AtomToken } from '../../packages/tson/src/atom/contract.js';
import { createBinaryParser } from '../../packages/tson/src/atom/numeric/binary.js';
import { createComplexParser } from '../../packages/tson/src/atom/numeric/complex.js';
import { createDecimalParser } from '../../packages/tson/src/atom/numeric/decimal.js';
import { writeDecimal } from '../../packages/tson/src/atom/numeric/decimalMath.js';
import { createFloatParser } from '../../packages/tson/src/atom/numeric/float.js';
import { createIntegerParser } from '../../packages/tson/src/atom/numeric/integer.js';
import { createRationalParser } from '../../packages/tson/src/atom/numeric/rational.js';
import { createDateParser } from '../../packages/tson/src/atom/temporal/date.js';
import { createDateTimeParser } from '../../packages/tson/src/atom/temporal/datetime.js';
import { createDurationParser } from '../../packages/tson/src/atom/temporal/duration.js';
import { createTimeParser } from '../../packages/tson/src/atom/temporal/time.js';
import { createCidr4Parser } from '../../packages/tson/src/atom/network/cidr4.js';
import { createCidr6Parser } from '../../packages/tson/src/atom/network/cidr6.js';
import { createEmailParser } from '../../packages/tson/src/atom/network/email.js';
import { createIpv4Parser } from '../../packages/tson/src/atom/network/ipv4.js';
import { createIpv6Parser } from '../../packages/tson/src/atom/network/ipv6.js';
import { createMacParser, formatMac } from '../../packages/tson/src/atom/network/mac.js';
import { createUriParser } from '../../packages/tson/src/atom/network/uri.js';
import { createUuidParser, formatUuid } from '../../packages/tson/src/atom/network/uuid.js';
import type { ExpectedVocabularyValue } from './sidecar.js';

type VocabularyReader = (token: AtomToken) => ExpectedVocabularyValue;

function hexEncode(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** `numerator/denominator`, in lowest terms with a positive denominator -- the suite's own
 * "compared by value" contract for `rational` (see this module's own doc comment). */
function reducedRational(numerator: bigint, denominator: bigint): string {
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
  const magnitude = numerator < 0n ? -numerator : numerator;
  const divisor = magnitude === 0n ? denominator : gcd(magnitude, denominator);
  return `${(numerator / divisor).toString()}/${(denominator / divisor).toString()}`;
}

/**
 * `float32`/`float64`'s own `write` gives `number`'s shortest round-trip text (`"12"` for the
 * value `12`), correct for reading back but not matching the canonical `Double#toString`-style
 * text (`"12.0"`) the suite's own float vectors were authored against (confirmed against
 * `vocabulary/valid/float64-hex-float-expected.tn` et al. -- see this harness's own report for
 * why that gap belongs to `atom/numeric/float.ts`, not this conversion). Every value these
 * vectors exercise is finite and exactly decimal-representable (the suite restricts float vectors
 * to exactly that, by its own README). `writeFloat` spells the fractional part itself, so this
 * checks that rather than supplying it; `.nan`/`+.inf`/`-.inf` already carry a `.`.
 */
function canonicalFloatText(text: string): string {
  // Kept as an assertion rather than a transformation: `writeFloat` now spells a whole float with
  // its fractional part, matching the suite's canonical text and `Double#toString`. If that ever
  // regresses, this fails loudly here instead of silently papering over it the way appending
  // `.0` did.
  if (
    !text.includes('.') &&
    !text.includes('e') &&
    !text.includes('E') &&
    !/^[-+]?(nan|inf)/i.test(text)
  ) {
    throw new Error(`float atom wrote '${text}' with no fractional part; expected canonical form`);
  }
  return text;
}

function integerReader(typeRef: string, bits: bigint, signed: boolean): VocabularyReader {
  const atom = createIntegerParser(typeRef, { kind: 'integer_type', size: { bits, signed } });
  return (token) => atom.read(token).toString();
}

/**
 * One unconstrained `AtomType` per built-in annotation the suite's vocabulary-layer vectors name
 * (§5's own table), each instantiated exactly as its `core.tn` built-in declares it (every
 * `create*Parser` factory's own TSDoc gives that instance literally, e.g. `int32 => !integer_type
 * { size: { bits: 32 signed: true } }`) -- built fresh per harness run, not cached across runs,
 * since these atoms carry no mutable state worth reusing beyond one process's own vocabulary
 * table.
 */
function buildReaders(): Readonly<Record<string, VocabularyReader>> {
  const decimal = createDecimalParser('number', { kind: 'decimal_type' });
  const float32 = createFloatParser('float32', {
    kind: 'float_type',
    format: 'BINARY32',
    allowNan: true,
    allowInfinity: true,
    allowSubnormal: true,
    allowNegativeZero: true,
  });
  const float64 = createFloatParser('float64', {
    kind: 'float_type',
    format: 'BINARY64',
    allowNan: true,
    allowInfinity: true,
    allowSubnormal: true,
    allowNegativeZero: true,
  });
  const rational = createRationalParser('rational', { kind: 'rational_type' });
  const complex = createComplexParser('complex');
  const base32 = createBinaryParser('base32', { kind: 'binary', encoding: 'BASE32' });
  const base64 = createBinaryParser('base64', { kind: 'binary', encoding: 'BASE64' });
  const base64url = createBinaryParser('base64url', { kind: 'binary', encoding: 'BASE64URL' });
  const hex = createBinaryParser('hex', { kind: 'binary', encoding: 'HEX' });
  const date = createDateParser('date', { kind: 'date_type' });
  const time = createTimeParser('time', { kind: 'time_type' });
  const datetime = createDateTimeParser('datetime', { kind: 'datetime_type' });
  const duration = createDurationParser('duration', { kind: 'duration_type' });
  const ipv4 = createIpv4Parser('ipv4', {
    kind: 'ipv4_type',
    spec: 'https://www.rfc-editor.org/rfc/rfc3986',
    within: [],
    excluding: [],
  });
  const ipv6 = createIpv6Parser('ipv6', {
    kind: 'ipv6_type',
    spec: 'https://www.rfc-editor.org/rfc/rfc4291',
    within: [],
    excluding: [],
  });
  const cidr4 = createCidr4Parser('cidr4', {
    kind: 'cidr4_type',
    spec: 'https://www.rfc-editor.org/rfc/rfc4632',
    within: [],
    excluding: [],
  });
  const cidr6 = createCidr6Parser('cidr6', {
    kind: 'cidr6_type',
    spec: 'https://www.rfc-editor.org/rfc/rfc4291',
    within: [],
    excluding: [],
  });
  const uri = createUriParser('uri', {
    kind: 'uri_type',
    spec: 'https://www.rfc-editor.org/rfc/rfc3986',
  });
  const uuid = createUuidParser('uuid', { kind: 'uuid_type' });
  const mac = createMacParser('mac', {
    kind: 'mac_type',
    spec: 'https://www.rfc-editor.org/rfc/rfc9542',
  });
  const email = createEmailParser('email', {
    kind: 'email_type',
    spec: 'https://www.rfc-editor.org/rfc/rfc5322',
  });

  return {
    text: (token) => token.text,
    number: (token) => writeDecimal(decimal.read(token)),
    float32: (token) => canonicalFloatText(float32.write(float32.read(token))),
    float64: (token) => canonicalFloatText(float64.write(float64.read(token))),
    int8: integerReader('int8', 8n, true),
    int16: integerReader('int16', 16n, true),
    int32: integerReader('int32', 32n, true),
    int64: integerReader('int64', 64n, true),
    int128: integerReader('int128', 128n, true),
    int256: integerReader('int256', 256n, true),
    uint8: integerReader('uint8', 8n, false),
    uint16: integerReader('uint16', 16n, false),
    uint32: integerReader('uint32', 32n, false),
    uint64: integerReader('uint64', 64n, false),
    uint128: integerReader('uint128', 128n, false),
    uint256: integerReader('uint256', 256n, false),
    rational: (token) => {
      const value = rational.read(token);
      return reducedRational(value.numerator, value.denominator);
    },
    complex: (token) => {
      const value = complex.read(token);
      return { real: writeDecimal(value.real), imaginary: writeDecimal(value.imaginary) };
    },
    base32: (token) => hexEncode(base32.read(token)),
    base64: (token) => hexEncode(base64.read(token)),
    base64url: (token) => hexEncode(base64url.read(token)),
    hex: (token) => hexEncode(hex.read(token)),
    date: (token) => date.write(date.read(token)),
    time: (token) => time.write(time.read(token)),
    datetime: (token) => datetime.write(datetime.read(token)),
    duration: (token) => {
      const value = duration.read(token);
      return { period: value.period, clock: value.clock };
    },
    ipv4: (token) => ipv4.write(ipv4.read(token)),
    ipv6: (token) => hexEncode(ipv6.read(token).octets),
    cidr4: (token) => cidr4.write(cidr4.read(token)),
    cidr6: (token) => cidr6.write(cidr6.read(token)),
    uri: (token) => uri.write(uri.read(token)),
    uuid: (token) => formatUuid(uuid.read(token).bytes),
    mac: (token) => formatMac(mac.read(token).octets),
    email: (token) => email.write(email.read(token)),
  };
}

const READERS = buildReaders();

/**
 * Reads `subject`'s single bare `!type-ref value` data-value through `type-ref`'s built-in atom,
 * returning the suite's own {@link ExpectedVocabularyValue} shape. Throws {@link TsonAtomParseError}
 * / {@link TsonAtomValidationError} exactly as the underlying atom does, uncaught, for a
 * vocabulary-layer `error` vector.
 */
export function readVocabularyValue(subject: Uint8Array, typeRef: string): ExpectedVocabularyValue {
  const reader = READERS[typeRef];
  if (reader === undefined) {
    throw new TsonInternalError(
      `no built-in vocabulary instance registered in this harness for type-ref '${typeRef}'`,
    );
  }
  const { document } = runSync(parseDocument(fromBytes(subject)));
  const core = document.root.coreValue;
  if (core.kind !== 'token') {
    throw new TsonInternalError(
      `vocabulary-layer vector's subject must be a single bare token, got core-value kind '${core.kind}'`,
    );
  }
  return reader({ text: core.text, form: core.form });
}
