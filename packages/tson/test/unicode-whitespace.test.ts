import { describe, expect, it } from 'vitest';
import { isPatternWhiteSpace } from '../src/unicode/whitespace.js';

// §7.2 rule 1: "Characters with the Pattern_White_Space property are consumed and not emitted
// as tokens. The set is immutable: U+0009 (TAB), U+000A (LF), U+000B (VT), U+000C (FF), U+000D
// (CR), U+0020 (SPACE), U+0085 (NEL), U+200E (LRM), U+200F (RLM), U+2028 (LINE SEPARATOR),
// U+2029 (PARAGRAPH SEPARATOR)."

describe('isPatternWhiteSpace (§7.2 rule 1)', () => {
  it('accepts exactly the eleven Pattern_White_Space code points', () => {
    const members = [
      0x09, // TAB
      0x0a, // LF
      0x0b, // VT
      0x0c, // FF
      0x0d, // CR
      0x20, // SPACE
      0x85, // NEL
      0x200e, // LRM
      0x200f, // RLM
      0x2028, // LINE SEPARATOR
      0x2029, // PARAGRAPH SEPARATOR
    ];
    expect(members).toHaveLength(11);
    for (const cp of members) {
      expect(isPatternWhiteSpace(cp)).toBe(true);
    }
  });

  it('rejects ordinary token characters', () => {
    for (const cp of [0x61 /* a */, 0x30 /* 0 */, 0x5f /* _ */, 0x2c /* , */, 0x7b /* { */]) {
      expect(isPatternWhiteSpace(cp)).toBe(false);
    }
  });

  it('rejects Unicode space characters that are not Pattern_White_Space', () => {
    // NBSP and IDEOGRAPHIC SPACE are Zs (space separator) but not Pattern_White_Space — UAX #31
    // deliberately keeps the pattern set small and immutable, unlike the broader White_Space
    // property. A generator that reached for `\s`/White_Space instead of this fixed list would
    // wrongly swallow these as separators.
    expect(isPatternWhiteSpace(0x00a0)).toBe(false); // NO-BREAK SPACE
    expect(isPatternWhiteSpace(0x3000)).toBe(false); // IDEOGRAPHIC SPACE
    expect(isPatternWhiteSpace(0x2007)).toBe(false); // FIGURE SPACE
  });

  it('rejects the byte order mark', () => {
    // §7.1: "U+FEFF anywhere else outside a quoted token is an unrecognised character and a
    // lexer error" — it is explicitly not whitespace, even though a BOM at the very start of a
    // document is discarded before lexing begins.
    expect(isPatternWhiteSpace(0xfeff)).toBe(false);
  });

  it('rejects code points outside the Unicode range and below zero', () => {
    expect(isPatternWhiteSpace(0x110000)).toBe(false);
    expect(isPatternWhiteSpace(-1)).toBe(false);
  });
});
