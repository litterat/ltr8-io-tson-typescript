import { describe, expect, it } from 'vitest';
import { TsonRegexSyntaxError } from '../src/regex/errors.js';
import type {
  Alternation,
  CategoryEscape,
  CharClass,
  ClassRange,
  Literal,
  Repeat,
} from '../src/regex/parse.js';
import { parseIRegex } from '../src/regex/parse.js';

/**
 * `parseIRegex`: parsing and subset-validating I-Regexp (RFC 9485 §3). Proves the interoperable
 * subset is accepted, that constructs outside it (the whole point of the pin) are rejected, and
 * that a few AST shapes and I-Regexp's own semantic quirks (anchors are literals) come out right.
 */
describe('I-Regexp parsing (RFC 9485 §3)', () => {
  it('accepts every pattern in the interoperable subset', () => {
    const valid = [
      '', // empty matches the empty string
      'abc',
      'a|b|c',
      '(a|b)c',
      'colou?r',
      'a*',
      'a+',
      'b?',
      '(ab)+',
      'a{3}',
      'a{2,4}',
      'a{2,}',
      '[a-z]',
      '[A-Za-z0-9]',
      '[^0-9]',
      '[abc]',
      '[-a]',
      '[a-]', // '-' as first/last member is a literal
      '[a.]', // '.' inside a class is a literal
      '.',
      '\\.',
      '\\(',
      '\\\\',
      '\\?',
      '\\p{L}',
      '\\P{Nd}',
      '\\p{Lu}\\p{Ll}*',
      '[\\p{L}\\p{Nd}_]',
      '192\\.168\\.0\\.1',
      'café', // combining/accented letters are ordinary literals
      '😀+', // a supplementary-plane code point is a single atom
    ];
    for (const pattern of valid) {
      expect(() => parseIRegex(pattern), pattern).not.toThrow();
    }
  });

  it('rejects every construct RFC 9485 §3 excludes from the interoperable subset', () => {
    const invalid = [
      '\\d',
      '\\w',
      '\\s',
      '\\D', // no multi-character escapes
      'a**',
      'a*?',
      '*abc', // stray / non-greedy quantifiers
      '(?:a)',
      '(?=a)', // no non-capturing groups or lookaround
      '\\1',
      '\\b', // no back-references or word boundaries
      '[a-z-[aeiou]]', // no character-class subtraction
      '[]',
      '[^]', // empty / empty-negated class
      '\\p{IsBasicLatin}', // no Unicode blocks
      '\\p{Foo}',
      '\\p{ll}', // not a valid, case-sensitive category
      '\\pL', // \p must be \p{...}
      'a{2,1}', // range out of order
      'a{',
      '(',
      'a)',
      '[a',
      '\\',
      '\\p{L', // malformed
    ];
    for (const pattern of invalid) {
      expect(() => parseIRegex(pattern), pattern).toThrow(TsonRegexSyntaxError);
    }
  });

  it('treats ^ and $ as ordinary literal characters, never assertions', () => {
    // I-Regexp has no anchors (RFC 9485 §3.1's ABNF admits no anchor production at all).
    expect(parseIRegex('^')).toEqual({ kind: 'literal', codePoint: 0x5e } satisfies Literal);
    expect(parseIRegex('$')).toEqual({ kind: 'literal', codePoint: 0x24 } satisfies Literal);
  });

  it('builds the expected AST shapes', () => {
    expect(parseIRegex('a{2,4}')).toEqual({
      kind: 'repeat',
      atom: { kind: 'literal', codePoint: 0x61 },
      min: 2,
      max: 4,
    } satisfies Repeat);

    const alt = parseIRegex('ab|cd') as Alternation;
    expect(alt.kind).toBe('alternation');
    expect(alt.alternatives).toHaveLength(2);
    expect(alt.alternatives[0]).toEqual({ kind: 'sequence', pieces: expect.any(Array) as unknown });

    const cls = parseIRegex('[^a-z0]') as CharClass;
    expect(cls.kind).toBe('char-class');
    expect(cls.negated).toBe(true);
    expect(cls.members[0]).toEqual({
      kind: 'class-range',
      low: 0x61,
      high: 0x7a,
    } satisfies ClassRange);
    expect(cls.members[1]).toEqual({ kind: 'literal', codePoint: 0x30 } satisfies Literal);

    const cat = parseIRegex('\\P{Nd}') as CategoryEscape;
    expect(cat.kind).toBe('category-escape');
    expect(cat.category).toBe('Nd');
    expect(cat.complement).toBe(true);

    expect(parseIRegex('.')).toEqual({ kind: 'any-char' });
  });

  it('reports the code-point position of a syntax error', () => {
    let caught: TsonRegexSyntaxError | undefined;
    try {
      parseIRegex('ab\\d');
    } catch (e) {
      caught = e as TsonRegexSyntaxError;
    }
    expect(caught).toBeInstanceOf(TsonRegexSyntaxError);
    expect(caught?.position).toBe(3); // the 'd' after the backslash
    expect(caught?.pattern).toBe('ab\\d');
    expect(caught?.message).not.toBe('');
  });

  it('reports a position in code points, not UTF-16 units, past a supplementary-plane character', () => {
    // '😀' is one code point (U+1F600) but two UTF-16 units; the invalid escape starts right
    // after it, so a UTF-16-addressed parser would misreport the position as 3, not 2.
    let caught: TsonRegexSyntaxError | undefined;
    try {
      parseIRegex('😀\\d');
    } catch (e) {
      caught = e as TsonRegexSyntaxError;
    }
    expect(caught?.position).toBe(2);
  });

  it('rejects an unrecognised \\p{...} category name at the position past the closing brace', () => {
    // categories.ts's isCategoryName gate: exactly the 36 RFC 9485 IsCategory names, checked at
    // parse time so a bad category is a syntax error, not a silently-empty match set.
    expect(() => parseIRegex('\\p{Cs}')).toThrow(TsonRegexSyntaxError); // Cs (surrogate) is excluded
    expect(() => parseIRegex('\\p{Greek}')).toThrow(TsonRegexSyntaxError);
  });
});
