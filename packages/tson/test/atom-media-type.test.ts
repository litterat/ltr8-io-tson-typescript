import { describe, expect, it } from 'vitest';

import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import { createMediaTypeParser, parseMediaType } from '../src/atom/network/index.js';

function refusal(text: string): string {
  try {
    parseMediaType(text, { allowParameters: true });
  } catch (error) {
    if (error instanceof TsonAtomParseError) return error.message;
    throw error;
  }
  throw new Error(`'${text}' was accepted`);
}

describe('media_type: RFC 6838 type/subtype ([TSON-DATA] §5.5)', () => {
  it('compares type and subtype without ASCII case; the canonical text is lowercase', () => {
    const value = parseMediaType('Application/LD+JSON');
    expect(value.text).toBe('application/ld+json');
    expect(value.type).toBe('application');
    expect(value.subtype).toBe('ld+json');
    expect(value.suffix).toBe('json');
  });

  it('reads a plain and a vendor-tree type', () => {
    expect(parseMediaType('text/html').text).toBe('text/html');
    expect(parseMediaType('application/vnd.api+json').text).toBe('application/vnd.api+json');
    expect(parseMediaType('text/html').suffix).toBeUndefined();
  });

  it('takes the structured suffix from the last +', () => {
    expect(parseMediaType('application/vnd.a+b+xml').suffix).toBe('xml');
  });

  it('refuses a missing subtype, a media range and a leading punctuation mark (RFC 6838 §4.2)', () => {
    expect(refusal('text')).toContain("no '/'");
    expect(refusal('text/')).toContain('subtype of 0 characters');
    expect(refusal('text/*')).toContain('media range');
    expect(refusal('*/*')).toContain('media range');
    expect(refusal('text/-html')).toContain('begins with a letter or digit');
    expect(refusal('+text/html')).toContain('begins with a letter or digit');
  });

  it('refuses a character beyond the restricted-name set, and anything beyond US-ASCII', () => {
    expect(refusal('text/héllo')).toContain('U+00E9');
    expect(refusal('te xt/html')).toContain('U+0020');
  });

  it('bounds a type or subtype to 127 characters (RFC 6838 §4.2)', () => {
    expect(parseMediaType(`text/${'a'.repeat(127)}`).subtype).toHaveLength(127);
    expect(refusal(`text/${'a'.repeat(128)}`)).toContain('1 to 127');
  });
});

describe('media_type: parameters (RFC 9110 §8.3.1) and the allow_parameters facet', () => {
  it('admits no parameters by default, as a constraint violation (§5.2)', () => {
    expect(() => parseMediaType('text/plain;charset=utf-8')).toThrow(TsonAtomValidationError);
    expect(() => parseMediaType('text/plain', { allowParameters: false })).not.toThrow();
  });

  it('sorts parameters by name, folds names and the charset value, and keeps other values', () => {
    const value = parseMediaType('Text/Plain; Format=Flowed; CHARSET=UTF-8', {
      allowParameters: true,
    });
    expect(value.text).toBe('text/plain;charset=utf-8;format=Flowed');
    expect([...value.parameters.keys()]).toEqual(['charset', 'format']);
  });

  it('makes a quoted value equal its token form, and re-quotes only where needed', () => {
    const quoted = parseMediaType('text/plain;a="b"', { allowParameters: true });
    expect(quoted.text).toBe('text/plain;a=b');
    const spaced = parseMediaType('text/plain;a="b c"', { allowParameters: true });
    expect(spaced.text).toBe('text/plain;a="b c"');
    const escaped = parseMediaType('text/plain;a="b\\"c\\\\d"', { allowParameters: true });
    expect(escaped.parameters.get('a')).toBe('b"c\\d');
    expect(escaped.text).toBe('text/plain;a="b\\"c\\\\d"');
    expect(parseMediaType('text/plain;a=""', { allowParameters: true }).text).toBe(
      'text/plain;a=""',
    );
  });

  it('admits whitespace around the semicolon and an empty parameter', () => {
    expect(parseMediaType('text/plain ;\ta=b ;; c=d', { allowParameters: true }).text).toBe(
      'text/plain;a=b;c=d',
    );
    expect(parseMediaType('text/plain;', { allowParameters: true }).text).toBe('text/plain');
  });

  it('refuses a repeated parameter name, since parameters are a map', () => {
    expect(refusal('text/plain;a=1;A=2')).toContain('twice');
  });

  it('refuses malformed parameters', () => {
    expect(refusal('text/plain;a')).toContain('token name');
    expect(refusal('text/plain;=b')).toContain('token name');
    expect(refusal('text/plain;a=')).toContain('no value');
    expect(refusal('text/plain;a="b')).toContain('no closing');
    expect(refusal('text/plain;a="b\\')).toContain('escaping nothing');
    expect(refusal('text/plain;a="é"')).toContain('U+00E9');
    expect(refusal('text/plain ')).toContain('ends in whitespace');
    expect(refusal('text/plain x')).toContain("';' or the end");
  });
});

describe('media_type: the types and suffixes facets', () => {
  it('admits only the listed types, compared without ASCII case (§5.5)', () => {
    const facets = { types: ['Text', 'application'] };
    expect(parseMediaType('TEXT/html', facets).type).toBe('text');
    expect(() => parseMediaType('image/png', facets)).toThrow(TsonAtomValidationError);
  });

  it('admits a subtype that is, or ends after a + with, a listed suffix', () => {
    const facets = { suffixes: ['JSON'] };
    expect(parseMediaType('application/json', facets).subtype).toBe('json');
    expect(parseMediaType('application/ld+json', facets).subtype).toBe('ld+json');
    expect(() => parseMediaType('application/xml', facets)).toThrow(TsonAtomValidationError);
    expect(() => parseMediaType('application/jsonx', facets)).toThrow(TsonAtomValidationError);
  });

  it('a type outside the grammar is a parse failure whatever the facets say', () => {
    expect(() => parseMediaType('not a media type', { types: ['text'] })).toThrow(
      TsonAtomParseError,
    );
  });
});

describe('media_type: the AtomType', () => {
  it('reads to the canonical text, so two spellings of one media type are one value', () => {
    const atom = createMediaTypeParser('media_type', { allowParameters: true });
    const form = 'unquoted' as const;
    expect(atom.read({ text: 'Text/Plain; b=2; A="1"', form })).toBe(
      atom.read({ text: 'text/plain;a=1;b=2', form }),
    );
  });
});
