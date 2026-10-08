import type { IdentifierBase, IdentifierType, Normalization } from '../schema/meta/atoms-text.js';
import { isJoiningControlPermitted, joiningControlsSatisfied } from './joining-controls.js';
import { isNfc } from './nfc.js';
import { holdsNormalization } from './normalization.js';
import { identifierStatusAllowed } from './uts39.js';
import { isIdContinue, isIdStart, isXidContinue, isXidStart } from './xid.js';

/**
 * The identifier grammar (§7.7): the profile a name — a field name, type name, annotation name,
 * parameter name, or enum member — must match, applied to the token's **fully decoded text**
 * (after unquoting, escape processing, and NFC normalisation) exactly as the number grammar
 * (§7.6) applies to a token's complete decoded text. It is not part of the token-stream grammar:
 * the lexer produces a token as an ordinary unquoted or quoted spelling, and the position that
 * knows it holds a name matches the decoded text against this profile separately.
 *
 * ```
 * identifier          = identifier-start *identifier-continue
 * identifier-start    = XID_Start
 * identifier-continue = XID_Continue / "-"
 * ```
 *
 * This is §7.1's unquoted-token profile *minus* the extensions the number grammar needs: `Nd`,
 * `-`, `+`, and `.` sit in the token profile's start set so a number can be an unquoted token, and
 * reach names only because names and values share one lexical class. Dropping `Nd` from
 * `identifier-start` is what makes an identifier never begin with a digit, and dropping `+`/`.`
 * from `identifier-continue` (keeping only `-`) is what keeps a token that merely begins like a
 * number — `42x`, `-foo`'s sign, `1.5`'s dot — out of name position. Every identifier this
 * production admits is, by construction, also a well-formed unquoted token, so no identifier ever
 * needs quoting on its own account.
 *
 * §7.7 attaches three rules on top of the bare production; this module implements two of them:
 *
 * 1. **NFC** ({@link isIdentifierText}). An identifier's text MUST be Unicode Normalization Form
 *    C. For an unquoted spelling this is already the lexer's own rule at token end (§7.2.1); this
 *    check re-states it over the name's *decoded* text so a quoted spelling at a naming position —
 *    exempt from the lexer's NFC check, which is unquoted-token-only — is still held to it here,
 *    where identity between names is defined as byte identity of the NFC text.
 * 2. **Joining controls.** ZWNJ (U+200C) and ZWJ (U+200D) are `XID_Continue`, so the production
 *    above admits them like any other continue character, matching §7.1's token profile, which
 *    admits them unconditionally. §7.7 rule 2 narrows that at naming positions: a joiner is part
 *    of an identifier only in the contexts UTS #39 §3.1.1.1 defines — conditions A1, A2 and B on
 *    the neighbouring characters' `Joining_Type`, `Canonical_Combining_Class` and
 *    `Indic_Syllabic_Category`, under the global conditions that the text be NFC and
 *    single-script. `joining-controls.ts` decides that, and {@link isIdentifierText} composes it,
 *    so the joiners are admitted where they have a shaping effect — a Persian compound, an Indic
 *    conjunct — and refused where they are invisible, which is every position in a Latin name.
 *    All three conditions are implemented: the Arabic one alone admits Persian and refuses
 *    Malayalam, which is the wrong line.
 * 3. **No reserved words.** Nothing is excluded by name — `true`, `false`, and `null` are
 *    identifiers like any other — and this needs no code: the production alone already settles
 *    it. The one thing that looks like a reserved word, the token-initial underscore claimed by
 *    the void sentinel `_` (§7.1), is not a name exclusion either. `_` is `XID_Continue` only,
 *    never `XID_Start`, so `identifier-start` already refuses it and no identifier can begin with
 *    one — `_` and `_id` fail {@link isIdentifierText} by falling straight out of the production,
 *    with no special case written for them anywhere in this module.
 *
 * §7.7 lists the naming positions this applies to as a parse error: record field names at either
 * spelling (§2.5 — quoting escapes a lexical accident, not a wider name set), annotation names and
 * type-annotation names (§7.4's `identifier` marks, resolved in the data grammar at §3.1/§3.2),
 * and every naming position of the schema grammar. Map keys are values, not names, and are never
 * matched against this profile (§2.6).
 *
 * The grammar is built only on properties the Unicode Standard has frozen, so every host at every
 * Unicode version returns the same verdict on the same text — which is what lets a
 * content-addressed schema's validity (§2.2.1) rest on it. The name-hygiene mechanisms of §8.2 do
 * depend on unstable data and are deliberately kept out of validity, and out of this module.
 */

