/**
 * Parses and validates against meta-kernel's `text_type` constructor (§5.7's `!text` atom, the
 * Unicode code point sequence every other text-shaped atom composes with) -- the port of
 * `atom/TextParser.java`.
 *
 * **Not written by any of Wave 1's four atom sub-agents.** `PORT-PLAN.md`'s split names
 * `atom/{numeric,temporal,network,text}/`, but `text_type` -- the one constructor every other
 * text-shaped family (`email_type`/`uri_type`/`regex_type`) composes -- was never actually
 * authored; `atoms-text.ts`'s own {@link TextType} constraint record has carried no matching
 * parser until this module. Added here because the schemaless built-in vocabulary
 * (`reader/schemaless/vocabulary.ts`) needs a `!text` entry the same way Java's own
 * `BuiltinTypeVocabulary` has one (`TextParser.TYPENAME`) -- see that module's own TSDoc.
 *
 * A pure format check with no shape requirement of its own: any token is a valid `text` (§4.4's
 * "any quoted token resolves to a string" already makes this true of an untyped leaf, and `!text`
 * on an unquoted token simply keeps that token's own text rather than letting §4's null/boolean/
 * number checks reinterpret it). What `text_type` narrows is length and pattern, not shape.
 *
 * **`pattern` (I-Regexp, RFC 9485) is accepted but not yet enforced**, matching `email.ts`'s own
 * documented deferral for exactly the same reason: this port's I-Regexp engine (`regex/`) has not
 * yet landed a matcher as of this module's writing.
 *
 * **Length is counted in UTF-16 code units (`text.length`), matching `email.ts`'s own established
 * convention for this same length-facet family** (`minLength`/`maxLength`/`length`) rather than
 * code points -- a deliberate consistency choice with the sibling atom this composes with, not an
 * independent reading of §5.7. `CLAUDE.md`'s "never index by UTF-16 unit" is about lexer position
 * tracking (line/column/offset), not this family's length facets; worth a second look if that
 * family's convention ever changes, but this module follows it rather than diverging alone.
 */

import { TsonAtomValidationError } from '../../core/errors.js';
import type { TextType } from '../../schema/meta/atoms-text.js';
import type { AtomToken, AtomType } from '../contract.js';

/**
 * Builds the `AtomType` for one fully-parameterised `text_type` instance -- `text =>
 * !text_type {}` is the unconstrained case, `createTextParser('text', { kind: 'text_type' })`.
 * See `integer.ts`'s `createIntegerParser` for why `typeRef` is required explicitly.
 */
export function createTextParser(typeRef: string, constraints: TextType): AtomType<string> {
  function read(token: AtomToken): string {
    const text = token.text;
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
    return text;
  }

  function write(value: string): string {
    return value;
  }

  return { read, write };
}
