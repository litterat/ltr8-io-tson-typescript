import { joiningControlsSatisfied } from './joining-controls.js';
import { isNfc } from './nfc.js';
import { isXidContinue, isXidStart } from './xid.js';

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
 *    the absent sentinel `_` (§7.1), is not a name exclusion either. `_` is `XID_Continue` only,
 *    never `XID_Start`, so `identifier-start` already refuses it and no identifier can begin with
 *    one — `_` and `_id` fail {@link isIdentifierText} by falling straight out of the production,
 *    with no special case written for them anywhere in this module.
 *
 * §7.7 lists the naming positions this applies to as a parse error: annotation names and
 * type-annotation names (§7.4's `identifier` marks, resolved in the data grammar at §3.1/§3.2) and
 * every naming position of the schema grammar. Record field names are explicitly exempted — they
 * stay lexical (§2.5) and are never matched against this profile — and map keys are values, not
 * names, and are never matched against it either (§2.6).
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
