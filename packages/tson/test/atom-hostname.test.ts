import { describe, expect, it } from 'vitest';

import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import { createHostnameParser, parseHostname } from '../src/atom/network/index.js';

/** `bücher`, spelled by escape so no editor normalises the fixture. */
const BUECHER = 'bücher';

function refusal(text: string): string {
  try {
    parseHostname(text);
  } catch (error) {
    if (error instanceof TsonAtomParseError) return error.message;
    throw error;
  }
  throw new Error(`'${text}' was accepted`);
}

describe('hostname: LDH names ([TSON-DATA] §5.5, RFC 1123 §2.1)', () => {
  it('reads A-Z as a-z and nothing else, in a name of letters, digits and hyphens', () => {
    const name = parseHostname('Api.Example.COM');
    expect(name.text).toBe('api.example.com');
    expect(name.ascii).toBe('api.example.com');
    expect(name.isIdn).toBe(false);
  });

  it('admits a single label and a digit-leading label that is not the last (§5.5)', () => {
    expect(parseHostname('localhost').text).toBe('localhost');
    expect(parseHostname('3com.example').text).toBe('3com.example');
  });

  it('refuses a last label beginning with a digit, which keeps a dotted-quad from being a name (§5.5)', () => {
    expect(refusal('192.0.2.1')).toContain('IPv4 address');
    expect(refusal('example.1abc')).toContain('beginning with a digit');
  });

  it('refuses the boundaries an operator meets, each with its fix (§5.5)', () => {
    expect(refusal('example.com.')).toContain("write 'example.com'");
    expect(refusal('b%C3%BCcher.example')).toContain('percent-encoded');
    expect(refusal('_dmarc.example.com')).toContain("'_'");
    expect(refusal('example-.com')).toContain('hyphen');
    expect(refusal('-example.com')).toContain('hyphen');
    expect(refusal('ab--cd.example')).toContain('reserved for A-labels');
    expect(refusal('a..b')).toContain('empty label');
    expect(refusal('.a')).toContain('empty label');
    expect(refusal('')).toContain('empty');
    expect(refusal('exa mple.com')).toContain('letters, digits and hyphens');
  });

  it('counts label and name lengths in octets of the A-label form (RFC 1035 §2.3.4)', () => {
    expect(refusal(`${'a'.repeat(64)}.example`)).toContain('at most 63');
    expect(parseHostname(`${'a'.repeat(63)}.example`).text).toHaveLength(71);
    const longest = [63, 63, 63, 61].map((n, i) => 'abcd'[i]?.repeat(n)).join('.');
    expect(parseHostname(longest).ascii).toHaveLength(253);
    expect(refusal(`${longest}a`)).toContain('at most 253');
  });
});

