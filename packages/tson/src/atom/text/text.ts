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
 * on an unquoted token simply keeps that token's own text rather than letting §4's boolean and
 * number checks reinterpret it). What `text_type` narrows is length and pattern, not shape.
 *
 * **Length is counted in Unicode code points**, matching the kernel's own `text_type` doc
 * ("Lengths count code points") -- `Array.from` iterates a string by code point, not by UTF-16
 * code unit, the same convention `compiler/atomChecks.ts`'s own `textMemberCoherence` already
 * applies to `members` at schema load. A read-time length check by `text.length` alone would
 * disagree with that schema-load check on any member outside the Basic Multilingual Plane.
 *
 * **`members` (§7.4, §5.7, #22) is enforced here**, via {@link createMembershipCheck}: a value
 * outside a declared member set is `ATOM_CONSTRAINT_VIOLATION`. **`pattern` (I-Regexp, RFC 9485)
 * is enforced here too**, via {@link createPatternCheck}: a read value the pattern does not
 * match is `ATOM_CONSTRAINT_VIOLATION` (§7.4, §5.5). `pattern` is parsed once, at reader-build
 * time -- schema load has already validated its syntax (`compiler/atomChecks.ts`'s own
 * `textCoherence`), so a pattern reaching this module is always well-formed, and re-parsing it
 * per read would repeat work every value pays for. `regex/`'s own `matches` runs a Thompson-NFA
 * (`pike.ts`), never a host `RegExp`, matching every other read path's own I-Regexp use.
 */

import { TsonAtomValidationError } from '../../core/errors.js';
import type { TextType } from '../../schema/meta/atoms-text.js';
import type { AtomToken, AtomType } from '../contract.js';
import { toNfc } from '../../unicode/nfc.js';
import { parseRegex } from '../../regex/index.js';

/**
 * Builds the `AtomType` for one fully-parameterised `text_type` instance -- `text =>
 * !text_type {}` is the unconstrained case, `createTextParser('text', { kind: 'text_type' })`.
 * See `integer.ts`'s `createIntegerParser` for why `typeRef` is required explicitly.
 */
export function createTextParser(typeRef: string, constraints: TextType): AtomType<string> {
  const checkMembership = createMembershipCheck(typeRef, constraints.members);
  const checkPattern = createPatternCheck(typeRef, constraints.pattern);

  function read(token: AtomToken): string {
    const text = token.text;
    const length = BigInt(Array.from(text).length);
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
    checkPattern?.(text);
    checkMembership?.(text);
    return text;
  }

  function write(value: string): string {
    return value;
  }

  return { read, write };
}

/**
 * Builds the read-time membership check for `text_type.members` (§7.4, §5.7, #22) — the sparse
 * case on the text tier, as `integer_type.members`/`decimal_type.members` are on the numeric ones.
 * `undefined` when `members` is absent, so a caller may compose it unconditionally.
 *
 * Reached by `text_type` itself and, through `compiler/atomBuilder.ts`'s own dispatch, by
 * `regex_type`, `uri_type` and `email_type` alike — the four families that compose `text_type`'s
 * `members` facet (§9) — so the check lives here once rather than once per family. **Members are
 * compared as text, NFC** (§7.4): both the declared member and the candidate value are
 * NFC-normalised before comparison, matching identifier equality's own rule (§7.7) even though a
 * `TEXT`-profile member need not itself be a name.
 */
export function createMembershipCheck(
  typeRef: string,
  members: readonly string[] | undefined,
): ((text: string) => void) | undefined {
  if (members === undefined) return undefined;
  const normalized = new Set(members.map(toNfc));
  const membership = `one of (${members.join(', ')})`;
  return (text: string): void => {
    if (!normalized.has(toNfc(text))) {
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is not a member of '${typeRef}' -- expected ${membership}`,
        membership,
      );
    }
  };
}

/**
 * Builds the read-time enforcement for `text_type.pattern` (I-Regexp, RFC 9485; §7.4, §5.5) —
 * the sibling of {@link createMembershipCheck}, and reached the same way by
 * `compiler/atomBuilder.ts`'s own dispatch: `text_type` and `regex_type` through this module's
 * own {@link createTextParser}, `uri_type` and `email_type` through `atomBuilder.ts`'s own
 * wrapper, since all four compose `text_type`'s `pattern` facet (§9). `undefined` when `pattern`
 * is absent, so a caller may compose it unconditionally.
 *
 * **Parses once, at reader-build time.** `pattern`'s syntax is already checked at schema load
 * (`compiler/atomChecks.ts`'s own `textCoherence`), so a pattern reaching this function always
 * parses; re-parsing here — rather than per read, or trusting an unparsed string past load —
 * builds the {@link Regex} once and reuses it for every value the position ever reads, the same
 * shape {@link createMembershipCheck}'s own `Set` construction already takes for `members`.
 */
export function createPatternCheck(
  typeRef: string,
  pattern: string | undefined,
): ((text: string) => void) | undefined {
  if (pattern === undefined) return undefined;
  const regex = parseRegex(pattern);
  return (text: string): void => {
    if (!regex.matches(text)) {
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' does not match '${typeRef}'’s pattern '${pattern}' (RFC 9485)`,
        `text matching '${pattern}'`,
      );
    }
  };
}
