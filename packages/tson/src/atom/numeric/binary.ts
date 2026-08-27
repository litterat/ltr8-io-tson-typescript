/**
 * Parses and validates against meta.tn's `binary` constructor (§5.3's four binary atoms, RFC
 * 4648) -- the port of `atom/BinaryParser.java`. One factory, not one per encoding: each
 * encoding's decode algorithm is genuinely different, but that is the same shape of branching
 * {@link createIntegerParser} already does on `size.signed` and {@link createFloatParser} already
 * does on `format`, not a reason to fork the module (`BinaryParser.java`'s own Javadoc makes the
 * same call, after an earlier version of that file tried the four-class split).
 *
 * Hex has no dedicated module here the way base64/base32 do (`base64.ts`/`base32.ts`) -- RFC 4648
 * §8's base16 alphabet is a direct nibble-to-hex-digit mapping with no bit-accumulation state to
 * carry between characters, so it stays inline, mirroring `BinaryParser.java`'s own
 * `decodeHex`/`HexFormat` use (the one encoding the JDK covers natively, so Java never wrote a
 * standalone class for it either).
 */

import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import type { BinaryType } from '../../schema/meta/atoms-text.js';
import type { AtomToken, AtomType } from '../contract.js';
import { decodeBase32, encodeBase32 } from './base32.js';
import { decodeBase64, encodeBase64 } from './base64.js';

const HEX_DIGITS = '0123456789abcdef';

function hexDigitValue(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return code - 0x30; // 0-9
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10; // a-f
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10; // A-F
  return -1;
}

function decodeHex(text: string, typeRef: string): Uint8Array {
  if (text.length % 2 !== 0) {
    throw new TsonAtomParseError(
      typeRef,
      `'${text}' is not valid hex (RFC 4648 §8, §5.3) -- an odd number of hex digits can't encode a whole number of bytes`,
      'a hex encoding',
    );
  }
  const output = new Uint8Array(text.length / 2);
  for (let i = 0; i < text.length; i += 2) {
    const high = hexDigitValue(text.charAt(i));
    const low = hexDigitValue(text.charAt(i + 1));
    if (high < 0 || low < 0) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not valid hex (RFC 4648 §8, §5.3) -- contains a character outside 0-9/a-f/A-F`,
        'a hex encoding',
      );
    }
    output[i / 2] = (high << 4) | low;
  }
  return output;
}

function encodeHex(data: Uint8Array): string {
  let out = '';
  for (const byte of data) {
    out += HEX_DIGITS.charAt((byte >> 4) & 0xf);
    out += HEX_DIGITS.charAt(byte & 0xf);
  }
  return out;
}

/**
 * Builds the `AtomType` for one fully-parameterised `binary` instance -- e.g. `base64 => !binary
 * BASE64` is `createBinaryParser('base64', { kind: 'binary', encoding: 'BASE64' })`. See
 * {@link createIntegerParser} for why `typeRef` is required explicitly rather than derived from
 * `encoding` the way `BinaryParser.java`'s own `typeName()` derives it.
 */
export function createBinaryParser(typeRef: string, constraints: BinaryType): AtomType<Uint8Array> {
  function validate(value: Uint8Array, text: string): void {
    const { minLength, maxLength } = constraints;
    if (minLength !== undefined && value.length < minLength) {
      const length = String(value.length);
      const bound = String(minLength);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' decodes to ${length} bytes, less than the minimum ${bound}`,
        `at least ${bound} bytes`,
      );
    }
    if (maxLength !== undefined && value.length > maxLength) {
      const length = String(value.length);
      const bound = String(maxLength);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' decodes to ${length} bytes, more than the maximum ${bound}`,
        `at most ${bound} bytes`,
      );
    }
  }

  return {
    read(token: AtomToken) {
      const text = token.text;
      const value = ((): Uint8Array => {
        switch (constraints.encoding) {
          case 'BASE64':
            return decodeBase64(text, 'BASE64', typeRef);
          case 'BASE64URL':
            return decodeBase64(text, 'BASE64URL', typeRef);
          case 'BASE32':
            return decodeBase32(text, typeRef);
          case 'HEX':
            return decodeHex(text, typeRef);
        }
      })();
      validate(value, text);
      return value;
    },
    write(value) {
      switch (constraints.encoding) {
        case 'BASE64':
          return encodeBase64(value, 'BASE64');
        case 'BASE64URL':
          return encodeBase64(value, 'BASE64URL');
        case 'BASE32':
          return encodeBase32(value);
        case 'HEX':
          return encodeHex(value);
      }
    },
  };
}
