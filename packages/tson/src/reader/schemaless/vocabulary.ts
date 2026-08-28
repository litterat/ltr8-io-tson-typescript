/**
 * The built-in type vocabulary's name -> {@link AtomType} table (§5) -- the port of
 * `atom/BuiltinTypeVocabulary.java`. A hardcoded transliteration of `spec/m/core.tn`'s own
 * instances, because the vocabulary is a fixed, closed set (§5.1) a Class 1 processor never
 * resolves via schema machinery -- exactly the property that lets schemaless reading skip the
 * compiler entirely (`reader/schemaless/tree.ts`'s own top note).
 *
 * **Every entry mirrors one `core.tn` line verbatim** (`spec/m/core.tn`, the vendored copy this
 * package ships and is checked against by `vendored-spec.test.ts`), not an independently-derived
 * "sensible default": `int32 => !integer ^ { size: { bits: 32  signed: true } }`,
 * `float32 => !float_type { format: BINARY32 }`, `base64 => !binary BASE64`, and so on. Where
 * `core.tn` applies a bare constructor with no refinement (`uuid => !uuid_type {}`), the matching
 * entry here passes a constraints record with every optional field absent.
 *
 * **Deliberately incomplete, matching the Java reference's own table exactly, gap for gap.**
 * `BuiltinTypeVocabulary.java`'s own Javadoc lists what it seeds and stops there; three `core.tn`
 * names are *not* built-in-vocabulary entries in the reference and are not here either:
 *
 * - `boolean` (`!enum [true false]`) -- an enum instance, not an atom; `EnumParser` exists in
 *   Java but is never registered in `BuiltinTypeVocabulary`, so `!boolean` schemaless is
 *   `UNKNOWN_TYPE_REF` in both implementations. An untyped `true`/`false` token still resolves
 *   via base type resolution (§4.2) regardless -- this only affects the explicit `!boolean`
 *   annotation.
 * - `regex` (`!regex_type {}`) -- `RegexParser.java` exists but is never registered either, so
 *   `!regex` schemaless is likewise `UNKNOWN_TYPE_REF` in both. (An explicitly schema-typed
 *   `regex` field still works once a schema is in scope -- that path doesn't go through this
 *   table at all.)
 * - `unknown` (`!unknown_type {}`) -- "the universe of types, not a token shape" (§4.1's `data`
 *   kind's own doc); there is no atom contract that could accept-and-narrow every value, so no
 *   parser exists for it in either implementation.
 *
 * This is a real, if narrow, spec-feedback finding worth filing upstream (§5.1's vocabulary table
 * lists `boolean`/`regex` alongside every other built-in with no marked exception for schemaless
 * use), not silently "fixed" here: matching the reference's actual behaviour, gap for gap, is what
 * the conformance suite and any cross-implementation comparison depend on.
 */

import { createIntegerParser } from '../../atom/numeric/integer.js';
import { createDecimalParser } from '../../atom/numeric/decimal.js';
import { createFloatParser } from '../../atom/numeric/float.js';
import { createRationalParser } from '../../atom/numeric/rational.js';
import { createComplexParser } from '../../atom/numeric/complex.js';
import { createBinaryParser } from '../../atom/numeric/binary.js';
import { createTextParser } from '../../atom/text/text.js';
import { createUuidParser } from '../../atom/network/uuid.js';
import { createUriParser } from '../../atom/network/uri.js';
import { createEmailParser } from '../../atom/network/email.js';
import { createMacParser } from '../../atom/network/mac.js';
import { createIpv4Parser } from '../../atom/network/ipv4.js';
import { createIpv6Parser } from '../../atom/network/ipv6.js';
import { createCidr4Parser } from '../../atom/network/cidr4.js';
import { createCidr6Parser } from '../../atom/network/cidr6.js';
import { createDateParser } from '../../atom/temporal/date.js';
import { createTimeParser } from '../../atom/temporal/time.js';
import { createDateTimeParser } from '../../atom/temporal/datetime.js';
import { createDurationParser } from '../../atom/temporal/duration.js';
import type { AtomType } from '../../atom/contract.js';

/** RFC pins, verbatim from `spec/m/meta.tn`/`meta-kernel.tn` -- see this module's own TSDoc. */
const RFC = {
  uri: 'https://www.rfc-editor.org/rfc/rfc3986',
  email: 'https://www.rfc-editor.org/rfc/rfc5322',
  ipv4: 'https://www.rfc-editor.org/rfc/rfc3986',
  ipv6: 'https://www.rfc-editor.org/rfc/rfc4291',
  cidr4: 'https://www.rfc-editor.org/rfc/rfc4632',
  cidr6: 'https://www.rfc-editor.org/rfc/rfc4291',
  mac: 'https://www.rfc-editor.org/rfc/rfc9542',
} as const;

