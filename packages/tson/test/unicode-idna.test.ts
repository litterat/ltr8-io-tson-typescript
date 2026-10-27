import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { punycodeDecode, punycodeEncode } from '../src/atom/network/punycode.js';
import { bidiViolation, hasRightToLeft } from '../src/unicode/bidi.js';
import { BIDI_UNICODE_VERSION } from '../src/unicode/bidi-tables.js';
import {
  idnaContextual,
  idnaProperty,
  IDNA_UNICODE_VERSION,
  isCombiningMark,
  isDecimalDigit,
  isUppercase,
  uLabelProblem,
  type IdnaProperty,
} from '../src/unicode/idna.js';

/** `مثال`, Arabic for "example". */
const ARABIC = 'مثال';
/** `שלום`, Hebrew. */
const HEBREW = 'שלום';

describe('Punycode (RFC 3492 §7.1 sample strings)', () => {
  const samples: readonly (readonly [string, string, string])[] = [
    ['Arabic (Egyptian)', 'ليهمابتكلموشعربي؟', 'egbpdaj6bu4bxfgehfvwxn'],
    ['Chinese (simplified)', '他们为什么不说中文', 'ihqwcrb4cv8a8dqg056pqjye'],
    ['3<nen>B<gumi><kinpachi><sensei>', '3年B組金八先生', '3B-ww4c5e180e575a65lsy2b'],
    ['all basic with a delimiter', '-> $1.00 <-', '-> $1.00 <--'],
    ['bücher', 'bücher', 'bcher-kva'],
  ];

  for (const [name, text, encoded] of samples) {
    it(`encodes and decodes ${name}`, () => {
      expect(punycodeEncode(text)).toBe(encoded);
      expect(punycodeDecode(encoded)).toBe(text);
    });
  }

  it('decodes to undefined where the input is not Punycode (RFC 3492 §6.4)', () => {
    expect(punycodeDecode('é-a')).toBeUndefined();
    expect(punycodeDecode('a!')).toBeUndefined();
    expect(punycodeDecode('99999999999')).toBeUndefined();
    expect(punycodeDecode('bcher-kv')).toBeUndefined();
  });

  it('encodes the empty string to the empty string', () => {
    expect(punycodeEncode('')).toBe('');
    expect(punycodeDecode('')).toBe('');
  });
});

