/**
 * Unicode Normalization Form C checks for unquoted-token text (§7.2.1).
 *
 * Unquoted tokens MUST be NFC in the source text — an unquoted token that is not NFC-normalized
 * is a lexer error — while quoted tokens are exempt and preserve their exact content (§7.2.1).
 * This module only answers the NFC question; raising the lexer error from a `false` result is
 * the lexer's job, not this one's.
 *
 * `String.prototype.normalize` is ECMA-262, not `Intl` — present in small-icu Node builds and
 * every browser, so it needs no separate Unicode data of its own, unlike the tables in
 * {@link "./xid.js"}. It does, though, allocate a new string on every call. Both functions here
 * take a fast path around that: a token whose highest code point is below U+0300 (the start of
 * the Combining Diacritical Marks block) contains no combining mark and cannot be affected by
 * canonical composition or decomposition, so it is NFC by construction — checked before
 * `normalize` ever runs. Almost every unquoted token in almost every real document is a plain
 * ASCII identifier, which is exactly this case.
 */

/** The first code point NFC normalization can change: below it, every code point is already its own NFC form. */
const COMBINING_MARK_THRESHOLD = 0x0300;

/**
 * Whether `text` is already NFC-normalized.
 *
 * Scans `text`'s code points to find the maximum, then defers to {@link isUnquotedTokenNfc} for
 * the actual decision. The scan itself never allocates; `isUnquotedTokenNfc` allocates a
 * normalized copy of `text` to compare against, but only when the scan finds a code point at or
 * above U+0300.
 *
 * A caller that already knows the token's maximum code point — the lexer, which decodes every
 * code point of the token as it scans and can track the running maximum for free — should call
 * {@link isUnquotedTokenNfc} directly and skip the scan this function repeats.
 */
export function isNfc(text: string): boolean {
  let maxCodePoint = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    // `character` comes from iterating `text`, so it is always a well-formed single code point;
    // `codePointAt(0)` on a non-empty string is never `undefined`. The guard keeps this total
    // rather than asserting, which is what lets the type stay `number` without a cast.
    if (codePoint !== undefined && codePoint > maxCodePoint) maxCodePoint = codePoint;
  }
  return isUnquotedTokenNfc(text, maxCodePoint);
}

/**
 * The check the lexer performs at the end of an unquoted token (§7.2.1): whether `text` — the
 * token's content — is NFC, given `maxCodePoint`, the highest code point already seen while
 * scanning it.
 *
 * Allocates a normalized copy of `text` to compare against, but only when `maxCodePoint` is at
 * or above U+0300: below that threshold every code point is already its own NFC form, so a
 * token built entirely from them — every ASCII identifier included — is decided as NFC without
 * the allocating call ever running. Passing a `maxCodePoint` lower than `text`'s true maximum
 * is a caller error that can make a non-NFC token pass; passing one higher only costs an
 * unnecessary `normalize` call; passing `text`'s exact maximum, which is what a code-point-at-a-
 * time scanner already has in hand, costs nothing extra either way.
 */
export function isUnquotedTokenNfc(text: string, maxCodePoint: number): boolean {
  if (maxCodePoint < COMBINING_MARK_THRESHOLD) return true;
  return text.normalize('NFC') === text;
}
