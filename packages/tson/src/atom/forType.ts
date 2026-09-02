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
 * `false` for all of those), and neither does `unit`'s `value`/`token` instance (or any other
 * non-`void` `unit` name) -- {@link isScalarBody} answers `true` for those, since §4.2 counts them
 * as scalar, but this module offers no parser for them: their own parsing contract is the
 * identifier grammar and base-type resolution, both out of scope for the one caller this module
 * exists for today. A caller that needs to tell the two `undefined` cases apart consults {@link
 * isScalarBody} first, exactly as {@link atomParserFor}'s own caller does.
 */
import type { AtomToken, AtomType } from './contract.js';
import { TsonAtomValidationError } from '../core/errors.js';
import type { EnumBody } from '../schema/meta/bodies.js';
import type { RegexType, TextType } from '../schema/meta/atoms-text.js';
import type { Product, Sum } from '../schema/meta/algebra.js';
import type { Atom, Reference } from '../schema/meta/typedef.js';

import { createIntegerParser } from './numeric/integer.js';
import { createDecimalParser } from './numeric/decimal.js';
import { createFloatParser } from './numeric/float.js';
import { createRationalParser } from './numeric/rational.js';
import { createComplexParser } from './numeric/complex.js';
import { createBinaryParser } from './numeric/binary.js';
import { createTextParser } from './text/text.js';
import { createUuidParser } from './network/uuid.js';
import { createUriParser } from './network/uri.js';
import { createEmailParser } from './network/email.js';
import { createMacParser } from './network/mac.js';
import { createIpv4Parser } from './network/ipv4.js';
import { createIpv6Parser } from './network/ipv6.js';
import { createCidr4Parser } from './network/cidr4.js';
import { createCidr6Parser } from './network/cidr6.js';
import { createDateParser } from './temporal/date.js';
import { createTimeParser } from './temporal/time.js';
import { createDateTimeParser } from './temporal/datetime.js';
import { createDurationParser } from './temporal/duration.js';

/**
 * Every non-held `Top` member this module ever receives, {@link Data} excluded. A held
 * `TemplateBody` carries no `kind` of its own and a {@link Data} body's `kind` is a bare `string`
 * that no literal `case` can exclude by exhaustion (`link/bodyKind.ts`'s own note on why that
 * needs a real type-predicate, not a switch) -- so both are the caller's to rule out before
 * reaching here. `link/referenceValidation.ts`'s own `checkFieldValue` does exactly that (via
 * `bodyKind.ts`'s `isDataBody`) before calling either function below.
 */
type ScalarCandidate = Atom | Product | Sum | Reference;

/** The half of {@link AtomType} a bare "does this token satisfy this type" check needs -- see this module's own top note on why `write` never enters into it. */
export interface ScalarParser {
  read(token: AtomToken): unknown;
}

/**
 * Whether `body`, resolved under `declaredName`, is a scalar type: the type a bare token can
 * denote directly (§5.2's "a fixed or default value is available on a scalar-typed field and
 * nowhere else"). Every ATOM-kind body counts, `void` excepted -- `void` is the type with no
 * value, so no token is one (§4.2).
 */
export function isScalarBody(declaredName: string, body: ScalarCandidate): boolean {
  switch (body.kind) {
    case 'unit':
      return declaredName !== 'void';
    case 'enum':
    case 'integer_type':
    case 'text_type':
    case 'uri_type':
    case 'regex_type':
    case 'decimal_type':
    case 'float_type':
    case 'rational_type':
    case 'uuid_type':
    case 'binary':
    case 'date_type':
    case 'time_type':
    case 'datetime_type':
    case 'duration_type':
    case 'cidr4_type':
    case 'cidr6_type':
    case 'email_type':
    case 'mac_type':
    case 'ipv4_type':
    case 'ipv6_type':
    case 'complex_type':
      return true;
    default:
      return false; // record, array, map, tuple, choice, reference, unknown_type, extern, and Data
  }
}

// ── enum ─────────────────────────────────────────────────────────────────────────────────────

/**
 * `boolean => !enum [true false]` narrows to a real host `boolean`; every other enum reads its
 * member text verbatim. Mirrors `compiler/atomBuilder.ts`'s own `buildEnumAtomType` exactly --
 * duplicated rather than shared for the reason this module's own top note gives for the whole
 * dispatch: that one hands back a `TypeReader<Value>` wired through the tree/reader machinery,
 * and this one a bare token parser, and the two callers reach this rule at different layers.
 */
function buildEnumParser(typeRef: string, body: EnumBody): AtomType<string | boolean> {
  const members = body.members;
  const memberSet = new Set(members);
  const isBoolean = members.length === 2 && memberSet.has('true') && memberSet.has('false');
  const membership = `one of (${members.join(', ')})`;

  return {
    read(token: AtomToken): string | boolean {
      if (!memberSet.has(token.text)) {
        throw new TsonAtomValidationError(
          typeRef,
          `'${token.text}' is not a member of '${typeRef}' -- expected ${membership}`,
          membership,
        );
      }
      return isBoolean ? token.text === 'true' : token.text;
    },
    write(value: string | boolean): string {
      return typeof value === 'boolean' ? (value ? 'true' : 'false') : value;
    },
  };
}

// ── regex_type ───────────────────────────────────────────────────────────────────────────────

/**
 * `regex_type => ~text_type & atom_specification & { spec: = ... }` (§5.7): every constraint
 * `createTextParser` reads is one `regex_type` carries too, under the identical field names, but
 * with a `kind: 'regex_type'` discriminant `TextType` itself does not accept. Rebuilds the
 * `text_type`-shaped subset by hand (`exactOptionalPropertyTypes` forbids simply spreading the
 * optional fields across) rather than widening `createTextParser`'s own signature -- the same
 * choice `compiler/atomBuilder.ts`'s own `asTextConstraints` makes, duplicated here for the same
 * reason as {@link buildEnumParser} above.
 */
function asTextConstraints(atom: RegexType): TextType {
  const { minLength, maxLength, length, pattern } = atom;
  return {
    kind: 'text_type',
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(length === undefined ? {} : { length }),
    ...(pattern === undefined ? {} : { pattern }),
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
): ScalarParser | undefined {
  switch (body.kind) {
    case 'enum':
      return buildEnumParser(declaredName, body);
    case 'integer_type':
      return createIntegerParser(declaredName, body);
    case 'text_type':
      return createTextParser(declaredName, body);
    case 'uri_type':
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
    case 'binary':
      return createBinaryParser(declaredName, body);
    case 'date_type':
      return createDateParser(declaredName, body);
    case 'time_type':
      return createTimeParser(declaredName, body);
    case 'datetime_type':
      return createDateTimeParser(declaredName, body);
    case 'duration_type':
      return createDurationParser(declaredName, body);
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
    default:
      return undefined; // 'unit' (value/token instances), record, array, map, tuple, choice, reference, unknown_type, extern, Data
  }
}