describe('hostname: IDNA2008 labels ([TSON-DATA] §5.5, RFC 5890-5893)', () => {
  it('reads a U-label and its A-label as one name, canonical text the U-label form', () => {
    const unicode = parseHostname(`${BUECHER}.example`);
    const ascii = parseHostname('xn--bcher-kva.example');
    expect(unicode.text).toBe(`${BUECHER}.example`);
    expect(ascii.text).toBe(`${BUECHER}.example`);
    expect(unicode.ascii).toBe('xn--bcher-kva.example');
    expect(ascii.ascii).toBe('xn--bcher-kva.example');
    expect(unicode.isIdn && ascii.isIdn).toBe(true);
  });

  it('folds ASCII case in an A-label too, and in a mixed name', () => {
    expect(parseHostname('XN--BCHER-KVA.Example').text).toBe(`${BUECHER}.example`);
    expect(parseHostname(`${BUECHER}.EXAMPLE`).text).toBe(`${BUECHER}.example`);
  });

  it("reads IANA's Thai test name, and its A-label form back to it", () => {
    const thai = parseHostname('ตัวอย่าง.ไทย');
    expect(thai.ascii.startsWith('xn--')).toBe(true);
    expect(parseHostname(thai.ascii).text).toBe(thai.text);
  });

  it('refuses uppercase beyond ASCII with its fix, mapping nothing (RFC 5891 §5.4)', () => {
    const message = refusal('BÜCHER.example');
    expect(message).toContain('uppercase U+00DC');
    expect(message).toContain(`write '${BUECHER}.example'`);
  });

  it('refuses a fullwidth spelling, which UTS #46 would map and IDNA2008 does not', () => {
    expect(refusal('ｅxample.com')).toContain('U+FF45');
  });

  it('refuses a label not in NFC, naming the composed form', () => {
    const message = refusal('bücher.example');
    expect(message).toContain('Normalization Form C');
    expect(message).toContain(`write '${BUECHER}.example'`);
  });

  it('refuses a label beginning with a combining mark (RFC 5891 §4.2.3.2)', () => {
    expect(refusal('̈a.example')).toContain('combining mark');
  });

  it('refuses an A-label that is not the Punycode of a valid U-label (RFC 5890 §2.3.2.1)', () => {
    expect(refusal('xn--abc.example')).toContain('A-label');
    expect(refusal('xn--example-.example')).toContain('not an A-label');
  });

  it('refuses an A-label whose Punycode decodes to a label that is not valid', () => {
    expect(refusal('xn--bcher-kvb.example')).toContain('A-label');
  });

  it('applies the contextual rules of RFC 5892 Appendix A', () => {
    // Devanagari KA, VIRAMA, ZWJ, SSA: ZWJ after a virama is permitted.
    expect(parseHostname('क्‍ष.example').isIdn).toBe(true);
    expect(refusal('a‍b.example')).toContain('contextual rule');
    // MIDDLE DOT between two l's only.
    expect(parseHostname('l·l.example').isIdn).toBe(true);
    expect(refusal('a·l.example')).toContain('contextual rule');
  });

  it("applies RFC 5893's Bidi rule to every label of a name holding right-to-left text (§5.5)", () => {
    expect(parseHostname('مثال.example').isIdn).toBe(true);
    expect(refusal('1abc.مثال')).toContain('Bidi rule');
  });

  it('refuses a U-label whose Punycode would exceed 63 octets', () => {
    expect(refusal(`${'ü'.repeat(60)}.example`)).toContain('at most 63');
  });
});

describe('hostname: the allow_idn facet ([TSON-SCHEMA] §5.5)', () => {
  it('admits an internationalized name by default and with allowIdn true', () => {
    expect(parseHostname(`${BUECHER}.example`).isIdn).toBe(true);
    expect(parseHostname(`${BUECHER}.example`, { allowIdn: true }).isIdn).toBe(true);
  });

  it('refuses one as a constraint violation, not a parse failure, under allowIdn false (§5.2)', () => {
    expect(() => parseHostname(`${BUECHER}.example`, { allowIdn: false })).toThrow(
      TsonAtomValidationError,
    );
    expect(() => parseHostname('xn--bcher-kva.example', { allowIdn: false })).toThrow(
      TsonAtomValidationError,
    );
    expect(parseHostname('example.com', { allowIdn: false }).isIdn).toBe(false);
  });

  it('a token outside the grammar is a parse failure whatever the facets say (§5.2)', () => {
    expect(() => parseHostname('exa_mple.com', { allowIdn: false })).toThrow(TsonAtomParseError);
  });

  it('names the type it was asked as in its error', () => {
    try {
      parseHostname('exa_mple.com', {}, 'server_name');
      expect.unreachable();
    } catch (error) {
      expect((error as TsonAtomParseError).typeRef).toBe('server_name');
      expect((error as TsonAtomParseError).expected).toBe('a host name');
    }
  });
});

describe('hostname: the AtomType (§5.5)', () => {
  const atom = createHostnameParser('hostname');

  it('reads to the canonical text, so two spellings of one name are one value', () => {
    const form = 'unquoted' as const;
    expect(atom.read({ text: 'xn--bcher-kva.example', form })).toBe(
      atom.read({ text: `${BUECHER}.EXAMPLE`, form }),
    );
    expect(atom.write(atom.read({ text: 'Example.COM', form }))).toBe('example.com');
  });
});
