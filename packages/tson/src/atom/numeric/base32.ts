/**
 * Decode/encode logic for {@link createBinaryParser}'s `BASE32` encoding -- RFC 4648 §6, the port
 * of `atom/Base32Decoding.java`. The one binary encoding with no host codec to lean on or diverge
 * from at all (unlike base64, JS has nothing analogous to even borrow the wrong leniency from):
 * 5 bits per character against the canonical uppercase alphabet
 * `ABCDEFGHIJKLMNOPQRSTUVWXYZ234567`, accumulated into (or out of) an 8-bit-aligned byte stream.
 *
 * **Case-sensitive (uppercase only)** -- unlike hex, RFC 4648 doesn't establish case-insensitivity
 * as a universal decode convention for base32's alphabet, and meta.tn says only that "encoding
 * alphabets are pinned to RFC 4648" with no mention of case flexibility; a lowercase input is
 * rejected rather than silently accepted.
 *
 * **Padding (`=`) is required** to a multiple of 8 characters, with the count of trailing padding
 * characters restricted to RFC 4648 §6's own table -- `0`/`1`/`3`/`4`/`6` (5/4/3/2/1 data bytes in
 * the final block); `2`/`5`/`7` are never valid regardless of what they'd arithmetically decode
 * to. Like {@link decodeBase64}, not strict about non-canonical trailing bits within the last
 * partial byte (RFC 4648 §3.5 makes rejecting those optional, not required).
 */

import { TsonAtomParseError } from '../../core/errors.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Legal counts of trailing `=` padding characters in a canonical (length-multiple-of-8) base32 encoding. */
const LEGAL_PADDING_COUNT = [true, true, false, true, true, false, true, false];

/** Decodes `text` per RFC 4648 §6, padding required. */
export function decodeBase32(text: string, typeRef: string): Uint8Array {
  if (text.length % 8 !== 0) {
    throw new TsonAtomParseError(
      typeRef,
      `'${text}' is not a valid base32 encoding -- length must be a multiple of 8 once padded (RFC 4648 §6, §5.3)`,
      'a base32 encoding',
    );
  }

  let padding = 0;
  while (padding < text.length && text.charAt(text.length - 1 - padding) === '=') {
    padding += 1;
  }
  // An all-padding string (e.g. "========") counts up past the table entirely -- bounds-check
  // before indexing rather than let it read past the array.
  if (padding >= LEGAL_PADDING_COUNT.length || !LEGAL_PADDING_COUNT[padding]) {
    throw new TsonAtomParseError(
      typeRef,
      `'${text}' is not a valid base32 encoding -- ${String(padding)} padding characters is not a legal count (RFC 4648 §6)`,
      'a base32 encoding',
    );
  }

  const dataChars = text.length - padding;
  const output = new Uint8Array((dataChars * 5) / 8);
  let buffer = 0;
  let bitsInBuffer = 0;
  let outputIndex = 0;
  for (let i = 0; i < dataChars; i += 1) {
    const ch = text.charAt(i);
    const value = ALPHABET.indexOf(ch);
    if (value < 0) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid base32 encoding -- '${ch}' is not in the base32 alphabet (RFC 4648 §6)`,
        'a base32 encoding',
      );
    }
    buffer = (buffer << 5) | value;
    bitsInBuffer += 5;
    if (bitsInBuffer >= 8) {
      bitsInBuffer -= 8;
      output[outputIndex] = (buffer >> bitsInBuffer) & 0xff;
      outputIndex += 1;
    }
  }
  return output;
}

/** The exact inverse of {@link decodeBase32}: pads to a length-multiple-of-8 with `=`. */
export function encodeBase32(data: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bitsInBuffer = 0;
  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bitsInBuffer += 8;
    while (bitsInBuffer >= 5) {
      bitsInBuffer -= 5;
      out += ALPHABET.charAt((buffer >> bitsInBuffer) & 0x1f);
    }
  }
  if (bitsInBuffer > 0) {
    out += ALPHABET.charAt((buffer << (5 - bitsInBuffer)) & 0x1f);
  }
  while (out.length % 8 !== 0) {
    out += '=';
  }
  return out;
}
