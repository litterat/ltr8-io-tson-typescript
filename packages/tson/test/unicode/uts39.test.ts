import { describe, expect, it } from 'vitest';
import {
  identifierStatusAllowed,
  scriptOf,
  SCRIPT_CYRILLIC,
  SCRIPT_GREEK,
  SCRIPT_HAN,
  SCRIPT_HANGUL,
  SCRIPT_HIRAGANA,
  SCRIPT_INHERITED,
  SCRIPT_KATAKANA,
  SCRIPT_LATIN,
  UTS39_VERSION,
} from '../../src/unicode/uts39.js';

// UTS #39 §3.1's Identifier_Status ([TSON-DATA] §8.2 mechanism 2) and the Script partition
// {@link "../../src/unicode/restriction-level.js"} and joining-controls.ts build on.

describe('identifierStatusAllowed (UTS #39 §3.1)', () => {
  it('allows ordinary identifier characters across several scripts', () => {
    for (const cp of [
      0x61 /* a */, 0x7a /* z */, 0x41 /* A */, 0x5a /* Z */, 0x30 /* 0 */, 0x39 /* 9 */,
      0x5f /* _ */, 0x2d /* - */, 0x00e9 /* é */, 0x0430 /* а Cyrillic */, 0x03b1 /* α Greek */,
      0x4e00 /* 一 Han */, 0x0e01 /* Thai */, 0x0905 /* Devanagari */,
    ]) {
      expect(identifierStatusAllowed(cp), `U+${cp.toString(16)}`).toBe(true);
    }
  });

  it('includes both ends of every range — the boundary bug the reference test pins', () => {
    for (const cp of [
      0x41 /* A */, 0x5a /* Z */, 0x61 /* a */, 0x7a /* z */, 0x30 /* 0 */, 0x39 /* 9 */,
    ]) {
      expect(identifierStatusAllowed(cp), `U+${cp.toString(16)}`).toBe(true);
    }
    expect(identifierStatusAllowed(0x41 - 1), 'below A..Z is outside').toBe(false);
    expect(identifierStatusAllowed(0x5a + 1), 'above A..Z is outside').toBe(false);
  });

  it('restricts the joining controls — the profile needs no hand-picked exclusion for them', () => {
    expect(identifierStatusAllowed(0x200c)).toBe(false); // ZWNJ
    expect(identifierStatusAllowed(0x200d)).toBe(false); // ZWJ
  });

  it('restricts obsolete, technical and limited-use characters', () => {
    for (const cp of [0x07e8, 0xa610, 0x1b6b, 0x0740, 0x00ad, 0xfeff, 0x202e]) {
      expect(identifierStatusAllowed(cp), `U+${cp.toString(16)}`).toBe(false);
    }
  });

  it('reports a UTS #39 data version', () => {
    expect(UTS39_VERSION).toMatch(/^\d+\.\d+$/);
  });
});

describe('scriptOf (UAX #24 Script)', () => {
  it('identifies the named scripts restriction-level.ts and joining-controls.ts read', () => {
    expect(scriptOf(0x61)).toBe(SCRIPT_LATIN); // a
    expect(scriptOf(0x0430)).toBe(SCRIPT_CYRILLIC); // а
    expect(scriptOf(0x03b1)).toBe(SCRIPT_GREEK); // α
    expect(scriptOf(0x4e00)).toBe(SCRIPT_HAN); // 一
    expect(scriptOf(0x3042)).toBe(SCRIPT_HIRAGANA); // あ
    expect(scriptOf(0x30a2)).toBe(SCRIPT_KATAKANA); // ア
    expect(scriptOf(0xac00)).toBe(SCRIPT_HANGUL); // 가
  });

  it('treats combining marks as Inherited, distinct from every named script', () => {
    // U+0301 COMBINING ACUTE ACCENT is Script=Inherited: it takes on whichever script it
    // combines with rather than owning one — which is exactly why the restriction-level and
    // joining-control script scans both ignore it explicitly rather than treating it as a
    // script of its own.
    expect(scriptOf(0x0301)).toBe(SCRIPT_INHERITED);
  });

  it('is total over the whole scalar-value range, including an unassigned code point', () => {
    expect(() => scriptOf(0x10ffff)).not.toThrow();
    expect(() => scriptOf(0)).not.toThrow();
  });
});
