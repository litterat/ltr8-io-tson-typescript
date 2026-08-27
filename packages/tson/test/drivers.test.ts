import { describe, expect, it } from 'vitest';

import { NEED_INPUT, type ByteInput, type Task } from '../src/io/bytes.js';
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
