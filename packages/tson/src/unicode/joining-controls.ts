import {
  isExplicitlyNotTransparent,
  isExplicitlyTransparent,
  isLeftJoining,
  isLetter,
  isNonzeroCombiningClass,
  isNonSpacingMark,
  isEnclosingMark,
  isFormatControl,
  isRightJoining,
  isVirama,
  isVowelDependent,
  scriptOf,
  SCRIPT_COMMON,
  SCRIPT_INHERITED,
} from './uts39.js';

/**
 * UTS #39 §3.1.1.1, *Limited Contexts for Joining Controls* — [TSON-DATA] §7.7 rule 2.
 *
 * ZWNJ (U+200C) and ZWJ (U+200D) are `XID_Continue`, so the bare identifier production admits
 * them anywhere, and both are `Identifier_Status=Restricted` ({@link "./uts39.js"}
 * `identifierStatusAllowed`), so mechanism 2 refuses them everywhere by default. Neither answer
 * is right in isolation: dropped into Latin, `ad<ZWNJ>min` renders exactly as `admin` and is pure
 * spoofing surface, but the joiners are not decoration in the scripts that use them — ZWNJ breaks
 * a cursive connection and ZWJ forces one, so Persian `کتاب‌ها` ("books") is misspelled without
 * it, and Indic scripts use both to control conjunct formation. §3.1.1.1 is what tells the two
 * apart, mechanically: a joiner is admitted exactly where it has a shaping effect, and refused
 * where it is invisible.
 *
 * **The three contexts**, transcribed from §3.1.1.1's own regular expressions:
 *
 * - **A1** `/$LJ $T* ZWNJ $T* $RJ/` — ZWNJ breaking a cursive connection.
 * - **A2** `/$L $M* $V $M₁* ZWNJ $M₁* $L/` — ZWNJ in a conjunct context.
 * - **B**  `/$L $M* $V $M₁* ZWJ (?!$D)/` — ZWJ in a conjunct context.
 *
 * **Both of §3.1.1.1's global conditions apply to the matched sequence, not to the whole
 * identifier.** The script restriction ({@link singleScriptSpan}) is checked here, over each
 * matched span only. Normalization is not checked here at all: a caller MUST NFC-normalize
 * `text` before calling anything in this module — {@link "./identifier-profile.js"} already
 * rejects a non-NFC identifier ahead of this check, so every text this module ever sees is
 * already NFC.
 *
 * **All three properties this needs beyond `General_Category`** (`Joining_Type`,
 * `Canonical_Combining_Class`, `Indic_Syllabic_Category=Vowel_Dependent`) are carried in
 * {@link "./uts39.js"}, extracted verbatim from the pinned Java reference implementation, because
 * none of the three has an ECMAScript `\p{...}` property escape.
 *
 * **A1 and the two conjunct rules are implemented together or not at all.** A1 alone admits
 * Persian and refuses Malayalam — the spec is explicit that an implementation MUST implement all
 * three conditions.
 */

const ZWNJ = 0x200c;
const ZWJ = 0x200d;

/**
 * The code point ending at UTF-16 index `index` — the counterpart to `String.prototype.codePointAt`
 * for walking backwards, which JavaScript does not provide natively. Operates on the identifier's
 * already-decoded text, the same UTF-16-indexed surface `java.lang.String.codePointBefore` walks
 * in the Java reference this mirrors; this is not the byte/column offset the lexer tracks from
 * source text, which stays code-point addressed throughout (see the root `CLAUDE.md`).
 */
function codePointBefore(text: string, index: number): number {
  const low = text.charCodeAt(index - 1);
  if (index >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) {
      return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
    }
  }
  return low;
}

/** UTF-16 code units a code point occupies — 2 for a supplementary-plane code point, else 1. */
function charCount(codePoint: number): number {
  return codePoint > 0xffff ? 2 : 1;
}

/**
 * `text.codePointAt(index)`, total rather than `number | undefined`. Every call site below only
 * ever calls this at an index a loop bound already proved is `< text.length`, where
 * `codePointAt` cannot return `undefined` — but the type does not know that, so this falls back
 * to a sentinel outside every property table this module consults (never a valid code point)
 * rather than asserting, the same reasoning `xid.ts`'s own `contains()` gives for staying total.
 */
function codePointAtIndex(text: string, index: number): number {
  return text.codePointAt(index) ?? -1;
}

/**
 * §3.1.1.1's script restriction over one matched sequence `text[from, to)`: one script, ignoring
 * Common and Inherited (Unknown is *not* ignored here, unlike {@link "./restriction-level.js"}'s
 * own script scan — a joining-control span containing an unassigned code point has nothing
 * coherent to be single-script about).
 */
function singleScriptSpan(text: string, from: number, to: number): boolean {
  let only: number | undefined;
  for (let i = from; i < to;) {
    const codePoint = codePointAtIndex(text, i);
    i += charCount(codePoint);
    const script = scriptOf(codePoint);
    if (script === SCRIPT_COMMON || script === SCRIPT_INHERITED) continue;
    if (only === undefined) {
      only = script;
    } else if (only !== script) {
      return false;
    }
  }
  return true;
}

/**
 * `Joining_Type=Transparent`: `ArabicShaping.txt`'s default rule (non-spacing mark, enclosing
 * mark, or format) with its explicit exceptions applied — an explicit value always wins over the
 * `General_Category` default.
 */