const HYPHEN_MINUS = 0x2d;

/**
 * Whether `text` is a well-formed identifier (§7.7): the `identifier` production and all three
 * rules that sit on top of it, over `text` taken as a token's complete decoded text.
 *
 * Rule 1 is NFC. Rule 2 is the joining-control contexts of UTS #39 §3.1.1.1, delegated to
 * `joining-controls.ts`: ZWNJ and ZWJ are `XID_Continue`, so the production admits them, and what
 * keeps that safe is admitting them only where they have a shaping effect. Rule 3 needs no code —
 * the grammar excludes nothing by name, so `true`, `false` and `null` are identifiers like any
 * other, and `_` is `XID_Continue` only, so no identifier begins with one.
 *
 * Empty text is never an identifier: the production requires `identifier-start`, and there is no
 * code point to satisfy it.
 */
export function isIdentifierText(text: string): boolean {
  if (text.length === 0) return false;
  if (!isNfc(text)) return false;

  let first = true;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    // `character` comes from iterating `text`, so it is always a well-formed single code point;
    // `codePointAt(0)` on a non-empty string is never `undefined`. The guard keeps this total
    // rather than asserting, matching the same pattern in `nfc.ts`.
    if (codePoint === undefined) return false;
    if (first) {
      if (!isXidStart(codePoint)) return false;
      first = false;
    } else if (!(isXidContinue(codePoint) || codePoint === HYPHEN_MINUS)) {
      return false;
    }
  }
  return joiningControlsSatisfied(text);
}

// ── Profiles as data (§5.5, §7.7) ─────────────────────────────────────────────────────────────

/**
 * A UAX #31 identifier profile, built from the kernel's `identifier_type` facets ([TSON-SCHEMA]
 * §5.5): the shape UAX #31's R1 default identifier syntax takes, each set drawn from a Unicode
 * property and adjusted.
 *
 * ```
 * identifier := Start Continue* (Medial Continue+)*
 * Start      := (start base    ∪ start_add)    − exclude
 * Continue   := (continue base ∪ continue_add) − exclude
 * Medial     := medial
 * ```
 *
 * A medial character stands only between two others, and never beside another medial; the set is
 * disjoint from Start and Continue, or the rule could not tell which one a character is using
 * ({@link profileIncoherence}). The text the profile judges is the family's **value**, already in
 * the profile's `normalization` form: {@link checkIdentifier} refuses text not in the form rather
 * than normalising it, so the stored name equals the compared name for every caller.
 *
 * {@link NAME_PROFILE} is §7.7's: `XID_Start`, `XID_Continue ∪ { - }`, NFC. Every profile applies
 * §7.7 rule 2's join-control contexts, an invisible joiner being as much a spoofing surface in an
 * outside system's names as in the series' own.
 */
export interface IdentifierProfile {
  readonly start: IdentifierBase;
  readonly continueBase: IdentifierBase;
  /** Sorted, distinct code points: order and repetition of the facet's text mean nothing. */
  readonly startAdd: readonly number[];
  readonly continueAdd: readonly number[];
  readonly medial: readonly number[];
  readonly exclude: readonly number[];
  readonly normalization: Normalization;
}

/** The set of code points `text` holds, sorted and distinct. */
export function codePointSet(text: string | undefined): readonly number[] {
  if (text === undefined) return [];
  const set = new Set<number>();
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined) set.add(codePoint);
  }
  return [...set].sort((a, b) => a - b);
}

