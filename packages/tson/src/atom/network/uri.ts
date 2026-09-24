/**
 * Parses and validates against meta-kernel's `uri_type` constructor (§5.5's `!uri` atom, RFC
 * 3986) -- the port of `atom/UriParser.java`, via `uriGrammar.ts`'s hand-written `URI-reference`
 * grammar. See `uriGrammar.ts`'s own TSDoc for why this port parses RFC 3986 itself rather than
 * accepting `UriParser.java`'s documented different-revision gap (delegating to `java.net.URI`,
 * which implements RFC 2396): this port has no host URI type to delegate to at all.
 *
 * **`pattern` (I-Regexp, RFC 9485) is enforced, but not by this module** -- see `email.ts`'s own
 * TSDoc for where and why: `compiler/atomBuilder.ts`'s own `withTextFacets` wraps this parser's
 * `read` with the same `pattern`/`members` checks `text.ts` runs for `text_type`/`regex_type`
 * directly. `minLength`/`maxLength`/`length`/`scheme` are enforced directly, below.
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
    const length = BigInt(text.length);
    if (constraints.length !== undefined && length !== constraints.length) {
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is ${length.toString()} characters, expected exactly ${constraints.length.toString()}`,
        `exactly ${constraints.length.toString()} characters`,
      );
    }
    if (constraints.minLength !== undefined && length < constraints.minLength) {
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is ${length.toString()} characters, less than the minimum ${constraints.minLength.toString()}`,
        `at least ${constraints.minLength.toString()} characters`,
      );
    }
    if (constraints.maxLength !== undefined && length > constraints.maxLength) {
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is ${length.toString()} characters, more than the maximum ${constraints.maxLength.toString()}`,
        `at most ${constraints.maxLength.toString()} characters`,
      );
    }
    // `pattern` (I-Regexp) is enforced by `compiler/atomBuilder.ts`'s own wrapper, not here --
    // see this module's own TSDoc.
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
