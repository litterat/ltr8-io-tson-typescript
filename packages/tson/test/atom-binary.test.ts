import { describe, expect, it } from 'vitest';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import { createBinaryParser } from '../src/atom/numeric/binary.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { BinaryType } from '../src/schema/meta/atoms-text.js';

// §5.3's four binary atoms, RFC 4648.

function token(text: string): AtomToken {
  return { text, form: 'single-line' };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const BASE64: BinaryType = { kind: 'binary', encoding: 'BASE64' };
const BASE64URL: BinaryType = { kind: 'binary', encoding: 'BASE64URL' };
const BASE32: BinaryType = { kind: 'binary', encoding: 'BASE32' };
const HEX: BinaryType = { kind: 'binary', encoding: 'HEX' };

describe('§5.3 !base64', () => {
  it('decodes RFC 4648 §4 -- "ZGVhZGJlZWY=" decodes to the ASCII text "deadbeef"', () => {
    const value = createBinaryParser('base64', BASE64).read(token('ZGVhZGJlZWY='));
    expect(hex(value)).toBe('6465616462656566');
  });

  it('RFC 4648 §5.3 requires padding -- "TWE" (missing the "=") is rejected, not silently accepted', () => {
    expect(() => createBinaryParser('base64', BASE64).read(token('TWE'))).toThrow(
      TsonAtomParseError,
    );
    expect(createBinaryParser('base64', BASE64).read(token('TWE='))).toBeInstanceOf(Uint8Array);
  });

  it("the standard alphabet doesn't include '-'/'_' -- base64url's characters are rejected here", () => {
    expect(() => createBinaryParser('base64', BASE64).read(token('-_--'))).toThrow(
      TsonAtomParseError,
    );
  });
});

describe('§5.3 !base64url', () => {
  it('decodes RFC 4648 §5\'s URL-safe alphabet -- 0xfbffbe as "-_--"', () => {
    const value = createBinaryParser('base64url', BASE64URL).read(token('-_--'));
    expect(hex(value)).toBe('fbffbe');
  });
});

describe('§5.3 !base32', () => {
  it('decodes RFC 4648 §6 -- "MZXW6YTB" is one of RFC 4648 §10\'s own test vectors ("fooba")', () => {
    const value = createBinaryParser('base32', BASE32).read(token('MZXW6YTB'));
    expect(hex(value)).toBe('666f6f6261');
  });

  it("RFC 4648 §6's padding table only permits 0/1/3/4/6 trailing '=' in a length-8 block -- 2 is never legal", () => {
    expect(() => createBinaryParser('base32', BASE32).read(token('MZXW6Y=='))).toThrow(
      TsonAtomParseError,
    );
  });
});

describe('§5.3 !hex', () => {
  it('decodes RFC 4648 §8 base16', () => {
    const value = createBinaryParser('hex', HEX).read(token('deadbeef'));
    expect(hex(value)).toBe('deadbeef');
  });

  it("an odd number of hex digits can't encode a whole number of bytes", () => {
    expect(() => createBinaryParser('hex', HEX).read(token('abc'))).toThrow(TsonAtomParseError);
  });
});

describe('§5.3 binary -- length bounds', () => {
  it('min_length/max_length validate the decoded byte count', () => {
    const bounded: BinaryType = { kind: 'binary', encoding: 'HEX', minLength: 2, maxLength: 4 };
    const parser = createBinaryParser('bounded', bounded);
    expect(parser.read(token('deadbeef'))).toHaveLength(4);
    expect(() => parser.read(token('de'.repeat(1)))).toThrow(TsonAtomValidationError);
    expect(() => parser.read(token('dead'.repeat(3)))).toThrow(TsonAtomValidationError);
  });
});

describe('§5.3 binary -- write round-trips through read for every encoding', () => {
  it.each([
    ['base64', BASE64],
    ['base64url', BASE64URL],
    ['base32', BASE32],
    ['hex', HEX],
  ] as const)('%s', (typeRef, constraints) => {
    const parser = createBinaryParser(typeRef, constraints);
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
    const text = parser.write(bytes);
    expect(parser.read(token(text))).toEqual(bytes);
  });
});
