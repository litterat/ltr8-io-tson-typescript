import { describe, expect, it } from 'vitest';
import {
  applyNormalization,
  asciiLowercase,
  describeToken,
  holdsNormalization,
  nfkcCasefold,
} from '../../src/unicode/normalization.js';
import {
  compatibilityDecompositionOf,
  NORMALIZATION_UNICODE_VERSION,
  nfkcCasefoldOf,
} from '../../src/unicode/normalization-tables.js';

// [TSON-SCHEMA] §5.5: a text value is its token's text put into the type's `normalization` form.
// Built from code points where a literal would be unreviewable.

const KELVIN = 'K';
const FULL_WIDTH_C = 'Ｃ';
const SOFT_HYPHEN = '­';

describe('applyNormalization -- the five forms (§5.5)', () => {
  it('NONE keeps the text as written', () => {
    expect(applyNormalization('NONE', 'Café')).toBe('Café');
  });

  it('NFC puts the text into Normalization Form C', () => {
    expect(applyNormalization('NFC', 'café')).toBe('café');
  });

  it('NFKC folds compatibility variants to their ordinary forms, then composes', () => {
    expect(applyNormalization('NFKC', 'ﬁ')).toBe('fi');
    expect(applyNormalization('NFKC', FULL_WIDTH_C)).toBe('C');
    // A decomposed compatibility character is composed in the same step.
    expect(applyNormalization('NFKC', 'é①')).toBe('é1');
  });

  it('NFKC_CASEFOLD is NFKC, a full case fold, and the default ignorables removed', () => {
    expect(applyNormalization('NFKC_CASEFOLD', 'Content-Type')).toBe('content-type');
    expect(applyNormalization('NFKC_CASEFOLD', `${FULL_WIDTH_C}ontent-Type`)).toBe('content-type');
    expect(applyNormalization('NFKC_CASEFOLD', `${KELVIN}eep-Alive`)).toBe('keep-alive');
    expect(applyNormalization('NFKC_CASEFOLD', 'Straße')).toBe('strasse');
    expect(applyNormalization('NFKC_CASEFOLD', `a${SOFT_HYPHEN}b`)).toBe('ab');
    // U+0130 folds to `i` plus a combining dot, which NFC leaves decomposed.
    expect(applyNormalization('NFKC_CASEFOLD', 'İ')).toBe('i̇');
  });

  it('ASCII_CASEFOLD maps A-Z and nothing else (§5.5)', () => {
    expect(applyNormalization('ASCII_CASEFOLD', 'Content-Type')).toBe('content-type');
    // No Unicode normalization runs: a full-width or Kelvin-sign spelling stays distinct.
    expect(applyNormalization('ASCII_CASEFOLD', `${FULL_WIDTH_C}ontent-Type`)).toBe(
      `${FULL_WIDTH_C}ontent-type`,
    );
    expect(applyNormalization('ASCII_CASEFOLD', `${KELVIN}eep-Alive`)).toBe(`${KELVIN}eep-alive`);
    expect(asciiLowercase('ÀB')).toBe('Àb');
  });

  it('returns the same string when it already is in the form', () => {
    for (const form of ['NONE', 'NFC', 'NFKC', 'NFKC_CASEFOLD', 'ASCII_CASEFOLD'] as const) {
      expect(holdsNormalization(form, 'abc-123')).toBe(true);
    }
    expect(holdsNormalization('NFKC_CASEFOLD', 'Abc')).toBe(false);
    expect(holdsNormalization('ASCII_CASEFOLD', 'abc')).toBe(true);
  });

  it('judges a supplementary character as one code point, not two UTF-16 units', () => {
    // U+1D400 MATHEMATICAL BOLD CAPITAL A -> `a`
    expect(nfkcCasefold('\u{1d400}b')).toBe('ab');
  });
});

describe('describeToken -- how a refusal names a token (§5.5)', () => {
  it('names the written spelling alone when the form did not change it', () => {
    expect(describeToken('put', 'put', 'NFKC_CASEFOLD')).toBe("'put'");
  });

  it('names the written spelling and then the value it was read as when the form changed it', () => {
    expect(describeToken('PUT', 'put', 'NFKC_CASEFOLD')).toBe(
      "'PUT' (read as 'put' under NFKC_CASEFOLD)",
    );
  });
});

describe('the checked-in normalization tables', () => {
  it('record the Unicode version they were derived from', () => {
    expect(NORMALIZATION_UNICODE_VERSION).toMatch(/^\d+\.\d+$/);
  });

  it('name the Kelvin sign and a soft hyphen', () => {
    expect(nfkcCasefoldOf(0x212a)).toBe('k');
    expect(nfkcCasefoldOf(0xad)).toBe('');
    expect(nfkcCasefoldOf(0x61)).toBeUndefined();
    expect(compatibilityDecompositionOf(0xfb01)).toBe('fi');
    expect(compatibilityDecompositionOf(0xe9)).toBeUndefined();
  });

  // The tables are authoritative and the host is not consulted at runtime; this checks them
  // against the host only when the host carries the same Unicode version, as
  // `npm run check:unicode` does.
  it.runIf(process.versions.unicode === NORMALIZATION_UNICODE_VERSION)(
    "agree with the host's own NFKC over every non-surrogate code point (same Unicode version)",
    () => {
      const disagreements: number[] = [];
      for (let cp = 0; cp <= 0x10ffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const text = String.fromCodePoint(cp);
        if (applyNormalization('NFKC', text) !== text.normalize('NFKC')) disagreements.push(cp);
      }
      expect(disagreements).toEqual([]);
    },
  );
});
