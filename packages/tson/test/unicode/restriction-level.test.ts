import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESTRICTION_LEVEL,
  DEFAULT_RESTRICTION_UNIT,
  satisfiesRestrictionLevel,
} from '../../src/unicode/restriction-level.js';

// UTS #39 §5.2's restriction levels and [TSON-DATA] §8.2's unit refinement — two independent
// axes. Mixed-script names are built from code points, never typed: the whole subject is
// spellings that look alike, so a literal would be unreviewable. Mirrors the pinned Java
// reference's own `TsonUnicodePolicyTest`.

const CYR_A = String.fromCodePoint(0x0430); // а
const CYR_P = String.fromCodePoint(0x043f); // п
const GREEK_ALPHA = String.fromCodePoint(0x03b1);
const HAN = String.fromCodePoint(0x65e5); // 日
const DEVANAGARI = String.fromCodePoint(0x0905);

describe('satisfiesRestrictionLevel (UTS #39 §5.2)', () => {
  it('defaults to Highly Restrictive over the whole name (§8.2 RECOMMENDED)', () => {
    expect(DEFAULT_RESTRICTION_LEVEL).toBe('HIGHLY_RESTRICTIVE');
    expect(DEFAULT_RESTRICTION_UNIT).toBe('WHOLE_NAME');

    expect(satisfiesRestrictionLevel('admin')).toBe(true);
    expect(satisfiesRestrictionLevel('пользователь')).toBe(true); // single-script Cyrillic
    expect(satisfiesRestrictionLevel(HAN + HAN + 'id')).toBe(true); // Latin + Han, the Jpan set
    expect(satisfiesRestrictionLevel(CYR_A + 'dmin')).toBe(false); // the homograph
    expect(satisfiesRestrictionLevel('id_' + CYR_P)).toBe(false); // an ordinary compound
    expect(satisfiesRestrictionLevel('alpha_' + GREEK_ALPHA)).toBe(false);
  });

  it('PER_SEGMENT keeps every homograph refusal and admits the compounds', () => {
    const level = 'HIGHLY_RESTRICTIVE';
    expect(satisfiesRestrictionLevel('id_' + CYR_P, level, 'PER_SEGMENT')).toBe(true);
    expect(satisfiesRestrictionLevel('alpha_' + GREEK_ALPHA, level, 'PER_SEGMENT')).toBe(true);
    expect(satisfiesRestrictionLevel(HAN + HAN + 'id', level, 'PER_SEGMENT')).toBe(true);
    expect(satisfiesRestrictionLevel(CYR_A + 'dmin', level, 'PER_SEGMENT')).toBe(false); // within one word
    expect(satisfiesRestrictionLevel('id_' + CYR_A + 'dmin', level, 'PER_SEGMENT')).toBe(false); // one bad segment
  });

  it('Moderately Restrictive admits Latin plus one other script, except Cyrillic and Greek', () => {
    const level = 'MODERATELY_RESTRICTIVE';
    expect(satisfiesRestrictionLevel('id_' + DEVANAGARI, level)).toBe(true);
    expect(satisfiesRestrictionLevel('id_' + CYR_P, level)).toBe(false);
    expect(satisfiesRestrictionLevel('alpha_' + GREEK_ALPHA, level)).toBe(false);
  });

  it('Single Script refuses even the augmented sets Highly Restrictive admits', () => {
    expect(satisfiesRestrictionLevel('admin', 'SINGLE_SCRIPT')).toBe(true);
    expect(satisfiesRestrictionLevel(HAN + HAN + 'id', 'SINGLE_SCRIPT')).toBe(false);
  });

  it('ASCII Only is exactly what it says', () => {
    expect(satisfiesRestrictionLevel('order_id', 'ASCII_ONLY')).toBe(true);
    expect(satisfiesRestrictionLevel('café', 'ASCII_ONLY')).toBe(false);
  });

  it('the two loosest levels both stop checking scripts, and only Unrestricted is a level 6', () => {
    expect(satisfiesRestrictionLevel(CYR_A + 'dmin', 'MINIMALLY_RESTRICTIVE')).toBe(true);
    expect(satisfiesRestrictionLevel(CYR_A + 'dmin', 'UNRESTRICTED')).toBe(true);
  });

  it('accepts empty text at every level', () => {
    for (const level of [
      'ASCII_ONLY',
      'SINGLE_SCRIPT',
      'HIGHLY_RESTRICTIVE',
      'MODERATELY_RESTRICTIVE',
      'MINIMALLY_RESTRICTIVE',
      'UNRESTRICTED',
    ] as const) {
      expect(satisfiesRestrictionLevel('', level)).toBe(true);
    }
  });

  it('ignores a leading, trailing, or doubled separator under PER_SEGMENT', () => {
    const level = 'HIGHLY_RESTRICTIVE';
    expect(satisfiesRestrictionLevel('_leading', level, 'PER_SEGMENT')).toBe(true);
    expect(satisfiesRestrictionLevel('trailing_', level, 'PER_SEGMENT')).toBe(true);
    expect(satisfiesRestrictionLevel('a__b', level, 'PER_SEGMENT')).toBe(true);
  });
});
