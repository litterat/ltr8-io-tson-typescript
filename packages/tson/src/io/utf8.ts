import { TsonLexError } from '../core/errors.js';
import type { Position } from '../core/position.js';
import { NEED_INPUT, type ByteInput, type Task } from './bytes.js';

/** One code point decoded from UTF-8, together with how many bytes its sequence occupied. */
export interface DecodedCodePoint {
  readonly codePoint: number;
  /** Bytes consumed from {@link ByteInput} to produce {@link codePoint} — 1 through 4. */
  readonly byteLength: number;
}

/**
 * Decodes one UTF-8 code point from `input` (§9.1), suspending on {@link NEED_INPUT} when a
 * sequence starts or continues past what has arrived. Returns `undefined` at end of input.
 *
 * `position` must be the position immediately before the sequence's own first byte — the
 * position a malformed sequence is reported at (§7.1) is exactly this one, unchanged, so a
 * caller that decodes one code point at a time from its own live cursor gets byte-exact
 * reporting for free. A caller that buffers lookahead ahead of its consumed cursor (as the
 * lexer does, up to a couple of code points) passes the position of *that* decode, which is
 * why line/column on a malformed-UTF-8 diagnostic name the cursor rather than the sequence:
 * they can be briefly behind it, the same divergence the reference implementation documents.
 *
 * Never substitutes U+FFFD — §7.1 requires a byte sequence invalid in the document's encoding
 * to be rejected, not replaced, so every one of the failure shapes below throws.
 */
export function* decodeCodePoint(
  input: ByteInput,
  position: Position,
): Task<DecodedCodePoint | undefined> {
  const first = yield* nextByte(input);
  if (first === undefined) {
    return undefined;
  }
  if (first < 0x80) {
    return { codePoint: first, byteLength: 1 };
  }

  let continuations: number;
  let codePoint: number;
  if ((first & 0xe0) === 0xc0) {
    continuations = 1;
    codePoint = first & 0x1f;
  } else if ((first & 0xf0) === 0xe0) {
    continuations = 2;
    codePoint = first & 0x0f;
  } else if ((first & 0xf8) === 0xf0) {
    continuations = 3;
    codePoint = first & 0x07;
  } else {
    // A continuation byte with nothing to continue, or a 5-/6-byte form UTF-8 has never had.
    throw malformed(position, `${hexByte(first)} is not a valid first byte of a UTF-8 sequence`);
  }

  let byteLength = 1;
  for (let i = 0; i < continuations; i++) {
    const next = yield* nextByte(input);
    if (next === undefined) {
      throw malformed(position, 'the document ends in the middle of a UTF-8 sequence');
    }
    if ((next & 0xc0) !== 0x80) {
      throw malformed(position, `${hexByte(next)} is not a UTF-8 continuation byte`);
    }
    codePoint = (codePoint << 6) | (next & 0x3f);
    byteLength++;
  }

  // The three ways a well-formed-looking sequence still is not one. Overlong forms and encoded
  // surrogates are the classic smuggling routes -- two spellings of one character, one of which
  // a validator upstream may not have seen (§9.4's confusability concern, at the encoding layer).
  const shortestForm = continuations === 1 ? 0x80 : continuations === 2 ? 0x800 : 0x10000;
  if (codePoint < shortestForm) {
    throw malformed(
      position,
      `${hexCodePoint(codePoint)} is written in ${String(continuations + 1)} bytes where UTF-8 requires the shortest form`,
    );
  }
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
    throw malformed(
      position,
      `${hexCodePoint(codePoint)} is a surrogate code point, which UTF-8 does not encode`,
    );
  }
  if (codePoint > 0x10ffff) {
    throw malformed(position, `${hexCodePoint(codePoint)} is beyond the last Unicode code point`);
  }

  return { codePoint, byteLength };
}

