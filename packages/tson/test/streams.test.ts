import { describe, expect, it } from 'vitest';

import {
  fromNodeReadable,
  fromReadableStream,
  type ByteStreamReader,
  type ReadableByteStreamLike,
} from '../src/io/streams.js';

/** A minimal fake satisfying {@link ReadableByteStreamLike} structurally, no DOM lib needed. */
function fakeStream(chunks: readonly Uint8Array[]): {
  readonly stream: ReadableByteStreamLike;
  readonly releaseCalls: number[];
} {
  const releaseCalls: number[] = [];
  let index = 0;
  const reader: ByteStreamReader = {
    read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (index >= chunks.length) {
        return Promise.resolve({ done: true });
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- index is in range, checked above.
      const value = chunks[index]!;
      index += 1;
      return Promise.resolve({ done: false, value });
    },
    releaseLock(): void {
      releaseCalls.push(index);
    },
  };
  return { stream: { getReader: () => reader }, releaseCalls };
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<number[][]> {
  const out: number[][] = [];
  for await (const chunk of source) out.push([...chunk]);
  return out;
}

describe('fromReadableStream — a web ReadableStream<Uint8Array> as AsyncIterable', () => {
  it('yields each chunk in order', async () => {
    const { stream } = fakeStream([new Uint8Array([1, 2]), new Uint8Array([3])]);
    await expect(collect(fromReadableStream(stream))).resolves.toEqual([[1, 2], [3]]);
  });

  it('yields nothing for an immediately-done stream', async () => {
    const { stream } = fakeStream([]);
    await expect(collect(fromReadableStream(stream))).resolves.toEqual([]);
  });

  it('skips a zero-length chunk rather than yielding an empty array', async () => {
    const { stream } = fakeStream([new Uint8Array([]), new Uint8Array([9])]);
    await expect(collect(fromReadableStream(stream))).resolves.toEqual([[9]]);
  });

  it('releases the reader once the stream ends', async () => {
    const { stream, releaseCalls } = fakeStream([new Uint8Array([1])]);
    await collect(fromReadableStream(stream));
    expect(releaseCalls).toHaveLength(1);
  });

  it('releases the reader when the consumer stops iterating early', async () => {
    const { stream, releaseCalls } = fakeStream([new Uint8Array([1]), new Uint8Array([2])]);
    for await (const _chunk of fromReadableStream(stream)) {
      break;
    }
    expect(releaseCalls).toHaveLength(1);
  });

  it('releases the reader even when a read rejects', async () => {
    const releaseCalls: number[] = [];
    const reader: ByteStreamReader = {
      read: () => Promise.reject(new Error('stream broke')),
      releaseLock: () => releaseCalls.push(1),
    };
    const stream: ReadableByteStreamLike = { getReader: () => reader };
    await expect(collect(fromReadableStream(stream))).rejects.toThrow('stream broke');
    expect(releaseCalls).toHaveLength(1);
  });
});

describe('fromNodeReadable — a Node Readable is already AsyncIterable<Uint8Array>', () => {
  it('is the identity function', () => {
    const readable: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }),
    };
    expect(fromNodeReadable(readable)).toBe(readable);
  });
});
