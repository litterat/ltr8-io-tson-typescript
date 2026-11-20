/**
 * A resolved body, under the declared name it was resolved as, to the parser that reads a bare
 * token against it -- the answer to "does this token satisfy this type?" for a caller holding a
 * `schema.meta` body and nothing else (§5, §9).
 *
 * Ported from the reference implementation's `AtomParsers`
 * (`tson-compiler/.../compiler/atom/AtomParsers.java`); see that file's own doc for the exhaustive
 * rationale, which carries over unchanged. **Distinct from `compiler/atomBuilder.ts`'s own
 * dispatch**, which hands back a whole suspendable `TypeReader<Value>` -- annotations captured,
 * tree node built, wired through `reader/tree/*`. Nothing here reads a stream: the token is
 * already in hand, which is what lets a phase running *before* compilation --
 * `link/referenceValidation.ts`, checking a field's `~`/`=` value against the field's declared
 * type -- ask the question at all.
 *
 * {@link atomParserFor} answering `undefined` never means "unsupported": a record, container,
 * choice, reference or data body has no token-level answer to give ({@link isScalarBody} answers
 * `false` for all of those), and neither does `value_type`'s `value` instance -- {@link
 * isScalarBody} answers `true` for it, since §4.2 counts it as scalar, but this module offers no
 * parser for it: its parsing contract is the type the position hands it to, out of scope for the
 * one caller this module exists for today. A caller that needs to tell the two `undefined` cases apart consults {@link
 * isScalarBody} first, exactly as {@link atomParserFor}'s own caller does.
 */
import type { AtomToken } from './contract.js';
import type { Normalization, RegexType, TextType } from '../schema/meta/atoms-text.js';
import type { Product, Sum } from '../schema/meta/algebra.js';
import type {
  Alias,
  ApplyBody,
  Atom,
  Extern,
  IncompleteEntry,
  ValueEntry,
} from '../schema/meta/typedef.js';

import { createIntegerParser } from './numeric/integer.js';
import { createDecimalParser } from './numeric/decimal.js';
import { createFloatParser } from './numeric/float.js';
import { createRationalParser } from './numeric/rational.js';
import { createComplexParser } from './numeric/complex.js';
import { createBinaryParser } from './numeric/binary.js';
import { createTextParser } from './text/text.js';
import { createIdentifierParser } from './text/identifier.js';
import { createEnumParser } from './enum.js';
import { createQualifiedNameParser } from './reference.js';
import { createUuidParser } from './network/uuid.js';
import { createUriParser } from './network/uri.js';
import { createEmailParser } from './network/email.js';
import { createMacParser } from './network/mac.js';
import { createIpv4Parser } from './network/ipv4.js';
import { createIpv6Parser } from './network/ipv6.js';
import { createCidr4Parser } from './network/cidr4.js';
import { createCidr6Parser } from './network/cidr6.js';
import { createHostParser, createHostnameParser, createMediaTypeParser } from './network/index.js';
import { createDateParser } from './temporal/date.js';
import { createTimeParser } from './temporal/time.js';
import { createDateTimeParser } from './temporal/datetime.js';
import { createDurationParser } from './temporal/duration.js';
import { createPeriodParser } from './temporal/period.js';

/**
 * Every `Top` member this module ever receives.
 */
type ScalarCandidate =
  Atom | Product | Sum | ApplyBody | Alias | Extern | ValueEntry | IncompleteEntry;

/** The half of {@link AtomType} a bare "does this token satisfy this type" check needs -- see this module's own top note on why `write` never enters into it. */
export interface ScalarParser {
  read(token: AtomToken): unknown;
}

/**
 * Whether `body`, resolved under `declaredName`, is a scalar type: the type a bare token can
 * denote directly (§5.2's "a fixed or default value is available on a scalar-typed field and
 * nowhere else"). Every ATOM-kind body counts, `void_type` excepted -- `void` is the type whose
 * only value is the void sentinel, so no token is one (§4.2). Recognised by constructor, never by
 * name.
 */
