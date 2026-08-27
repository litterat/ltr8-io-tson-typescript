import { describe, expect, it } from 'vitest';
import { isNfc, isUnquotedTokenNfc } from '../src/unicode/nfc.js';

// §7.2.1: "Unquoted tokens MUST be in Unicode Normalization Form C (NFC) in the source text: an
// unquoted token that is not NFC-normalized is a lexer error."
//
// Composed and decomposed variants below are spelled with \uXXXX escapes throughout, never as
// literal glyphs: a precomposed and a decomposed rendering of the same text are visually
// indistinguishable in an editor, which is precisely the distinction these tests exist to pin,
// so writing them as literal characters would hide the one thing that makes the test meaningful.

const CAFE_PRECOMPOSED = 'café'; // "café", é is the single precomposed code point
const CAFE_DECOMPOSED = 'café'; // "café", "e" + COMBINING ACUTE ACCENT
const OHM_SIGN = 'Ω'; // OHM SIGN -- canonically equivalent to U+03A9 GREEK CAPITAL OMEGA
const MICRO_SIGN = 'µ'; // MICRO SIGN -- compatibility-, not canonically, equivalent to mu

describe('isNfc (§7.2.1)', () => {
  it('accepts an empty string', () => {
    expect(isNfc('')).toBe(true);
  });

  it('accepts a plain ASCII identifier', () => {
    // The common case, and the one the fast path exists for: no code point reaches U+0300, so
    // this is decided without ever calling `String.prototype.normalize`.
    expect(isNfc('my_type-2')).toBe(true);
  });

  it('accepts a precomposed character', () => {
    expect(isNfc(CAFE_PRECOMPOSED)).toBe(true);
  });

  it('rejects the decomposed form of the same text', () => {
    expect(isNfc(CAFE_DECOMPOSED)).toBe(false);
  });

  it('rejects a canonical singleton that NFC replaces', () => {
    // U+2126 OHM SIGN has a canonical (not merely compatibility) equivalence to U+03A9, so NFC
    // of the ohm sign alone is a different string. This also exercises the guard's threshold:
    // 0x2126 is well above U+0300, so this can only pass by actually calling `normalize` and
    // comparing -- proving the case above (a plain ASCII identifier) is not passing by accident.
    expect(isNfc(OHM_SIGN)).toBe(false);
  });

  it('accepts a compatibility singleton NFC leaves alone', () => {
    // MICRO SIGN normalizes to GREEK SMALL LETTER MU only under NFKC, not NFC -- NFC has no
    // canonical decomposition for it, so "every singleton normalizes away" would be the wrong
    // generalization from the OHM SIGN case above.
    expect(isNfc(MICRO_SIGN)).toBe(true);
  });
});

describe('isUnquotedTokenNfc (§7.2.1, the lexer-facing check)', () => {
  it('agrees with isNfc when given the text’s true maximum code point', () => {
    expect(isUnquotedTokenNfc('my_type-2', 0x79 /* max code point, "y" */)).toBe(true);
    expect(isUnquotedTokenNfc(CAFE_DECOMPOSED, 0x0301)).toBe(false);
    expect(isUnquotedTokenNfc(OHM_SIGN, 0x2126)).toBe(false);
  });

  it('trusts the caller-supplied maximum below the guard threshold', () => {
    // Documented contract: a maxCodePoint below U+0300 short-circuits to `true` without
    // inspecting `text` at all. Passing a maximum lower than the text's real one is a caller
    // error (the lexer always has the true running maximum in hand, so this cannot happen in
    // practice) -- asserted here because it is exactly what makes the ASCII fast path branch-free
    // rather than a second, redundant scan of `text`.
    expect(isUnquotedTokenNfc(CAFE_DECOMPOSED, 0x00ff)).toBe(true);
  });
});