/**
 * A byte sequence that is not UTF-8 is rejected, not replaced (§7.1): silent U+FFFD
 * substitution would turn a broken byte inside a quoted token into content, so a document
 * that cannot be decoded would still read, with a value nobody wrote — the wrong default for
 * a format whose identity can be a hash of its bytes.
 */
function malformed(position: Position, detail: string): TsonLexError {
  return new TsonLexError(`the document is not valid UTF-8: ${detail}`, position);
}

function hexByte(byte: number): string {
  return `0x${byte.toString(16).toUpperCase().padStart(2, '0')}`;
}

function hexCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Pulls one byte, suspending on {@link NEED_INPUT} while starved; `undefined` at end of input. */
function* nextByte(input: ByteInput): Task<number | undefined> {
  while (!input.ensure()) {
    if (input.ended) {
      return undefined;
    }
    yield NEED_INPUT;
  }
  return input.read();
}

/**
 * A code point outside the Basic Multilingual Plane, encoded as valid UTF-16.
 *
 * `lo`/`hi` are UTF-16 surrogate halves; an unpaired surrogate anywhere in `text` is not a
 * scalar value and is replaced with U+FFFD, matching the WHATWG Encoding Standard's UTF-8
 * encoder (the behaviour `TextEncoder.encode` has always had, and the one this function
 * replaces it with must keep).
 */
function* scalarValues(text: string): Generator<number> {
  const { length } = text;
  for (let i = 0; i < length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < length ? text.charCodeAt(i + 1) : undefined;
      if (next !== undefined && next >= 0xdc00 && next <= 0xdfff) {
        yield 0x10000 + (unit - 0xd800) * 0x400 + (next - 0xdc00);
        i++;
        continue;
      }
      yield 0xfffd;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      yield 0xfffd;
    } else {
      yield unit;
    }
  }
}

function utf8ByteLength(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Writes one code point's UTF-8 bytes at `index`, returning the index just past them. */
function writeUtf8(bytes: Uint8Array, index: number, codePoint: number): number {
  if (codePoint < 0x80) {
    bytes[index] = codePoint;
    return index + 1;
  }
  if (codePoint < 0x800) {
    bytes[index] = 0xc0 | (codePoint >> 6);
    bytes[index + 1] = 0x80 | (codePoint & 0x3f);
    return index + 2;
  }
  if (codePoint < 0x10000) {
    bytes[index] = 0xe0 | (codePoint >> 12);
    bytes[index + 1] = 0x80 | ((codePoint >> 6) & 0x3f);
    bytes[index + 2] = 0x80 | (codePoint & 0x3f);
    return index + 3;
  }
  bytes[index] = 0xf0 | (codePoint >> 18);
  bytes[index + 1] = 0x80 | ((codePoint >> 12) & 0x3f);
  bytes[index + 2] = 0x80 | ((codePoint >> 6) & 0x3f);
  bytes[index + 3] = 0x80 | (codePoint & 0x3f);
  return index + 4;
}

/**
 * Encodes `text` as UTF-8, hand-written rather than `new TextEncoder().encode(text)` — this
 * package takes no DOM lib and no `@types/node`, so the host encoder has no ambient type here,
 * and a project whose lexer decodes UTF-8 itself is the wrong place to lean on a host decoder
 * for the inverse direction either. Behaviourally identical to `TextEncoder`: an unpaired
 * surrogate is replaced with U+FFFD rather than rejected, since a JS string that already exists
 * in memory is not a byte stream this format's UTF-8 validation rules apply to.
 *
 * Two passes over the same scalar-value sequence: the first sizes the output exactly, the
 * second writes it, so the result is one allocation rather than a grown-and-copied buffer.
 */
export function encodeUtf8(text: string): Uint8Array {
  let byteLength = 0;
  for (const codePoint of scalarValues(text)) {
    byteLength += utf8ByteLength(codePoint);
  }
  const bytes = new Uint8Array(byteLength);
  let index = 0;
  for (const codePoint of scalarValues(text)) {
    index = writeUtf8(bytes, index, codePoint);
  }
  return bytes;
}
