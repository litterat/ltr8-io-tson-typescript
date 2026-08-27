/**
 * `Pattern_White_Space` (§7.2 rule 1): the eleven code points the lexer consumes between tokens
 * and never emits as one.
 *
 * UAX #31 guarantees `Pattern_White_Space` is immutable — membership never changes between
 * Unicode versions, unlike `XID_Start`/`XID_Continue`/`Nd` in {@link "./xid.js"}, which grow.
 * That is why this is a fixed, hand-written check rather than a generated table: there is
 * nothing for a table to encode that could ever go stale.
 */

/**
 * Whether `codePoint` has the `Pattern_White_Space` property (§7.2 rule 1).
 *
 * The set is exactly: U+0009 TAB, U+000A LF, U+000B VT, U+000C FF, U+000D CR, U+0020 SPACE,
 * U+0085 NEL, U+200E LRM, U+200F RLM, U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR.
 *
 * This governs token separation only. The line-terminator subset used for other lexical
 * purposes (closing a single-line quoted token, splitting a multi-line token into lines) is a
 * narrower, different set the lexer checks on its own — not every whitespace character ends a
 * line, and this function does not distinguish the two roles.
 */
export function isPatternWhiteSpace(codePoint: number): boolean {
  switch (codePoint) {
    case 0x09: // CHARACTER TABULATION
    case 0x0a: // LINE FEED
    case 0x0b: // LINE TABULATION
    case 0x0c: // FORM FEED
    case 0x0d: // CARRIAGE RETURN
    case 0x20: // SPACE
    case 0x85: // NEXT LINE
    case 0x200e: // LEFT-TO-RIGHT MARK
    case 0x200f: // RIGHT-TO-LEFT MARK
    case 0x2028: // LINE SEPARATOR
    case 0x2029: // PARAGRAPH SEPARATOR
      return true;
    default:
      return false;
  }
}