/** The fixed-width integer ladder §5.6 lists in full: `int8`..`int256`/`uint8`..`uint256`. */
const INTEGER_WIDTHS = [8, 16, 32, 64, 128, 256] as const;

function buildVocabulary(): ReadonlyMap<string, AtomType<unknown>> {
  const types = new Map<string, AtomType<unknown>>();

  for (const bits of INTEGER_WIDTHS) {
    types.set(
      `int${String(bits)}`,
      createIntegerParser(`int${String(bits)}`, {
        kind: 'integer_type',
        size: { bits: BigInt(bits), signed: true },
      }),
    );
    types.set(
      `uint${String(bits)}`,
      createIntegerParser(`uint${String(bits)}`, {
        kind: 'integer_type',
        size: { bits: BigInt(bits), signed: false },
      }),
    );
  }
  types.set(
    'positive_integer',
    createIntegerParser('positive_integer', { kind: 'integer_type', min: 1n }),
  );
  types.set(
    'non_negative_integer',
    createIntegerParser('non_negative_integer', { kind: 'integer_type', min: 0n }),
  );
  types.set(
    'negative_integer',
    createIntegerParser('negative_integer', { kind: 'integer_type', max: -1n }),
  );
  types.set(
    'non_positive_integer',
    createIntegerParser('non_positive_integer', { kind: 'integer_type', max: 0n }),
  );

  types.set('number', createDecimalParser('number', { kind: 'decimal_type' }));
  types.set(
    'float32',
    createFloatParser('float32', {
      kind: 'float_type',
      format: 'BINARY32',
      allowNan: true,
      allowInfinity: true,
      allowSubnormal: true,
      allowNegativeZero: true,
    }),
  );
  types.set(
    'float64',
    createFloatParser('float64', {
      kind: 'float_type',
      format: 'BINARY64',
      allowNan: true,
      allowInfinity: true,
      allowSubnormal: true,
      allowNegativeZero: true,
    }),
  );
  types.set('rational', createRationalParser('rational', { kind: 'rational_type' }));
  types.set('complex', createComplexParser('complex'));

  types.set('text', createTextParser('text', { kind: 'text_type' }));

  types.set('base64', createBinaryParser('base64', { kind: 'binary', encoding: 'BASE64' }));
  types.set(
    'base64url',
    createBinaryParser('base64url', { kind: 'binary', encoding: 'BASE64URL' }),
  );
  types.set('base32', createBinaryParser('base32', { kind: 'binary', encoding: 'BASE32' }));
  types.set('hex', createBinaryParser('hex', { kind: 'binary', encoding: 'HEX' }));

  types.set('date', createDateParser('date', { kind: 'date_type' }));
  types.set('time', createTimeParser('time', { kind: 'time_type' }));
  types.set('datetime', createDateTimeParser('datetime', { kind: 'datetime_type' }));
  types.set('duration', createDurationParser('duration', { kind: 'duration_type' }));

  types.set('uuid', createUuidParser('uuid', { kind: 'uuid_type' }));
  types.set('uri', createUriParser('uri', { kind: 'uri_type', spec: RFC.uri }));
  types.set('email', createEmailParser('email', { kind: 'email_type', spec: RFC.email }));
  types.set('mac', createMacParser('mac', { kind: 'mac_type', spec: RFC.mac }));
  types.set(
    'ipv4',
    createIpv4Parser('ipv4', { kind: 'ipv4_type', spec: RFC.ipv4, within: [], excluding: [] }),
  );
  types.set(
    'ipv6',
    createIpv6Parser('ipv6', { kind: 'ipv6_type', spec: RFC.ipv6, within: [], excluding: [] }),
  );
  types.set(
    'cidr4',
    createCidr4Parser('cidr4', {
      kind: 'cidr4_type',
      spec: RFC.cidr4,
      within: [],
      excluding: [],
    }),
  );
  types.set(
    'cidr6',
    createCidr6Parser('cidr6', {
      kind: 'cidr6_type',
      spec: RFC.cidr6,
      within: [],
      excluding: [],
    }),
  );

  return types;
}

const VOCABULARY = buildVocabulary();

/**
 * The built-in vocabulary's own atom for `name`, or `undefined` when `name` is not one of
 * §5's built-in type names -- the port of `BuiltinTypeVocabulary.lookup`. `AtomType<unknown>`
 * matches the Java reference's own `AtomType<?>` wildcard: this table is deliberately
 * heterogeneous (a `Uuid`-producing entry beside a `bigint`-producing one), and every caller
 * narrows via {@link AtomValue} at the one place it actually reads a value
 * (`reader/schemaless/tree.ts`'s own `leaf`).
 */
export function lookupBuiltinAtom(name: string): AtomType<unknown> | undefined {
  return VOCABULARY.get(name);
}
