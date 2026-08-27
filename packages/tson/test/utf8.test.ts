import { describe, expect, it } from 'vitest';

import { TsonLexError } from '../src/core/errors.js';
import { position, type Position } from '../src/core/position.js';
import {
  chunkInput,
  fromBytes,
  runAsync,
  runSync,
  type ByteInput,
  type Task,
} from '../src/io/bytes.js';
import { decodeCodePoint, encodeUtf8, type DecodedCodePoint } from '../src/io/utf8.js';

const HERE: Position = position(3, 12, 47);

/** Decodes exactly one code point at {@link HERE}, driven synchronously over complete input. */
function decodeOne(bytes: number[]): DecodedCodePoint | undefined {
  return runSync(decodeCodePoint(fromBytes(new Uint8Array(bytes)), HERE));
}

/** Decodes every code point in `bytes`, driven synchronously, returning the code points alone. */
function decodeAll(bytes: number[]): number[] {
  const input = fromBytes(new Uint8Array(bytes));
  return runSync(decodeAllTask(input));
}

function* decodeAllTask(input: ByteInput): Task<number[]> {
  const out: number[] = [];
  for (;;) {
    const decoded = yield* decodeCodePoint(input, HERE);
    if (decoded === undefined) return out;
    out.push(decoded.codePoint);
  }
}

describe('decodeCodePoint — well-formed sequences (§9.1)', () => {
  it('decodes end of input as undefined, never -1 or a thrown error', () => {
    expect(decodeOne([])).toBeUndefined();
  });

  it('decodes a 1-byte ASCII sequence', () => {
    expect(decodeOne([0x41])).toEqual({ codePoint: 0x41, byteLength: 1 });
  });

  it('decodes a 2-byte sequence (U+00E9, "é")', () => {
    expect(decodeOne([0xc3, 0xa9])).toEqual({ codePoint: 0xe9, byteLength: 2 });
  });

  it('decodes a 3-byte sequence (U+4E2D, "中")', () => {
    expect(decodeOne([0xe4, 0xb8, 0xad])).toEqual({ codePoint: 0x4e2d, byteLength: 3 });
  });

  it('decodes a 4-byte sequence (U+1F600, an astral emoji)', () => {
    expect(decodeOne([0xf0, 0x9f, 0x98, 0x80])).toEqual({ codePoint: 0x1f600, byteLength: 4 });
  });

  it('decodes the last valid code point, U+10FFFF', () => {
    expect(decodeOne([0xf4, 0x8f, 0xbf, 0xbf])).toEqual({ codePoint: 0x10ffff, byteLength: 4 });
  });

  it('decodes a run of mixed-width sequences in order', () => {
    // "A" (1 byte) + "é" (2 bytes) + U+1F600 (4 bytes).
    expect(decodeAll([0x41, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80])).toEqual([0x41, 0xe9, 0x1f600]);
  });
});