describe('IDNA2008 derived property (RFC 5892 §3)', () => {
  const expected: readonly (readonly [string, number, IdnaProperty])[] = [
    ['a', 0x61, 'PVALID'],
    ['7', 0x37, 'PVALID'],
    ['hyphen', 0x2d, 'PVALID'],
    ['A (ASCII is LDH alone)', 0x41, 'DISALLOWED'],
    ['underscore', 0x5f, 'DISALLOWED'],
    ['full stop', 0x2e, 'DISALLOWED'],
    ['u with diaeresis', 0xfc, 'PVALID'],
    ['U with diaeresis (uppercase is unstable under the fold)', 0xdc, 'DISALLOWED'],
    ['fullwidth e (unstable under NFKC)', 0xff45, 'DISALLOWED'],
    ['sharp s (§2.6 exception)', 0xdf, 'PVALID'],
    ['final sigma (§2.6 exception)', 0x3c2, 'PVALID'],
    ['ideographic number zero (§2.6 exception)', 0x3007, 'PVALID'],
    ['tatweel (§2.6 exception)', 0x640, 'DISALLOWED'],
    ['middle dot (§2.6 exception)', 0xb7, 'CONTEXTO'],
    ['Arabic-Indic digit zero (§2.6 exception)', 0x660, 'CONTEXTO'],
    ['katakana middle dot (§2.6 exception)', 0x30fb, 'CONTEXTO'],
    ['ZWNJ', 0x200c, 'CONTEXTJ'],
    ['ZWJ', 0x200d, 'CONTEXTJ'],
    ['unassigned U+0378', 0x378, 'UNASSIGNED'],
    ['Roman numeral one (unstable)', 0x2160, 'DISALLOWED'],
    ['soft hyphen (default ignorable)', 0xad, 'DISALLOWED'],
    ['no-break space (white space)', 0xa0, 'DISALLOWED'],
    ['Hangul choseong kiyeok (old jamo)', 0x1100, 'DISALLOWED'],
    ['combining enclosing keycap (ignorable block)', 0x20e3, 'DISALLOWED'],
    ['noncharacter U+FFFF', 0xffff, 'DISALLOWED'],
    ['private use U+E000', 0xe000, 'DISALLOWED'],
    ['Toto letter, assigned in Unicode 14 and a letter', 0x1e290, 'PVALID'],
    [
      'Cyrillic modifier letter with a compatibility decomposition, Unicode 15',
      0x1e030,
      'DISALLOWED',
    ],
  ];

  for (const [name, codePoint, property] of expected) {
    it(`${name} is ${property}`, () => {
      expect(idnaProperty(codePoint)).toBe(property);
    });
  }

  it('records the Unicode version the table was derived from, the same as the Bidi table', () => {
    expect(IDNA_UNICODE_VERSION).toBe('16.0');
    expect(BIDI_UNICODE_VERSION).toBe(IDNA_UNICODE_VERSION);
  });

  it('answers the three general-category questions the label checks ask', () => {
    expect(isCombiningMark(0x301)).toBe(true);
    expect(isCombiningMark(0x903)).toBe(true); // Mc
    expect(isCombiningMark(0x20dd)).toBe(true); // Me
    expect(isCombiningMark(0x61)).toBe(false);
    expect(isDecimalDigit(0x37)).toBe(true);
    expect(isDecimalDigit(0x661)).toBe(true);
    expect(isDecimalDigit(0x61)).toBe(false);
    expect(isUppercase(0x41)).toBe(true);
    expect(isUppercase(0xdc)).toBe(true);
    expect(isUppercase(0xfc)).toBe(false);
  });

  // Unicode 12.0 is the last version IANA published the derived values for. The property is built
  // never to move for an assigned code point, so every code point 12.0 assigns derives to 12.0's
  // value here. The table is the Java reference's own test fixture, so this skips without it.
  const csv = fileURLToPath(
    new URL(
      '../../../.references/ltr8-io-tson-java/ltr8-unicode/src/test/resources/io/ltr8/unicode/idna-tables-12.0.0-properties.csv',
      import.meta.url,
    ),
  );
  it.skipIf(!existsSync(csv))(
    "derives every code point Unicode 12.0 assigns to IANA's published value",
    () => {
      const differences: string[] = [];
      let compared = 0;
      for (const line of readFileSync(csv, 'utf8').split('\n').slice(1)) {
        if (line.trim() === '') continue;
        const [codes, name] = line.trim().split(',');
        if (name === undefined || name === 'UNASSIGNED' || codes === undefined) continue;
        const [from, to] = codes.split('-').map((hex) => Number.parseInt(hex, 16));
        for (let cp = from ?? 0; cp <= (to ?? from ?? 0); cp++) {
          if (cp >= 0xd800 && cp <= 0xdfff) continue;
          compared++;
          if (idnaProperty(cp) !== name && differences.length < 20) {
            differences.push(
              `U+${cp.toString(16)}: 12.0 says ${name}, derived ${idnaProperty(cp)}`,
            );
          }
        }
      }
      expect(differences).toEqual([]);
      expect(compared).toBeGreaterThan(270_000);
    },
  );
});

