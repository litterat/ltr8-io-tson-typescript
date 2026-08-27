/**
 * Decode/encode logic for {@link createBinaryParser}'s `BASE64`/`BASE64URL` encodings -- the port
 * of `atom/Base64Decoding.java`. JS has no host base64 codec that operates on bytes directly
 * (`atob`/`btoa` round-trip through a "binary string" of UTF-16 code units, and neither
 * implements the URL-safe alphabet or enforces padding), so this is authored from scratch against
 * RFC 4648 §4/§5 rather than borrowed, the same call every other binary atom parser in this
 * directory makes.
 *
 * **Padding is REQUIRED, matching §5.3 and RFC 4648 §5.3, not merely accepted when present.** This
 * is the one place a well-known host library (`java.util.Base64.getDecoder()`, confirmed
 * empirically by `Base64Decoding.java`'s own Javadoc) is *more* lenient than the RFC: it accepts
 * `"TWE"` as identical to the correctly-padded `"TWE="`. This implementation rejects any input
 * whose length isn't a multiple of 4 before attempting to decode a single character.
 *
 * **Not similarly strict about non-canonical trailing padding bits** (`"TR=="`, whose last
 * character's low bits should be zero and aren't) -- RFC 4648 §3.5 makes rejecting those a MAY,
 * not a MUST, so those bits are simply discarded on decode, matching the JDK's own default
 * leniency there.
 */

import { TsonAtomParseError } from '../../core/errors.js';

/** Which of RFC 4648 §4's standard alphabet or §5's URL-safe alphabet a token is decoded/encoded against. */
export type Base64Alphabet = 'BASE64' | 'BASE64URL';

const STANDARD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function alphabetOf(kind: Base64Alphabet): string {
  return kind === 'BASE64' ? STANDARD_ALPHABET : URL_ALPHABET;
}

function schemeName(kind: Base64Alphabet): string {
  return kind === 'BASE64' ? 'base64' : 'base64url';
}

/** Decodes `text` against `kind`'s alphabet, per RFC 4648 §4/§5, padding required. */
export function decodeBase64(text: string, kind: Base64Alphabet, typeRef: string): Uint8Array {
  const scheme = schemeName(kind);
  if (text.length % 4 !== 0) {
    throw new TsonAtomParseError(
      typeRef,
      `'${text}' is not a valid ${scheme} encoding -- length must be a multiple of 4 once padded (RFC 4648, §5.3)`,
      `a ${scheme} encoding`,
    );
  }

  let padding = 0;
  while (padding < text.length && text.charAt(text.length - 1 - padding) === '=') {
    padding += 1;
  }
  if (padding > 2) {
    throw new TsonAtomParseError(
      typeRef,
      `'${text}' is not a valid ${scheme} encoding -- ${String(padding)} trailing padding characters is not a legal count (RFC 4648)`,
      `a ${scheme} encoding`,
    );
  }

  const alphabet = alphabetOf(kind);
  const dataLength = text.length - padding;
  const output = new Uint8Array((text.length / 4) * 3 - padding);
  let buffer = 0;
  let bitsInBuffer = 0;
  let outputIndex = 0;
  for (let i = 0; i < dataLength; i += 1) {
    const ch = text.charAt(i);
    const value = alphabet.indexOf(ch);
    if (value < 0) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid ${scheme} encoding -- '${ch}' is not in the ${scheme} alphabet (RFC 4648)`,
        `a ${scheme} encoding`,
      );
    }
    buffer = (buffer << 6) | value;
    bitsInBuffer += 6;
    if (bitsInBuffer >= 8) {
      bitsInBuffer -= 8;
      output[outputIndex] = (buffer >> bitsInBuffer) & 0xff;
      outputIndex += 1;
    }
  }
  return output;
}

/** Encodes `data` against `kind`'s alphabet, always with padding -- the exact inverse of {@link decodeBase64}'s own padding requirement. */
export function encodeBase64(data: Uint8Array, kind: Base64Alphabet): string {
  const alphabet = alphabetOf(kind);
  let out = '';
  let buffer = 0;
  let bitsInBuffer = 0;
  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bitsInBuffer += 8;
    while (bitsInBuffer >= 6) {
      bitsInBuffer -= 6;
      out += alphabet.charAt((buffer >> bitsInBuffer) & 0x3f);
    }
  }
  if (bitsInBuffer > 0) {
    out += alphabet.charAt((buffer << (6 - bitsInBuffer)) & 0x3f);
  }
  while (out.length % 4 !== 0) {
    out += '=';
  }
  return out;
}