describe('decodeCodePoint — malformed sequences, never substituted with U+FFFD (§7.1)', () => {
  it('rejects a bad lead byte (a continuation byte with nothing to continue)', () => {
    expect(() => decodeOne([0x80])).toThrow(TsonLexError);
    expect(() => decodeOne([0x80])).toThrow(/not a valid first byte/);
  });

  it('rejects a lead byte for a form UTF-8 has never had (5-byte)', () => {
    expect(() => decodeOne([0xf8, 0x80, 0x80, 0x80, 0x80])).toThrow(/not a valid first byte/);
  });

  it('rejects a bad continuation byte', () => {
    expect(() => decodeOne([0xc3, 0x00])).toThrow(/not a UTF-8 continuation byte/);
  });

  it('rejects a sequence truncated by end of input', () => {
    expect(() => decodeOne([0xe4, 0xb8])).toThrow(/ends in the middle of a UTF-8 sequence/);
  });

  it('rejects an overlong 2-byte encoding of NUL (the classic smuggling form)', () => {
    expect(() => decodeOne([0xc0, 0x80])).toThrow(/requires the shortest form/);
  });

  it('rejects an overlong 3-byte encoding', () => {
    expect(() => decodeOne([0xe0, 0x80, 0x80])).toThrow(/requires the shortest form/);
  });

  it('rejects an overlong 4-byte encoding', () => {
    expect(() => decodeOne([0xf0, 0x80, 0x80, 0x80])).toThrow(/requires the shortest form/);
  });

  it('rejects an encoded surrogate code point', () => {
    // U+D800, the first UTF-16 surrogate, encoded (invalidly) as 3 UTF-8 bytes.
    expect(() => decodeOne([0xed, 0xa0, 0x80])).toThrow(/surrogate code point/);
  });

  it('rejects a value above U+10FFFF', () => {
    expect(() => decodeOne([0xf4, 0x90, 0x80, 0x80])).toThrow(/beyond the last Unicode code point/);
  });

  it('reports the offending sequence at the position passed in, not a re-derived one', () => {
    try {
      decodeOne([0x80]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TsonLexError);
      expect((error as TsonLexError).position).toEqual(HERE);
    }
  });
});

describe('decodeCodePoint — chunked input suspends rather than starving (§7.1)', () => {
  it('resumes a sequence split across chunk boundaries, one byte at a time', async () => {
    const input = chunkInput();
    const result = runAsync(decodeCodePoint(input, HERE), input);
    for (const byte of [0xf0, 0x9f, 0x98, 0x80]) input.push(new Uint8Array([byte]));
    input.end();
    await expect(result).resolves.toEqual({ codePoint: 0x1f600, byteLength: 4 });
  });

  it('still rejects a malformed sequence once enough of it has arrived', async () => {
    const input = chunkInput();
    const result = runAsync(decodeCodePoint(input, HERE), input);
    input.push(new Uint8Array([0xe4]));
    input.push(new Uint8Array([0x00]));
    input.end();
    await expect(result).rejects.toThrow(TsonLexError);
  });
});

describe('encodeUtf8 — the inverse direction, hand-written rather than TextEncoder', () => {
  it('round-trips ASCII', () => {
    expect(encodeUtf8('Hi')).toEqual(new Uint8Array([0x48, 0x69]));
  });

  it('round-trips every valid width decodeCodePoint accepts', () => {
    const cases: readonly (readonly [string, readonly number[]])[] = [
      ['é', [0xc3, 0xa9]],
      ['中', [0xe4, 0xb8, 0xad]],
      ['\u{1f600}', [0xf0, 0x9f, 0x98, 0x80]],
      ['\u{10ffff}', [0xf4, 0x8f, 0xbf, 0xbf]],
    ];
    for (const [text, bytes] of cases) {
      expect(encodeUtf8(text)).toEqual(new Uint8Array(bytes));
      // decodeCodePoint agrees with encodeUtf8 on the same bytes -- the two halves of this
      // module are each other's check.
      expect(decodeAll([...bytes])).toEqual([text.codePointAt(0)]);
    }
  });

  it('replaces an unpaired high surrogate with U+FFFD, matching TextEncoder', () => {
    expect(encodeUtf8('\uD800')).toEqual(new Uint8Array([0xef, 0xbf, 0xbd]));
  });

  it('replaces an unpaired low surrogate with U+FFFD, matching TextEncoder', () => {
    expect(encodeUtf8('\uDC00')).toEqual(new Uint8Array([0xef, 0xbf, 0xbd]));
  });

  it('encodes a valid surrogate pair as one 4-byte sequence, not two replacements', () => {
    expect(encodeUtf8('\u{1F600}')).toEqual(new Uint8Array([0xf0, 0x9f, 0x98, 0x80]));
  });

  it('encodes the empty string as zero bytes', () => {
    expect(encodeUtf8('')).toEqual(new Uint8Array());
  });
});
