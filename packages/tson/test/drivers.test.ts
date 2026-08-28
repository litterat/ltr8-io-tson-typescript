import { describe, expect, it } from 'vitest';

import { NEED_INPUT, type ByteInput, type Task } from '../src/io/bytes.js';
import { runOver } from '../src/io/bytes.js';
import { runOverNodeReadable, runOverReadableStream } from '../src/io/drivers.js';
import type { ByteStreamReader, ReadableByteStreamLike } from '../src/io/streams.js';

/** Drains every byte, suspending whenever the input starves -- the shape every reader has. */
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

describe('runOverReadableStream', () => {
  it('drives a Task to completion over a web ReadableStream<Uint8Array>', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
    let index = 0;
    const reader: ByteStreamReader = {
      read(): Promise<{ done: boolean; value?: Uint8Array }> {
        if (index >= chunks.length) return Promise.resolve({ done: true });
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- index is in range, checked above.
        const value = chunks[index]!;
        index += 1;
        return Promise.resolve({ done: false, value });
      },
      releaseLock(): void {
        /* no-op */
      },
    };
    const stream: ReadableByteStreamLike = { getReader: () => reader };
    await expect(runOverReadableStream(stream, readAll)).resolves.toEqual([1, 2, 3]);
  });
});

describe('runOverNodeReadable', () => {
  it('drives a Task to completion over an async-iterable source', async () => {
    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1]);
      await Promise.resolve();
      yield new Uint8Array([2, 3]);
    }
    await expect(runOverNodeReadable(source(), readAll)).resolves.toEqual([1, 2, 3]);
  });
});

describe('runOver pulls on demand, one chunk per suspension', () => {
  /** Reads exactly `count` bytes and stops -- a task that finishes long before its input does. */
  function readSome(count: number): (input: ByteInput) => Task<number[]> {
    return function* (input: ByteInput): Task<number[]> {
      const out: number[] = [];
      while (out.length < count) {
        while (!input.ensure()) {
          if (input.ended) return out;
          yield NEED_INPUT;
        }
        out.push(input.read());
      }
      return out;
    };
  }

  /** An async source that records how many chunks were actually pulled from it. */
  function countingSource(chunks: number): {
    source: () => AsyncGenerator<Uint8Array>;
    pulled: () => number;
    returned: () => boolean;
  } {
    let pulled = 0;
    let returned = false;
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        for (let i = 0; i < chunks; i++) {
          pulled++;
          await Promise.resolve();
          yield new Uint8Array([i & 0xff]);
        }
      } finally {
        returned = true;
      }
    }
    return { source, pulled: () => pulled, returned: () => returned };
  }

  it('does not run ahead of the task -- a fast producer cannot queue a whole document', async () => {
    // `CLAUDE.md`: "memory is proportional to nesting depth". A concurrent pump loop pushing every
    // chunk as fast as the source yields them buffers the entire input regardless of what the
    // parser has consumed, which makes that claim false for every streaming read.
    const { source, pulled } = countingSource(1000);
    await expect(runOver(source(), readSome(3))).resolves.toEqual([0, 1, 2]);
    expect(pulled()).toBeLessThanOrEqual(4);
  });

  it("closes the source when the task finishes early, so a producer's finally runs", async () => {
    // For a ReadableStream this is what releases the reader lock; for a generator it is what runs
    // whatever cleanup the producer wrote.
    const { source, pulled, returned } = countingSource(1000);
    await runOver(source(), readSome(1));
    expect(returned()).toBe(true);
    // Both halves matter: draining the source to its end would also run the `finally`, and would
    // also be the bug. Closing means stopping.
    expect(pulled()).toBeLessThan(1000);
  });

  it('still reads a source to its end when the task wants all of it', async () => {
    const { source, pulled } = countingSource(5);
    await expect(runOver(source(), readAll)).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(pulled()).toBe(5);
  });

  it('propagates a source error to the caller', async () => {
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1]);
      await Promise.resolve();
      throw new Error('the socket died');
    }
    await expect(runOver(failing(), readAll)).rejects.toThrow('the socket died');
  });
});
