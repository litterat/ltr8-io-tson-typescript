import { describe, expect, it } from 'vitest';
import {
  isJoiningControlPermitted,
  joiningControlsSatisfied,
} from '../../src/unicode/joining-controls.js';

// UTS #39 §3.1.1.1's three contexts, as an identifier rule ([TSON-DATA] §7.7 rule 2). Every
// string here is built from code points, never typed: a joiner is invisible, so a literal would
// be unreviewable and one careless paste away from testing nothing. Names say which script and
// which of §3.1.1.1's clauses each case exercises — mirrored from the pinned Java reference's own
// `JoiningControlsTest`, whose cases are what pin the interesting inputs. Every input here is
// already NFC (a bare precondition {@link "../../src/unicode/joining-controls.js"} documents),
// which every code point below is on its own.

const ZWNJ = String.fromCodePoint(0x200c);
const ZWJ = String.fromCodePoint(0x200d);

function cps(...points: number[]): string {
  return String.fromCodePoint(...points);
}

describe('joiningControlsSatisfied (UTS #39 §3.1.1.1)', () => {
  describe('A1: ZWNJ breaking a cursive connection', () => {
    it('admits the Persian compound where the joiner breaks a cursive connection', () => {
      // کتاب‌ها ("books"): ZWNJ between HEH (dual-joining) and ALEF (right-joining) is ordinary
      // spelling, not decoration — the word is misspelled without it.
      const books = cps(0x0643, 0x062a, 0x0627, 0x0628) + ZWNJ + cps(0x0647, 0x0627);
      expect(joiningControlsSatisfied(books)).toBe(true);
    });

    it('admits a dual-joining pair around the joiner — A1s core shape', () => {
      const word = cps(0x0628) + ZWNJ + cps(0x0628);
      expect(joiningControlsSatisfied(word)).toBe(true);
    });

    it('refuses the Latin homograph attack', () => {
      // Latin has no cursive joining, so ad<ZWNJ>min matches no context and renders as "admin".
      const spoof = 'ad' + ZWNJ + 'min';
      expect(joiningControlsSatisfied(spoof)).toBe(false);
    });

    it('refuses a trailing joiner — there is no right context at all', () => {
      expect(joiningControlsSatisfied(cps(0x0628) + ZWNJ)).toBe(false);
    });

    it('refuses a joiner whose matched context spans two scripts', () => {
      // Arabic BEH (dual-joining) on the left, Syriac BETH (dual-joining) on the right: the
      // joining types line up, but the script restriction does not hold.
      const mixed = cps(0x0628) + ZWNJ + cps(0x0712);
      expect(joiningControlsSatisfied(mixed)).toBe(false);
    });
  });

  describe('A2 / B: the conjunct contexts', () => {
    it("admits the Malayalam conjunct from the spec's own Figure 2 example", () => {
      const eyewitness =
        cps(0x0d26, 0x0d43, 0x0d15, 0x0d4d) +
        ZWNJ +
        cps(0x0d38, 0x0d3e, 0x0d15, 0x0d4d, 0x0d37, 0x0d3f);
      expect(joiningControlsSatisfied(eyewitness)).toBe(true);
    });

    it('admits a Devanagari conjunct — the same clause in a second script', () => {
      const word = cps(0x0915, 0x094d) + ZWNJ + cps(0x0915);
      expect(joiningControlsSatisfied(word)).toBe(true);
    });

    it('admits a ZWJ in a conjunct context (B) — Sinhala, Figure 3', () => {
      const word = cps(0x0dc1, 0x0dca) + ZWJ + cps(0x0dbb);
      expect(joiningControlsSatisfied(word)).toBe(true);
    });

    it('refuses a joiner with no Virama before it, in any script', () => {
      const word = cps(0x0915) + ZWNJ + cps(0x0915);
      expect(joiningControlsSatisfied(word)).toBe(false);
    });

    it("refuses a ZWJ followed by a dependent vowel — B's negative lookahead", () => {
      const word = cps(0x0915, 0x094d) + ZWJ + cps(0x093e);
      expect(joiningControlsSatisfied(word)).toBe(false);
    });

    it('does not let ZWJ inherit the cursive-break context (A1 is ZWNJ-only)', () => {
      const word = cps(0x0628) + ZWJ + cps(0x0628);
      expect(joiningControlsSatisfied(word)).toBe(false);
    });
  });

  it('leaves an ordinary name with no joining control untouched', () => {
    expect(joiningControlsSatisfied('order_line')).toBe(true);
    expect(joiningControlsSatisfied('')).toBe(true);
  });

  it('agrees with isJoiningControlPermitted at each joiner it scans', () => {
    const spoof = 'ad' + ZWNJ + 'min';
    expect(isJoiningControlPermitted(spoof, 2)).toBe(false);
    expect(joiningControlsSatisfied(spoof)).toBe(false);

    const books = cps(0x0643, 0x062a, 0x0627, 0x0628) + ZWNJ + cps(0x0647, 0x0627);
    expect(isJoiningControlPermitted(books, 4)).toBe(true);
    expect(joiningControlsSatisfied(books)).toBe(true);
  });
});
