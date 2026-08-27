import { describe, expect, it } from 'vitest';
import {
  NEED_INPUT,
  chunkInput,
  fromBytes,
  fromString,
  runAsync,
  runOver,
  runSync,
  type ByteInput,
  type Task,
} from '../src/io/bytes.js';
import { TsonInternalError } from '../src/core/errors.js';

/** Drain every byte, suspending whenever the input starves. The shape every reader has. */
function* readAll(input: ByteInput): Task<number[]> {
  const out: number[] = [];
  for (;;) {
    while (!input.ensure()) {
      if (input.ended) return out;
      yield NEED_INPUT;
    }
    out.push(input.read());
  }
}

describe('ByteInput over a complete buffer', () => {
  it('reports ended from construction, so a task over it never suspends (§7.1)', () => {
    expect(runSync(readAll(fromBytes(new Uint8Array([1, 2, 3]))))).toEqual([1, 2, 3]);
  });

  it('yields an empty result for empty input rather than suspending', () => {
    expect(runSync(readAll(fromBytes(new Uint8Array())))).toEqual([]);
  });

  it('encodes a string as UTF-8, not UTF-16 code units', () => {
    // U+1F600 is one code point, two UTF-16 units, and four UTF-8 bytes. Anything that
    // measures this string by `.length` sees 2 and is wrong.
    const bytes = runSync(readAll(fromString('\u{1F600}')));
    expect(bytes).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  it('reading past the end is an internal fault, never a silent undefined', () => {
    const input = fromBytes(new Uint8Array([7]));
    expect(input.ensure()).toBe(true);
    expect(input.read()).toBe(7);
    expect(input.ensure()).toBe(false);
    expect(() => input.read()).toThrow(TsonInternalError);
  });
});

describe('runSync', () => {
  it('refuses a task that suspends, because complete input must never starve mid-document', () => {
    function* suspends(): Task<number> {
      yield NEED_INPUT;
      return 1;
    }
    expect(() => runSync(suspends())).toThrow(TsonInternalError);
  });
});

describe('ChunkInput and runAsync', () => {
  it('resumes across chunk boundaries and returns the whole stream', async () => {
    const input = chunkInput();
    const task = readAll(input);
    const result = runAsync(task, input);
    input.push(new Uint8Array([1, 2]));
    input.push(new Uint8Array([3]));
    input.end();
    await expect(result).resolves.toEqual([1, 2, 3]);
  });

  it('splits a multi-byte code point across chunks without loss', async () => {
    const input = chunkInput();
    const result = runAsync(readAll(input), input);
    // The four bytes of U+1F600, arriving one at a time.
    for (const byte of [0xf0, 0x9f, 0x98, 0x80]) input.push(new Uint8Array([byte]));
    input.end();
    await expect(result).resolves.toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  it('an empty chunk is not an end-of-stream signal', async () => {
    const input = chunkInput();
    const result = runAsync(readAll(input), input);
    input.push(new Uint8Array());
    input.push(new Uint8Array([9]));
    input.end();
    await expect(result).resolves.toEqual([9]);
  });
});

describe('runOver', () => {
  it('drives a task from an async source', async () => {
    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1]);
      await Promise.resolve();
      yield new Uint8Array([2, 3]);
    }
    await expect(runOver(source(), readAll)).resolves.toEqual([1, 2, 3]);
  });
});