export function isScalarBody(body: ScalarCandidate): boolean {
  switch (body.kind) {
    case 'void_type':
      return false;
    case 'enum':
    case 'integer_type':
    case 'text_type':
    case 'identifier_type':
    case 'uri_type':
    case 'iri_type':
    case 'regex_type':
    case 'decimal_type':
    case 'float_type':
    case 'rational_type':
    case 'uuid_type':
    case 'bytes_type':
    case 'date_type':
    case 'time_type':
    case 'datetime_type':
    case 'duration_type':
    case 'period_type':
    case 'cidr4_type':
    case 'cidr6_type':
    case 'email_type':
    case 'mac_type':
    case 'ipv4_type':
    case 'ipv6_type':
    case 'complex_type':
    case 'ref':
    case 'hostname_type':
    case 'host_type':
    case 'media_type_type':
      return true;
    default:
      return false; // record, array, map, namespace, tuple, choice, declared type, dependent, apply, alias, extern, value entry
  }
}

// ── regex_type ───────────────────────────────────────────────────────────────────────────────

/**
 * `regex_type => ~text_type & atom_specification & { spec: = ... }` (§5.7): every constraint
 * `createTextParser` reads is one `regex_type` carries too, under the identical field names, but
 * with a `kind: 'regex_type'` discriminant `TextType` itself does not accept. Rebuilds the
 * `text_type`-shaped subset by hand (`exactOptionalPropertyTypes` forbids simply spreading the
 * optional fields across) rather than widening `createTextParser`'s own signature -- the same
 * choice `compiler/atomBuilder.ts`'s own `asTextConstraints` makes.
 */
function asTextConstraints(atom: RegexType): TextType {
  const { minLength, maxLength, length, pattern, members, normalization } = atom;
  return {
    kind: 'text_type',
    normalization,
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(length === undefined ? {} : { length }),
    ...(pattern === undefined ? {} : { pattern }),
    ...(members === undefined ? {} : { members }),
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────────────────────

/**
 * The parser for a value declared to have type `declaredName`/`body`, or `undefined` when this
 * module has no bare-token parser to offer for it -- see this module's own top note on the two
 * different reasons that can be, and {@link isScalarBody} for telling them apart.
 */
export function atomParserFor(
  declaredName: string,
  body: ScalarCandidate,
  enumForm: Normalization = 'NONE',
): ScalarParser | undefined {
  switch (body.kind) {
    case 'enum':
      return createEnumParser(declaredName, body, enumForm);
    case 'integer_type':
      return createIntegerParser(declaredName, body);
    case 'text_type':
      return createTextParser(declaredName, body);
    case 'identifier_type':
      return createIdentifierParser(declaredName, body);
    case 'uri_type':
    case 'iri_type':
      return createUriParser(declaredName, body);
    case 'regex_type':
      return createTextParser(declaredName, asTextConstraints(body));
    case 'email_type':
      return createEmailParser(declaredName, body);
    case 'decimal_type':
      return createDecimalParser(declaredName, body);
    case 'float_type':
      return createFloatParser(declaredName, body);
    case 'rational_type':
      return createRationalParser(declaredName, body);
    case 'uuid_type':
      return createUuidParser(declaredName, body);
    case 'bytes_type':
      return createBinaryParser(declaredName, body);
    case 'date_type':
      return createDateParser(declaredName, body);
    case 'time_type':
      return createTimeParser(declaredName, body);
    case 'datetime_type':
      return createDateTimeParser(declaredName, body);
    case 'duration_type':
      return createDurationParser(declaredName, body);
    case 'period_type':
      return createPeriodParser(declaredName, body);
    case 'cidr4_type':
      return createCidr4Parser(declaredName, body);
    case 'cidr6_type':
      return createCidr6Parser(declaredName, body);
    case 'mac_type':
      return createMacParser(declaredName, body);
    case 'ipv4_type':
      return createIpv4Parser(declaredName, body);
    case 'ipv6_type':
      return createIpv6Parser(declaredName, body);
    case 'complex_type':
      return createComplexParser(declaredName);
    case 'ref':
      // A reference's value is a qualified name (§4.2, §5.12): read here by the name grammar, and
      // judged against the linked closure, which a bare-token parser cannot see.
      return createQualifiedNameParser(declaredName);
    case 'hostname_type':
      return createHostnameParser(declaredName, body);
    case 'host_type':
      return createHostParser(declaredName);
    case 'media_type_type':
      return createMediaTypeParser(declaredName, body);
    default:
      return undefined; // void_type, containers, choice, declared type, alias, value entry
  }
}
