import { isNd, isXidContinue, isXidStart } from './xid.js';

/**
 * The unquoted-token profile (§7.1): TSON's declared profile of Unicode identifiers per UAX #31
 * requirement R1.
 *
 * ```
 * Start    = XID_Start ∪ Nd ∪ { - + . }
 * Continue = XID_Continue ∪ { - + . }
 * ```
 *
 * (`Nd` is not repeated in `Continue` because every `Nd` code point is already `XID_Continue`.)
 * This lives beside the identifier tables it composes rather than in the lexer, since it is a
 * pure Unicode-property question with nothing lexer-specific about it — no lookahead, no token
 * boundaries, just "may this code point occupy this position of an unquoted token".
 *
 * The three extension characters `-`, `+`, `.` are all `Pattern_White_Space`'s sibling property
 * `Pattern_Syntax` and therefore immutable, so the profile is frozen exactly here: the
 * property-based components (`XID_Start`, `XID_Continue`, `Nd`) grow as new Unicode versions add
 * scripts and digits, but nothing is ever added to or removed from the three-character extension.
 *
 * These two functions answer the profile-membership question only. They say nothing about the
 * lexer's own claims on a lone `-`, `+`, or `.` occurrence (the compound-token lookahead of
 * §7.2.4, which routes a bare `.` to the range token `..` or a lexer error, and a bare `-`/`+`
 * to their own special-token roles outside this profile) — a token that begins or continues with
 * one of the three is a lexer concern one layer up from here, not a profile question this module
 * can settle.
 *
 * **No character is subtracted from the property union.** §7.1 states the profile as exactly the
 * formula above, with no exceptions: every `Cf` format character and every control character is
 * already absent, because none of them is `XID_Start`, `Nd`, or `XID_Continue` — that exclusion
 * needs no code here, only the property tables already do the work, and adding a guard for it
 * would be redundant. The two format controls ZWNJ (U+200C) and ZWJ (U+200D) are the deliberate
 * exception to that absence: both **are** `XID_Continue` — UAX #31 made them default identifier
 * characters when it withdrew its former contextual requirement, relocating the safety rule to
 * UTS #39 — and the profile admits them on that basis, unlike earlier revisions which subtracted
 * them here. What constrains a joiner is not this profile but a *name* rule: the identifier
 * grammar's contextual rule at naming positions (§7.7 rule 2, UTS #39 §3.1.1.1's contexts A1, A2,
 * B), applied above this module — a joining control is ordinary token content everywhere, and
 * whether it may stand in a *name* is a question this module does not answer. `identifier-profile.ts`
 * implements the rest of §7.7 and documents exactly where rule 2 composes on top.
 *
 * Because {@link isXidStart}/{@link isXidContinue} are the real `XID_Start`/`XID_Continue` tables
 * rather than the Java reference implementation's `Character.isUnicodeIdentifierStart`/`Part`
 * approximation, this profile and the Java's disagree — but in the opposite direction to what one
 * might assume, and not on `$`. `Character.isUnicodeIdentifierStart(0x24)` and
 * `isUnicodeIdentifierPart(0x24)` are both `false`: `$` is `Sc`, and the Java rejects it exactly as
 * this profile does.
 *
 * The real divergence is that `isUnicodeIdentifierPart` admits every *identifier-ignorable*
 * character, so the Java accepts U+00AD, U+2060, U+FEFF and the non-whitespace ISO controls
 * (U+0000, U+0008, U+007F) inside an unquoted token, where this profile rejects all of them.
 * U+FEFF is the case worth reporting upstream: §7.1 says a byte-order mark is not a character of
 * the token, so here the port is right and the reference is wrong.
 */

const HYPHEN_MINUS = 0x2d;
const PLUS_SIGN = 0x2b;
const FULL_STOP = 0x2e;

function isExtensionCharacter(codePoint: number): boolean {
  return codePoint === HYPHEN_MINUS || codePoint === PLUS_SIGN || codePoint === FULL_STOP;
}

/** Whether `codePoint` may start an unquoted token: `XID_Start ∪ Nd ∪ { - + . }` (§7.1). */
export function isUnquotedTokenStart(codePoint: number): boolean {
  return isXidStart(codePoint) || isNd(codePoint) || isExtensionCharacter(codePoint);
}

/** Whether `codePoint` may continue an unquoted token: `XID_Continue ∪ { - + . }` (§7.1). */
export function isUnquotedTokenContinue(codePoint: number): boolean {
  return isXidContinue(codePoint) || isExtensionCharacter(codePoint);
}
