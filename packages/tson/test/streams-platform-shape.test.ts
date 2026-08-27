import { describe, expect, it } from 'vitest';
import { fromReadableStream, type ReadableByteStreamLike } from '../src/io/streams.js';

/**
 * The platform's own declarations, transcribed from `lib.dom.d.ts`.
 *
 * This package carries no DOM lib on purpose, so nothing else in the suite can tell whether the
 * structural stand-in in `io/streams.ts` still matches what it stands in for. Every other test
 * here builds a hand-rolled object literal, which satisfies the stand-in by construction and so
 * can never catch it drifting — that is exactly how a version shipped where no real
 * `ReadableStream` was assignable to it at all.
 */
interface PlatformGetReaderOptions {
  mode?: 'byob';
}
interface PlatformBYOBReader {
  readonly __byob: true;
}
interface PlatformReadValueResult<T> {
  done: false;
  value: T;
}
interface PlatformReadDoneResult<T> {
  done: true;
  value?: T | undefined;
}
interface PlatformDefaultReader<R> {
  read(): Promise<PlatformReadValueResult<R> | PlatformReadDoneResult<R>>;
  releaseLock(): void;
}
interface PlatformReadableStream<R> {
  getReader(options: { mode: 'byob' }): PlatformBYOBReader;
  getReader(): PlatformDefaultReader<R>;
  getReader(options?: PlatformGetReaderOptions): PlatformDefaultReader<R> | PlatformBYOBReader;
}

describe('the ReadableStream stand-in matches the real platform type', () => {
  it('accepts a value declared with the platform overload set', () => {
    // The assignment is the assertion: this file does not compile if the stand-in drifts, and
    // `npm run typecheck` covers this project.
    const accepts = (stream: ReadableByteStreamLike): ReadableByteStreamLike => stream;
    const platform = null as unknown as PlatformReadableStream<Uint8Array>;
    expect(accepts(platform)).toBe(platform);
  });

  it('reads a stream built the way the platform builds one', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
    let index = 0;
    const platform: PlatformReadableStream<Uint8Array> = {
      getReader: ((): PlatformDefaultReader<Uint8Array> => ({
        read: () =>
          Promise.resolve(
            index < chunks.length
              ? { done: false as const, value: chunks[index++] as Uint8Array }
              : { done: true as const },
          ),
        releaseLock: () => undefined,
      })) as PlatformReadableStream<Uint8Array>['getReader'],
    };

    const seen: number[] = [];
    for await (const chunk of fromReadableStream(platform)) {
      seen.push(...chunk);
    }
    expect(seen).toEqual([1, 2, 3]);
  });
});
