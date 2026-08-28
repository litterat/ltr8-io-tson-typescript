import { describe, expect, it } from 'vitest';
import { lookupBuiltinAtom } from '../src/reader/schemaless/vocabulary.js';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import type { Uuid } from '../src/value/types.js';

/**
 * `reader/schemaless/vocabulary.ts` -- ported from `atom/BuiltinTypeVocabulary.java`. Spot-checks
 * that each entry is wired to the *unconstrained* instance `spec/m/core.tn` actually declares
 * (`int32 => !integer ^ { size: { bits: 32 signed: true } }`, `float32 => !float_type { format:
 * BINARY32 }`, ...), not just that a parser of the right family exists.
 */

describe('lookupBuiltinAtom -- coverage matching BuiltinTypeVocabulary.java exactly', () => {
  it('is undefined for a name outside the built-in vocabulary', () => {
    expect(lookupBuiltinAtom('not_a_real_type')).toBeUndefined();
  });

  it('has no entry for boolean/regex/unknown -- the same gaps BuiltinTypeVocabulary.java has', () => {
    expect(lookupBuiltinAtom('boolean')).toBeUndefined();
    expect(lookupBuiltinAtom('regex')).toBeUndefined();
    expect(lookupBuiltinAtom('unknown')).toBeUndefined();
  });

  it('covers the full int8..int256/uint8..uint256 ladder plus the four sign-bounded refinements', () => {
    for (const width of [8, 16, 32, 64, 128, 256]) {
      expect(lookupBuiltinAtom(`int${String(width)}`)).toBeDefined();
      expect(lookupBuiltinAtom(`uint${String(width)}`)).toBeDefined();
    }
    for (const name of [
      'positive_integer',
      'non_negative_integer',
      'negative_integer',
      'non_positive_integer',
    ]) {
      expect(lookupBuiltinAtom(name)).toBeDefined();
    }
  });
});

describe('lookupBuiltinAtom -- each entry matches its core.tn instance', () => {
  it('int8 is width-8 signed, matching `int8 => !integer ^ { size: { bits: 8 signed: true } }`', () => {
    const int8 = lookupBuiltinAtom('int8');
    expect(int8?.read({ text: '127', form: 'unquoted' })).toBe(127);
    expect(() => int8?.read({ text: '128', form: 'unquoted' })).toThrow(TsonAtomValidationError);
    expect(() => int8?.read({ text: '-129', form: 'unquoted' })).toThrow(TsonAtomValidationError);
  });

  it('uint8 rejects a negative value, matching its unsigned size', () => {
    const uint8 = lookupBuiltinAtom('uint8');
    expect(uint8?.read({ text: '255', form: 'unquoted' })).toBe(255);
    expect(() => uint8?.read({ text: '-1', form: 'unquoted' })).toThrow(TsonAtomValidationError);
  });

  it('positive_integer is unbounded-width, min 1, matching `!integer ^ { min: 1 }`', () => {
    const positive = lookupBuiltinAtom('positive_integer');
    expect(positive?.read({ text: '9007199254740993', form: 'unquoted' })).toBe(9007199254740993n);
    expect(() => positive?.read({ text: '0', form: 'unquoted' })).toThrow(TsonAtomValidationError);
  });

  it('number (decimal_type) is exact and unconstrained -- no based-integer, no special values', () => {
    const number = lookupBuiltinAtom('number');
    expect(number?.read({ text: '3.5', form: 'unquoted' })).toEqual({
      unscaled: 35n,
      exponent: -1,
    });
    expect(() => number?.read({ text: '.inf', form: 'unquoted' })).toThrow(TsonAtomParseError);
  });

  it('float32/float64 allow every special value, matching every allow* flag true', () => {
    const float32 = lookupBuiltinAtom('float32');
    expect(float32?.read({ text: '.nan', form: 'unquoted' })).toBeNaN();
    expect(float32?.read({ text: '.inf', form: 'unquoted' })).toBe(Infinity);
    expect(float32?.read({ text: '-.inf', form: 'unquoted' })).toBe(-Infinity);
  });

  it('text is unconstrained -- every token text is a valid value', () => {
    const text = lookupBuiltinAtom('text');
    expect(text?.read({ text: 'hello world', form: 'single-line' })).toBe('hello world');
  });

  it('base64/base64url/base32/hex each decode their own RFC 4648 encoding', () => {
    // "hi" == base64 "aGk="
    const base64 = lookupBuiltinAtom('base64');
    expect(base64?.read({ text: 'aGk=', form: 'unquoted' })).toEqual(new Uint8Array([0x68, 0x69]));
    const hex = lookupBuiltinAtom('hex');
    expect(hex?.read({ text: '6869', form: 'unquoted' })).toEqual(new Uint8Array([0x68, 0x69]));
  });

  it('uuid is unconstrained -- no declared version', () => {
    const uuid = lookupBuiltinAtom('uuid');
    const value = uuid?.read({
      text: '01234567-89ab-cdef-0123-456789abcdef',
      form: 'unquoted',
    }) as Uuid;
    expect(value.bytes).toHaveLength(16);
  });

  it('date/time/datetime/duration are unconstrained', () => {
    expect(lookupBuiltinAtom('date')?.read({ text: '2026-01-01', form: 'unquoted' })).toEqual({
      year: 2026,
      month: 1,
      day: 1,
    });
    expect(lookupBuiltinAtom('duration')?.read({ text: 'P1D', form: 'unquoted' })).toBeDefined();
  });

  it('uri/email/mac/ipv4/ipv6/cidr4/cidr6 each parse their own shape unconstrained', () => {
    expect(
      lookupBuiltinAtom('uri')?.read({ text: 'https://example.com', form: 'single-line' }),
    ).toBe('https://example.com');
    expect(lookupBuiltinAtom('email')?.read({ text: 'a@example.com', form: 'single-line' })).toBe(
      'a@example.com',
    );
    expect(lookupBuiltinAtom('ipv4')?.read({ text: '192.0.2.1', form: 'unquoted' })).toBeDefined();
    expect(
      lookupBuiltinAtom('ipv6')?.read({ text: '2001:db8::1', form: 'single-line' }),
    ).toBeDefined();
    expect(
      lookupBuiltinAtom('cidr4')?.read({ text: '192.0.2.0/24', form: 'single-line' }),
    ).toBeDefined();
    expect(
      lookupBuiltinAtom('mac')?.read({ text: 'aa-bb-cc-dd-ee-ff', form: 'unquoted' }),
    ).toBeDefined();
  });
});
