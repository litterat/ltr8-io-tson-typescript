import { describe, expect, it } from 'vitest';
import {
  CATEGORY_NAMES,
  UNICODE_VERSION,
  isCategoryName,
  isInCategory,
} from '../src/regex/categories.js';

const hostUnicodeVersion: string | undefined = (
  globalThis as { process?: { versions?: { unicode?: string } } }
).process?.versions?.unicode;

const describeIfHostMatches = hostUnicodeVersion === UNICODE_VERSION ? describe : describe.skip;

const MAX_CODE_POINT = 0x10ffff;

function isSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdfff;
}

/** The one-letter categories and the two-letter categories each is the union of. */
const GROUPS: Readonly<Record<string, readonly string[]>> = {
  L: ['Lu', 'Ll', 'Lt', 'Lm', 'Lo'],
  M: ['Mn', 'Mc', 'Me'],
  N: ['Nd', 'Nl', 'No'],
  P: ['Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po'],
  Z: ['Zs', 'Zl', 'Zp'],
  S: ['Sm', 'Sc', 'Sk', 'So'],
  C: ['Cc', 'Cf', 'Cn', 'Co'],
};

describe('I-Regexp general categories', () => {
  it('recognises exactly the 36 categories RFC 9485 admits', () => {
    // The reference implementation's RegexCategory enumerates these and no others. A parser that
    // accepted more would accept schemas this port cannot round-trip.
    expect(CATEGORY_NAMES).toHaveLength(36);
    expect([...CATEGORY_NAMES].sort()).toEqual(
      [...Object.keys(GROUPS), ...Object.values(GROUPS).flat()].sort(),
    );
  });

  it('rejects names outside that set', () => {
    // Cs (surrogate) is a real Unicode category but is deliberately not one of the 36: lone
    // surrogates are not scalar values and cannot appear in a well-formed document.
    for (const name of ['Cs', 'Latin', 'Greek', 'Any', 'L*', '', 'lu', 'LU']) {
      expect(isCategoryName(name), name).toBe(false);
      expect(isInCategory(name, 0x41), name).toBe(false);
    }
  });

  it('places representative code points in the right category', () => {
    expect(isInCategory('Lu', 0x41)).toBe(true); // A
    expect(isInCategory('Ll', 0x61)).toBe(true); // a
    expect(isInCategory('Lt', 0x01c5)).toBe(true); // DŽ titlecase
    expect(isInCategory('Nd', 0x30)).toBe(true); // 0
    expect(isInCategory('Nl', 0x2160)).toBe(true); // Roman numeral one
    expect(isInCategory('Zs', 0x20)).toBe(true); // space
    expect(isInCategory('Cc', 0x09)).toBe(true); // tab
    expect(isInCategory('Sc', 0x24)).toBe(true); // dollar sign
    expect(isInCategory('Pd', 0x2d)).toBe(true); // hyphen-minus
    expect(isInCategory('Mn', 0x0301)).toBe(true); // combining acute
  });

  it('answers one-letter categories as the union of their members', () => {
    expect(isInCategory('L', 0x41)).toBe(true);
    expect(isInCategory('L', 0x30)).toBe(false); // a digit is N, not L
    expect(isInCategory('N', 0x30)).toBe(true);
    expect(isInCategory('N', 0x2160)).toBe(true); // Nl counts toward N
    expect(isInCategory('C', 0x09)).toBe(true); // Cc counts toward C
    expect(isInCategory('S', 0x24)).toBe(true); // Sc counts toward S
    expect(isInCategory('P', 0x2d)).toBe(true);
  });

  it('treats unassigned code points as Cn, and therefore as C', () => {
    // U+0378 is unassigned in every Unicode version this port has seen. An engine that answered
    // \p{C} from an assigned-characters table would miss the whole unassigned plane.
    expect(isInCategory('Cn', 0x0378)).toBe(true);
    expect(isInCategory('C', 0x0378)).toBe(true);
    expect(isInCategory('L', 0x0378)).toBe(false);
  });

  it('handles astral code points', () => {
    expect(isInCategory('Lo', 0x10400) || isInCategory('Lu', 0x10400)).toBe(true);
    expect(isInCategory('L', 0x10400)).toBe(true);
    expect(isInCategory('So', 0x1f600)).toBe(true); // emoji is So
  });

  it('returns false outside the Unicode range', () => {
    expect(isInCategory('L', MAX_CODE_POINT + 1)).toBe(false);
    expect(isInCategory('C', -1)).toBe(false);
  });
});

describeIfHostMatches(`categories cross-checked against host Unicode ${UNICODE_VERSION}`, () => {
  // Runs only when the host's Unicode version matches the tables'. A mismatch is a real condition,
  // not a failure — Node builds of the same age ship different versions.

  it.each(Object.values(GROUPS).flat())('%s matches the host exactly', (category) => {
    const test = new RegExp(`^\\p{General_Category=${category}}$`, 'u');
    const mismatches: number[] = [];
    for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
      if (isSurrogate(cp)) continue;
      if (isInCategory(category, cp) !== test.test(String.fromCodePoint(cp))) mismatches.push(cp);
    }
    expect(mismatches.slice(0, 8)).toEqual([]);
  });

  it.each(Object.keys(GROUPS))('%s matches the host exactly, though it is derived', (category) => {
    const test = new RegExp(`^\\p{General_Category=${category}}$`, 'u');
    const mismatches: number[] = [];
    for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
      if (isSurrogate(cp)) continue;
      if (isInCategory(category, cp) !== test.test(String.fromCodePoint(cp))) mismatches.push(cp);
    }
    expect(mismatches.slice(0, 8)).toEqual([]);
  });

  it('partitions the whole code space exactly once across the two-letter categories', () => {
    // Every scalar value has exactly one general category. A code point in none of them would
    // make \P{...} wrong for it; one in two would make the tables internally inconsistent.
    const leaves = Object.values(GROUPS).flat();
    const wrong: { cp: number; count: number }[] = [];
    for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
      if (isSurrogate(cp)) continue;
      let count = 0;
      for (const leaf of leaves) if (isInCategory(leaf, cp)) count++;
      if (count !== 1) wrong.push({ cp, count });
      if (wrong.length >= 8) break;
    }
    expect(wrong).toEqual([]);
  });
});