/** The profile an `identifier_type` body's facets make. Build once per reader, not per read. */
export function identifierProfileOf(
  body: Pick<
    IdentifierType,
    'start' | 'continue' | 'startAdd' | 'continueAdd' | 'medial' | 'exclude' | 'normalization'
  >,
): IdentifierProfile {
  return {
    start: body.start,
    continueBase: body.continue,
    startAdd: codePointSet(body.startAdd),
    continueAdd: codePointSet(body.continueAdd),
    medial: codePointSet(body.medial),
    exclude: codePointSet(body.exclude),
    normalization: body.normalization,
  };
}

/** [TSON-DATA] §7.7's profile: `XID_Start`, `XID_Continue ∪ { - }`, NFC. */
export const NAME_PROFILE: IdentifierProfile = {
  start: 'XID',
  continueBase: 'XID',
  startAdd: [],
  continueAdd: [HYPHEN_MINUS],
  medial: [],
  exclude: [],
  normalization: 'NFC',
};

const ZWNJ = 0x200c;
const ZWJ = 0x200d;

function has(set: readonly number[], codePoint: number): boolean {
  if (set.length === 0) return false;
  let low = 0;
  let high = set.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const at = set[mid] ?? 0;
    if (at === codePoint) return true;
    if (at < codePoint) low = mid + 1;
    else high = mid - 1;
  }
  return false;
}

function inBase(base: IdentifierBase, codePoint: number, start: boolean): boolean {
  switch (base) {
    case 'XID':
      return start ? isXidStart(codePoint) : isXidContinue(codePoint);
    case 'ID':
      return start ? isIdStart(codePoint) : isIdContinue(codePoint);
    case 'NONE':
      return false;
  }
}

function profileStart(profile: IdentifierProfile, codePoint: number): boolean {
  return (
    (inBase(profile.start, codePoint, true) || has(profile.startAdd, codePoint)) &&
    !has(profile.exclude, codePoint)
  );
}

function profileContinue(profile: IdentifierProfile, codePoint: number): boolean {
  return (
    (inBase(profile.continueBase, codePoint, false) || has(profile.continueAdd, codePoint)) &&
    !has(profile.exclude, codePoint)
  );
}

function added(profile: IdentifierProfile, codePoint: number): boolean {
  return (
    has(profile.startAdd, codePoint) ||
    has(profile.continueAdd, codePoint) ||
    has(profile.medial, codePoint)
  );
}

/** Names the offending code point rather than printing it -- much of what a profile rejects is invisible. */
function at(text: string, codePoint: number, index: number): string {
  const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
  return `'${text}': U+${hex} at index ${String(index)}`;
}

/**
 * `profile` over `text` (§7.7, §5.5): the violation, or `undefined` when `text` is an identifier
 * under it. `text` is the **value** -- already in the profile's `normalization` form -- and a
 * failure here is a grammar violation whatever the family's other facets say, so a `pattern` or
 * `members` is only ever asked of a well-formed name.
 *
 * Reports a violation rather than throwing one, so the same check serves a caller that owes a
 * parse error and one that owes a diagnostic. Indexes are UTF-16 offsets into `text`, as
 * `joining-controls.ts` addresses it; every judgement is by code point.
 */
