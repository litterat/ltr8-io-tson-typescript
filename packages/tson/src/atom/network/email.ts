/**
 * Parses and validates against meta.tn's `email_type` constructor (core.tn's `email`, pinned to
 * RFC 5322) -- the port of `atom/EmailParser.java`. Composes `text_type`'s length facets, checked
 * the same way `text.ts` checks its own, plus an address-shape check on top -- without that last
 * part `!email` would say nothing `text` does not.
 *
 * **The format check is a documented subset of RFC 5322, not the whole grammar**, matching
 * `EmailParser.java`'s own scoping exactly. Accepted is the `dot-atom "@" dot-atom` core: one or
 * more dot-separated atoms of RFC 5322's `atext` on each side, no leading, trailing or doubled
 * dot. Deliberately *not* accepted, though RFC 5322's `addr-spec` admits them: a quoted-string
 * local part (`"a b"@example.com`), a domain literal (`user@[192.0.2.1]`), and comments or
 * folding whitespace anywhere (`user(note)@example.com`). Those forms are legal, essentially
 * unused in the data-interchange setting TSON targets, and accepting them would mean admitting
 * spaces and parentheses into a field most consumers treat as a simple token -- §5.5's own
 * scoping of the RFC 5322 pin, not a narrowing of it.
 *
 * **`pattern` (I-Regexp, RFC 9485) is accepted but not yet enforced.** `email_type` composes
 * `text_type`'s `pattern` facet the same way `EmailParser.java` checks it via `TsonRegex`, but
 * this port's I-Regexp engine (`regex/`, a separate work package) has not yet landed a matcher as
 * of this module's writing -- only its error type and Unicode category tables exist. Enforcing
 * `pattern` here is deferred until that lands; see this package's own `STATUS.md`/work-package
 * notes. `minLength`/`maxLength`/`length` are fully enforced.
 *
 * Host value is `string`: an address IS-A piece of text (it composes `text_type`), so like
 * `regex.ts` it hands back the text itself rather than a parsed structure.
 */

import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import type { EmailType } from '../../schema/meta/atoms-text.js';
import type { AtomToken, AtomType } from '../contract.js';

const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;
const ASCII_UPPER_A = 0x41;
const ASCII_UPPER_Z = 0x5a;
const ASCII_LOWER_A = 0x61;
const ASCII_LOWER_Z = 0x7a;
const ASCII_DOT = 0x2e;

/** RFC 5322's `atext` special characters -- its own printable set minus the specials. */
const ATEXT_SPECIALS = "!#$%&'*+/=?^_`{|}~-";

function isAtextCode(code: number): boolean {
  if (code >= ASCII_ZERO && code <= ASCII_NINE) return true;
  if (code >= ASCII_UPPER_A && code <= ASCII_UPPER_Z) return true;
  if (code >= ASCII_LOWER_A && code <= ASCII_LOWER_Z) return true;
  return ATEXT_SPECIALS.includes(String.fromCharCode(code));
}

/** `1*atext` starting at `pos`, stopping before `end` -- `undefined` if it matches zero characters. */
function readAtextRun(text: string, pos: number, end: number): number | undefined {
  let i = pos;
  while (i < end && isAtextCode(text.charCodeAt(i))) i += 1;
  return i > pos ? i : undefined;
}

/**
 * `dot-atom = atext-run *("." atext-run)` between `pos` and `end` -- one or more `atext` runs
 * joined by single dots, so a leading dot, a trailing dot, and a doubled dot are each a failed
 * `atext` run immediately after the separator, not a special case.
 */
function readDotAtom(text: string, pos: number, end: number): number | undefined {
  let cursor = readAtextRun(text, pos, end);
  if (cursor === undefined) return undefined;
  while (cursor < end && text.charCodeAt(cursor) === ASCII_DOT) {
    const next = readAtextRun(text, cursor + 1, end);
    if (next === undefined) return undefined;
    cursor = next;
  }
  return cursor;
}

/**
 * `dot-atom "@" dot-atom`, matched in full. `atext` never contains `@`, so the first `@` in
 * `text` is always the only one that could possibly be the separator -- if it is not, the local
 * or domain half fails to consume exactly up to it and this returns `false` regardless.
 */
function isValidEmailShape(text: string): boolean {
  const at = text.indexOf('@');
  if (at < 0) return false;
  const localEnd = readDotAtom(text, 0, at);
  if (localEnd !== at) return false;
  const domainEnd = readDotAtom(text, at + 1, text.length);
  return domainEnd === text.length;
}

/**
 * Builds the `AtomType` for one fully-parameterised `email_type` instance. `typeRef` names the
 * type for error reporting, e.g. `'email'` for core.tn's unconstrained `email => !email_type {}`.
 */
export function createEmailParser(typeRef: string, constraints: EmailType): AtomType<string> {
  function read(token: AtomToken): string {
    const text = token.text;
    if (!isValidEmailShape(text)) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid email address -- expected RFC 5322's dot-atom form, ` +
          `local@domain (quoted local parts, domain literals and comments are not accepted; ` +
          `see this module's own TSDoc)`,
        'an RFC 5322 dot-atom address',
      );
    }
    validate(text);
    return text;
  }

  function validate(text: string): void {
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
  }

  function write(value: string): string {
    return value;
  }

  return { read, write };
}
