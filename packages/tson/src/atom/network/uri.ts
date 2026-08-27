/**
 * Parses and validates against meta-kernel's `uri_type` constructor (§5.5's `!uri` atom, RFC
 * 3986) -- the port of `atom/UriParser.java`, via `uriGrammar.ts`'s hand-written `URI-reference`
 * grammar. See `uriGrammar.ts`'s own TSDoc for why this port parses RFC 3986 itself rather than
 * accepting `UriParser.java`'s documented different-revision gap (delegating to `java.net.URI`,
 * which implements RFC 2396): this port has no host URI type to delegate to at all.
 *
 * **`pattern` (I-Regexp, RFC 9485) is accepted but not yet enforced** -- the same deferral
 * `email.ts` documents, for the same reason: this package's I-Regexp matcher (`regex/`) has not
 * yet landed as of this module's writing. `minLength`/`maxLength`/`length`/`scheme` are fully
 * enforced.
 *
 * Host value is `string`, the authored text unchanged: like `cidr4.ts`/`cidr6.ts`, there is no
 * decomposed URI type in this package to build instead (no `DOM` lib, no global `URL` in this
 * package's type configuration -- `CLAUDE.md`), and a validated-then-returned string round-trips
 * exactly with no risk of a writer reformatting percent-encoding case or component order the way
 * a structured type's own `toString()` might.
 */

import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import type { UriType } from '../../schema/meta/atoms-text.js';
import type { AtomToken, AtomType } from '../contract.js';
import { parseIpv6Bytes } from './ipv6.js';
import { tryParseUri, type UriShape } from './uriGrammar.js';

function parseIpv6Candidate(candidate: string): boolean {
  return parseIpv6Bytes(candidate) !== undefined;
}

/**
 * Builds the `AtomType` for one fully-parameterised `uri_type` instance. `typeRef` names the
 * type for error reporting, e.g. `'uri'` for §5.5's unconstrained `uri => !uri_type {}`.
 */
export function createUriParser(typeRef: string, constraints: UriType): AtomType<string> {
  function read(token: AtomToken): string {
    const text = token.text;
    const parsed = tryParseUri(text, parseIpv6Candidate);
    if (parsed === undefined) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid URI -- expected RFC 3986's URI-reference grammar (§5.5)`,
        'a URI',
      );
    }
    validate(text, parsed);
    return text;
  }

  function validate(text: string, parsed: UriShape): void {
    if (constraints.length !== undefined && text.length !== constraints.length) {
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is ${String(text.length)} characters, expected exactly ${String(constraints.length)}`,
        `exactly ${String(constraints.length)} characters`,
      );
    }
    if (constraints.minLength !== undefined && text.length < constraints.minLength) {
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is ${String(text.length)} characters, less than the minimum ${String(constraints.minLength)}`,
        `at least ${String(constraints.minLength)} characters`,
      );
    }
    if (constraints.maxLength !== undefined && text.length > constraints.maxLength) {
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is ${String(text.length)} characters, more than the maximum ${String(constraints.maxLength)}`,
        `at most ${String(constraints.maxLength)} characters`,
      );
    }
    // `pattern` (I-Regexp) is deferred until `regex/` lands a matcher -- see this module's TSDoc.
    const { pattern: _pattern } = constraints;
    if (constraints.scheme !== undefined) {
      const actual = parsed.scheme;
      if (actual?.toLowerCase() !== constraints.scheme.toLowerCase()) {
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' has scheme '${actual ?? ''}', expected '${constraints.scheme}'`,
          `scheme ${constraints.scheme}`,
        );
      }
    }
  }

  function write(value: string): string {
    return value;
  }

  return { read, write };
}
