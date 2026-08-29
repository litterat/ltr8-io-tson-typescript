/**
 * `Pattern_White_Space` (§7.2 rule 1): the eleven code points the lexer consumes between tokens.
 *
 * UAX #31 guarantees `Pattern_White_Space` is immutable — membership never changes between
 * Unicode versions, unlike `XID_Start`/`XID_Continue`/`Nd` in {@link "./xid.js"}, which grow.
 * That is why this is a fixed, hand-written check rather than a generated table: there is
 * nothing for a table to encode that could ever go stale.
 *
 * §7.2 rule 1 — following UAX #31 requirement R3a-1 — divides the eleven members into three
 * groups with three different treatments, matching the grammar's three productions:
 *
 * ```
 * horizontal-space = SP / HTAB
 * ws-line-term     = line-term / VT / FF
 * ignorable-format = LRM / RLM
 * ```
 *
 * `line-term` itself (LF, CR, NEL, LS, PS) is the narrower five-member set the quoted-token
 * grammar recognises on its own — the lexer's line-terminator handling elsewhere in this package
 * checks that set directly, not `isWsLineTerm`, since VT/FF join the *whitespace* production only
 * and are never valid inside a single-line token or a multi-line token's line-splitting.
 *
 * The first two groups are ordinary token separators. The third — LRM (U+200E) and RLM (U+200F),
 * the two `Pattern_White_Space` members carrying `Default_Ignorable_Code_Point` — are bidirectional
 * marks, not visual whitespace: they are consumed and contribute nothing, admitted only where a
 * token boundary already exists (adjacent to horizontal space or a line terminator, at the start
 * or end of a line, or between two tokens a structural or special token already separates). A run
 * of them standing where the surrounding characters would otherwise continue one unquoted token is
 * a lexer error — that adjacency check is the lexer's own job (`lexer/lexer.ts`), not this
 * module's; this module answers only "which group is this code point in".
 */

const TAB = 0x09;
const LF = 0x0a;
const VT = 0x0b;
const FF = 0x0c;
const CR = 0x0d;
const SPACE = 0x20;
const NEL = 0x85;
const LRM = 0x200e;
const RLM = 0x200f;
const LS = 0x2028;
const PS = 0x2029;

/** `horizontal-space = SP / HTAB` (§7.4): an ordinary separator, never a line boundary. */
export function isHorizontalSpace(codePoint: number): boolean {
  return codePoint === SPACE || codePoint === TAB;
}

/**
 * `ws-line-term = line-term / VT / FF` (§7.4): every code point that ends a line for whitespace
 * purposes — the five `line-term` members (LF, CR, NEL, LS, PS) plus VT and FF, which end a line
 * here but are not part of the narrower `line-term` set the quoted-token grammar uses.
 */
export function isWsLineTerm(codePoint: number): boolean {
  switch (codePoint) {
    case LF:
    case VT:
    case FF:
    case CR:
    case NEL:
    case LS:
    case PS:
      return true;
    default:
      return false;
  }
}

/**
 * `ignorable-format = LRM / RLM` (§7.4): the two ignorable format controls (§7.2 rule 1) — bidi
 * marks admitted only where a token boundary already exists. Membership only; the lexer decides
 * whether a given occurrence stands at a legal boundary.
 */
export function isIgnorableFormat(codePoint: number): boolean {
  return codePoint === LRM || codePoint === RLM;
}

/**
 * Whether `codePoint` has the `Pattern_White_Space` property (§7.2 rule 1): the union of
 * {@link isHorizontalSpace}, {@link isWsLineTerm}, and {@link isIgnorableFormat}.
 *
 * This governs token separation only, and does not by itself distinguish an ignorable format
 * control's stricter boundary requirement from the other two groups' unconditional one — a caller
 * that must enforce that distinction (the lexer's own whitespace scan) uses the three grouped
 * predicates above instead.
 */
export function isPatternWhiteSpace(codePoint: number): boolean {
  return isHorizontalSpace(codePoint) || isWsLineTerm(codePoint) || isIgnorableFormat(codePoint);
}