describe('IDNA2008 contextual rules (RFC 5892 Appendix A)', () => {
  it('A.1: ZWNJ needs a virama before it, or a joining context across it', () => {
    expect(idnaContextual('क्‌ष', 2)).toBe(true);
    expect(idnaContextual('ب‌ب', 1)).toBe(true);
    expect(idnaContextual('ab‌c', 2)).toBe(false);
    expect(idnaContextual('‌ab', 0)).toBe(false);
  });

  it('A.2: ZWJ needs a virama before it', () => {
    expect(idnaContextual('क्‍', 2)).toBe(true);
    expect(idnaContextual('ب‍ب', 1)).toBe(false);
  });

  it('A.3: MIDDLE DOT between two l', () => {
    expect(idnaContextual('l·l', 1)).toBe(true);
    expect(idnaContextual('a·l', 1)).toBe(false);
    expect(idnaContextual('l·', 1)).toBe(false);
  });

  it('A.4: GREEK LOWER NUMERAL SIGN before a Greek letter', () => {
    expect(idnaContextual('͵α', 0)).toBe(true);
    expect(idnaContextual('͵a', 0)).toBe(false);
    expect(idnaContextual('͵', 0)).toBe(false);
  });

  it('A.5, A.6: Hebrew geresh and gershayim after a Hebrew letter', () => {
    expect(idnaContextual('א׳', 1)).toBe(true);
    expect(idnaContextual('א״', 1)).toBe(true);
    expect(idnaContextual('a׳', 1)).toBe(false);
    expect(idnaContextual('׳', 0)).toBe(false);
  });

  it('A.7: KATAKANA MIDDLE DOT in a label with Hiragana, Katakana or Han', () => {
    expect(idnaContextual('ア・イ', 1)).toBe(true);
    expect(idnaContextual('a・b', 1)).toBe(false);
  });

  it('A.8, A.9: Arabic-Indic and Extended Arabic-Indic digits are not mixed', () => {
    expect(idnaContextual('ب١', 1)).toBe(true);
    expect(idnaContextual('١۱', 0)).toBe(false);
    expect(idnaContextual('۱١', 0)).toBe(false);
  });

  it('permits nothing else', () => {
    expect(idnaContextual('a', 0)).toBe(false);
  });
});

describe('uLabelProblem (RFC 5891 §5.4)', () => {
  it('accepts a valid U-label', () => {
    expect(uLabelProblem('bücher')).toBeUndefined();
    expect(uLabelProblem('ตัวอย่าง')).toBeUndefined();
  });

  it('refuses each way a label is not one', () => {
    expect(uLabelProblem('bücher')).toContain('Normalization Form C');
    expect(uLabelProblem('üü--a')).toContain('third and fourth');
    expect(uLabelProblem('üa-')).toContain('hyphen');
    expect(uLabelProblem('-üa')).toContain('hyphen');
    expect(uLabelProblem('́a')).toContain('combining mark');
    expect(uLabelProblem('a͸')).toContain('not assigned');
    expect(uLabelProblem('aÜ')).toContain('uppercase U+00DC');
    expect(uLabelProblem('a b')).toContain('does not permit');
    expect(uLabelProblem('a‍b')).toContain('contextual rule');
  });
});

describe("RFC 5893's Bidi rule", () => {
  it('rightToLeft text makes a bidi name (§1.4)', () => {
    expect(hasRightToLeft(ARABIC)).toBe(true);
    expect(hasRightToLeft('a١')).toBe(true);
    expect(hasRightToLeft('example')).toBe(false);
  });

  it('passes well-formed labels', () => {
    expect(bidiViolation(ARABIC)).toBeUndefined();
    expect(bidiViolation(`${HEBREW}1`)).toBeUndefined();
    expect(bidiViolation('example')).toBeUndefined();
    expect(bidiViolation('abc1')).toBeUndefined();
  });

  it('rule 1: a label begins in one direction', () => {
    expect(bidiViolation('1abc')).toContain('rule 1');
  });

  it('rule 2: a right-to-left label holds no left-to-right character', () => {
    expect(bidiViolation(`${HEBREW}a`)).toContain('rule 2');
  });

  it('rule 3: a right-to-left label ends right-to-left or in a digit', () => {
    expect(bidiViolation(`${HEBREW}-`)).toContain('rule 3');
  });

  it('rule 4: a right-to-left label mixes no digit systems', () => {
    expect(bidiViolation(`${ARABIC}1١`)).toContain('rule 4');
  });

  it('rule 5: a left-to-right label holds no right-to-left character', () => {
    expect(bidiViolation(`a${HEBREW}`)).toContain('rule 5');
  });

  it('rule 6: a left-to-right label ends left-to-right or in a digit', () => {
    expect(bidiViolation('abc-')).toContain('rule 6');
  });

  it('ignores a trailing non-spacing mark when judging the last character', () => {
    expect(bidiViolation(`${HEBREW}ְ`)).toBeUndefined();
  });
});