export function checkIdentifier(profile: IdentifierProfile, text: string): string | undefined {
  if (text.length === 0) return 'an identifier may not be empty';
  if (!holdsNormalization(profile.normalization, text)) {
    return `'${text}' is not in ${profile.normalization} form`;
  }
  const first = text.codePointAt(0) ?? 0;
  if (!profileStart(profile, first)) {
    const signOrDigit =
      (first >= 0x30 && first <= 0x39) || first === 0x2d || first === 0x2b || first === 0x2e;
    return (
      `${at(text, first, 0)} cannot start an identifier` +
      (signOrDigit ? ' -- an identifier never begins with a digit or a sign' : '')
    );
  }
  let afterMedial = false;
  let lastIndex = 0;
  let lastCodePoint = first;
  for (let i = first > 0xffff ? 2 : 1; i < text.length;) {
    const codePoint = text.codePointAt(i) ?? 0;
    if (profileContinue(profile, codePoint)) {
      if ((codePoint === ZWNJ || codePoint === ZWJ) && !isJoiningControlPermitted(text, i)) {
        return (
          `${at(text, codePoint, i)} is a join control outside the contexts UTS #39 §3.1.1.1 ` +
          'permits -- it has no shaping effect here, so it is invisible'
        );
      }
      afterMedial = false;
    } else if (has(profile.medial, codePoint)) {
      if (afterMedial) return `${at(text, codePoint, i)} follows another medial character`;
      afterMedial = true;
    } else {
      return `${at(text, codePoint, i)} cannot appear in an identifier`;
    }
    lastIndex = i;
    lastCodePoint = codePoint;
    i += codePoint > 0xffff ? 2 : 1;
  }
  if (afterMedial) {
    return `${at(text, lastCodePoint, lastIndex)} is a medial character and cannot end an identifier`;
  }
  return undefined;
}

/**
 * What makes `profile` admit no identifier, or admit one ambiguously: empty when there is nothing
 * (§5.5). A Start set left empty admits nothing at all; a medial character that is also Start or
 * Continue could be read as either, which the grammar's placement rule cannot decide.
 */
export function profileIncoherence(profile: IdentifierProfile): string[] {
  const problems: string[] = [];
  if (profile.start === 'NONE' && profile.startAdd.every((c) => has(profile.exclude, c))) {
    problems.push('the Start set is empty, so no text is an identifier');
  }
  for (const codePoint of profile.medial) {
    if (profileStart(profile, codePoint) || profileContinue(profile, codePoint)) {
      problems.push(
        `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} is medial and also Start or Continue`,
      );
    }
  }
  return problems;
}

/**
 * [TSON-DATA] §8.2's restricted-character rule alone, over a name `profile` admits: the violation,
 * or `undefined`. Every character must be `Identifier_Status=Allowed` (UTS #39 §3.1).
 *
 * Some characters are the grammar's rather than this rule's, though the table may restrict them. A
 * character the profile adds -- `start_add`, `continue_add` or `medial`, as {@link NAME_PROFILE}
 * adds `-` -- is the profile's own extension, which §8.2 says carries no `Identifier_Status` and
 * participates in no name-hygiene rule: a profile that admits `$` has decided `$` belongs in its
 * names. ZWNJ and ZWJ are `Identifier_Status=Restricted`, and §7.7 rule 2 carves the exception UTS
 * #39 §3.1.1.1 defines, which makes their admission a question of *form* and so
 * {@link checkIdentifier}'s: a joiner outside those contexts is not an identifier at all, where a
 * restricted character is an identifier this processor declines to accept.
 */
export function restrictedCharacterViolation(
  profile: IdentifierProfile,
  text: string,
): string | undefined {
  for (let i = 0; i < text.length;) {
    const codePoint = text.codePointAt(i) ?? 0;
    if (
      codePoint !== ZWNJ &&
      codePoint !== ZWJ &&
      !identifierStatusAllowed(codePoint) &&
      !added(profile, codePoint)
    ) {
      return `${at(text, codePoint, i)} is Identifier_Status=Restricted (UTS #39)`;
    }
    i += codePoint > 0xffff ? 2 : 1;
  }
  return undefined;
}

/**
 * Whether `codePoint` divides a name under `profile` into the segments a per-segment restriction
 * level judges one at a time ([TSON-DATA] §8.2's unit): `_`, and every character the profile adds
 * that is not `XID_Continue` -- {@link NAME_PROFILE}'s `-`, which makes §8.2's `_`/`-` exactly this
 * profile's answer, and another profile's `$` or medial `.`. Such a character is the profile's own
 * punctuation, so a script change across it sits between words, where a homograph cannot.
 */
export function profileSeparates(profile: IdentifierProfile, codePoint: number): boolean {
  return codePoint === 0x5f || (added(profile, codePoint) && !isXidContinue(codePoint));
}