function isTransparent(codePoint: number): boolean {
  if (isExplicitlyTransparent(codePoint)) return true;
  if (isExplicitlyNotTransparent(codePoint)) return false;
  return isNonSpacingMark(codePoint) || isEnclosingMark(codePoint) || isFormatControl(codePoint);
}

/** `$M₁`: a non-spacing mark with a non-zero canonical combining class. */
function isCombiningMark(codePoint: number): boolean {
  return isNonSpacingMark(codePoint) && isNonzeroCombiningClass(codePoint);
}

/** A1: `/$LJ $T* ZWNJ $T* $RJ/` — `index` addresses the ZWNJ. */
function breaksCursiveConnection(text: string, index: number): boolean {
  let left = index;
  while (left > 0) {
    const codePoint = codePointBefore(text, left);
    if (!isTransparent(codePoint)) break;
    left -= charCount(codePoint);
  }
  if (left === 0 || !isLeftJoining(codePointBefore(text, left))) return false;
  const start = left - charCount(codePointBefore(text, left));

  let right = index + 1;
  while (right < text.length) {
    const codePoint = codePointAtIndex(text, right);
    if (!isTransparent(codePoint)) break;
    right += charCount(codePoint);
  }
  if (right >= text.length || !isRightJoining(codePointAtIndex(text, right))) return false;

  return singleScriptSpan(text, start, right + charCount(codePointAtIndex(text, right)));
}

/** `$L $M*` ending at `end`: the index the `$L` starts at, or -1 when no such run precedes `end`. */
function letterRunStart(text: string, end: number): number {
  let at = end;
  while (at > 0) {
    const codePoint = codePointBefore(text, at);
    const before = at - charCount(codePoint);
    if (isLetter(codePoint)) return before;
    if (!isNonSpacingMark(codePoint)) return -1;
    at = before;
  }
  return -1;
}

/** A2's trailing `$M₁* $L`, or B's negative lookahead "not followed by `$D`". */
function followsConjunctRule(text: string, index: number, requireLetterAfter: boolean): boolean {
  let at = index + 1;
  if (!requireLetterAfter) {
    return at >= text.length || !isVowelDependent(codePointAtIndex(text, at));
  }
  while (at < text.length) {
    const codePoint = codePointAtIndex(text, at);
    if (!isCombiningMark(codePoint)) return isLetter(codePoint);
    at += charCount(codePoint);
  }
  return false;
}

/** Where the matched sequence ends, for the script check. */
function conjunctEnd(text: string, index: number, requireLetterAfter: boolean): number {
  let at = index + 1;
  if (!requireLetterAfter) return at;
  while (at < text.length) {
    const codePoint = codePointAtIndex(text, at);
    at += charCount(codePoint);
    if (!isCombiningMark(codePoint)) return at;
  }
  return text.length;
}

/**
 * A2 (`requireLetterAfter`) and B. Both share the left context `$L $M* $V $M₁*`; they differ
 * only in what must follow — A2 needs `$M₁* $L`, B needs anything that is not
 * `Indic_Syllabic_Category=Vowel_Dependent`.
 *
 * The backwards walk tries every split of the `$M₁*` run rather than taking the longest, because
 * `$V` is itself an `$M₁` (a Virama is `Mn` with a non-zero combining class): a greedy scan would
 * consume the very character it then has to find. This is what the regular expression's own
 * backtracking does.
 */
function inConjunct(text: string, index: number, requireLetterAfter: boolean): boolean {
  let at = index;
  while (at > 0) {
    const codePoint = codePointBefore(text, at);
    const before = at - charCount(codePoint);
    if (isVirama(codePoint)) {
      const start = letterRunStart(text, before);
      if (
        start >= 0 &&
        followsConjunctRule(text, index, requireLetterAfter) &&
        singleScriptSpan(text, start, conjunctEnd(text, index, requireLetterAfter))
      ) {
        return true;
      }
    }
    if (!isCombiningMark(codePoint)) return false;
    at = before;
  }
  return false;
}

/**
 * Whether the joining control at `index` (a UTF-16 index into `text`, addressing U+200C or
 * U+200D) sits in one of §3.1.1.1's three permitted contexts. `text` MUST already be NFC.
 *
 * Trivially `true` for any `index` that does not address a joining control at all — every caller
 * of this module scans for ZWNJ/ZWJ first and calls this only at those positions, but the
 * definition is total so a caller checking one position at a time need not special-case the rest.
 */
export function isJoiningControlPermitted(text: string, index: number): boolean {
  const codePoint = text.codePointAt(index);
  if (codePoint === ZWNJ) {
    return breaksCursiveConnection(text, index) || inConjunct(text, index, true);
  }
  return codePoint !== ZWJ || inConjunct(text, index, false);
}

/**
 * Whether every ZWNJ/ZWJ in `text` sits in one of UTS #39 §3.1.1.1's three permitted contexts —
 * [TSON-DATA] §7.7 rule 2, over the whole name. `text` MUST already be NFC (identifiers are NFC
 * by rule 1 of §7.7, checked ahead of this one — see {@link "./identifier-profile.js"}); a text
 * with no joining control at all trivially satisfies this without scanning any property table.
 */
export function joiningControlsSatisfied(text: string): boolean {
  for (let i = 0; i < text.length;) {
    const codePoint = codePointAtIndex(text, i);
    if ((codePoint === ZWNJ || codePoint === ZWJ) && !isJoiningControlPermitted(text, i)) {
      return false;
    }
    i += charCount(codePoint);
  }
  return true;
}
