/**
 * Parses and validates against the meta's `uri_type` and the kernel's `iri_type` constructors
 * (§5.5's `!uri_reference`/`!uri` and `!iri_reference`/`!iri`, RFC 3986 and RFC 3987), via
 * `uriGrammar.ts`'s hand-written grammar. A URI is US-ASCII, and a character beyond it is a parse
 * error that points at `!iri`; a relative reference under a type that withdraws `allow_relative`
 * is a validation error, since it is well-formed and outside the value space.
 *
 * Length facets count code points, never UTF-16 units.
 *
 * **`pattern` (I-Regexp, RFC 9485) is enforced, but not by this module** -- see `email.ts`'s own
 * TSDoc for where and why: `compiler/atomBuilder.ts`'s own `withTextFacets` wraps this parser's
 * `read` with the same `pattern`/`members` checks `text.ts` runs for `text_type`/`regex_type`
 * directly. `minLength`/`maxLength`/`length`/`schemes` are enforced directly, below.
 *
 * Host value is `string`, the authored text unchanged: like `cidr4.ts`/`cidr6.ts`, there is no
 * decomposed URI type in this package to build instead (no `DOM` lib, no global `URL` in this
 * package's type configuration -- `CLAUDE.md`), and a validated-then-returned string round-trips
 * exactly with no risk of a writer reformatting percent-encoding case or component order the way
 * a structured type's own `toString()` might.
 */

import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import type { IriType, UriType } from '../../schema/meta/atoms-text.js';
import type { AtomToken, AtomType } from '../contract.js';
import { codePointLength } from '../text/codePointLength.js';
import { parseIpv6Bytes } from './ipv6.js';
import { tryParseUri, type UriGrammar, type UriShape } from './uriGrammar.js';

function parseIpv6Candidate(candidate: string): boolean {
  return parseIpv6Bytes(candidate) !== undefined;
}

const URI_GRAMMAR: UriGrammar = { iri: false, parseIpv6: parseIpv6Candidate };
const IRI_GRAMMAR: UriGrammar = { iri: true, parseIpv6: parseIpv6Candidate };

/**
 * Parses `text` as a reference under the grammar of `iri`, returning its shape. A character beyond
 * US-ASCII under the URI grammar is a {@link TsonAtomParseError} that points at the IRI family;
 * any other grammar failure is one too. Shared with the directive-argument check (§2.2.1, §3.3).
 */
export function parseReference(text: string, iri: boolean, typeRef: string): UriShape {
  const family = iri ? 'IRI' : 'URI';
  if (!iri) {
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      if (code > 0x7f) {
        throw new TsonAtomParseError(
          typeRef,
          `'${text}' has U+${code.toString(16).toUpperCase().padStart(4, '0')}, beyond the US-ASCII of a URI (RFC 3986 §2); an IRI is written !iri`,
          'a URI',
        );
      }
    }
  }
  const parsed = tryParseUri(text, iri ? IRI_GRAMMAR : URI_GRAMMAR);
  if (parsed === undefined) {
    throw new TsonAtomParseError(
      typeRef,
      `'${text}' is not a valid ${family} (${iri ? 'RFC 3987' : 'RFC 3986'}'s ${family}-reference grammar, §5.5)`,
      iri ? 'an IRI' : 'a URI',
    );
  }
  return parsed;
}

/**
 * Whether `text` is an RFC 3987 `IRI-reference` -- the grammar of a directive's argument (§2.2.1,
 * §3.3), which may be relative and may carry characters beyond US-ASCII.
 */
export function isIriReference(text: string): boolean {
  return tryParseUri(text, IRI_GRAMMAR) !== undefined;
}

/**
 * Builds the `AtomType` for one fully-parameterised `uri_type` or `iri_type` instance. `typeRef`
 * names the type for error reporting, e.g. `'uri'` for core's `uri => !uri_reference ^ {
 * allow_relative: false }`.
 */
export function createUriParser(typeRef: string, constraints: UriType | IriType): AtomType<string> {
  const iri = constraints.kind === 'iri_type';
  const absolute = iri ? 'an RFC 3987 IRI' : 'an RFC 3986 URI';

  function read(token: AtomToken): string {
    const text = token.text;
    validate(text, parseReference(text, iri, typeRef));
    return text;
  }

  function validate(text: string, parsed: UriShape): void {
    if (!constraints.allowRelative && parsed.scheme === undefined) {
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is a relative reference, and the type requires a scheme`,
        absolute,
      );
    }
    const length = BigInt(codePointLength(text));
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
    if (constraints.schemes !== undefined) {
      const actual = parsed.scheme === undefined ? undefined : foldAscii(parsed.scheme);
      if (actual === undefined || !constraints.schemes.some((s) => foldAscii(s) === actual)) {
        const admitted = `scheme one of (${constraints.schemes.join(', ')})`;
        throw new TsonAtomValidationError(
          typeRef,
          parsed.scheme === undefined
            ? `'${text}' has no scheme, and the type admits ${admitted}`
            : `'${text}' has scheme '${parsed.scheme}', and the type admits ${admitted}`,
          admitted,
        );
      }
    }
    if (!constraints.allowFragment && parsed.fragment) {
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' has a fragment, which the type refuses`,
        'no fragment',
      );
    }
  }

  function write(value: string): string {
    return value;
  }

  return { read, write };
}

/** ASCII case folding of a scheme (RFC 3986 §3.1): only A-Z move. */
function foldAscii(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : text.charAt(i);
  }
  return out;
}
