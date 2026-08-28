/**
 * The one input shape every flat front-door function (`parse`/`readTree`/`validate`) accepts,
 * and the dispatch between this package's own sync/async `Task` drivers (`io/bytes.ts`,
 * `io/drivers.ts`) that shape implies -- kept here rather than duplicated in each facade module,
 * per `CLAUDE.md`'s "streaming is non-negotiable": every flat function is one `Task` away from
 * running over chunked input, never a second, buffering-first implementation.
 */
import { fromBytes, runOver, runSync, type ByteInput, type Task } from '../io/bytes.js';
import { runOverReadableStream } from '../io/drivers.js';
import type { ReadableByteStreamLike } from '../io/streams.js';

/**
 * A complete in-memory document, a web `ReadableStream<Uint8Array>`, or any other
 * `AsyncIterable<Uint8Array>` (a Node `Readable` included, since it already satisfies that shape
 * structurally -- `io/streams.ts`'s own note). `Uint8Array` reads synchronously; either streaming
 * shape reads asynchronously, which is why every flat function below is overloaded on this type
 * rather than always returning a `Promise`.
 */
export type ByteSource = Uint8Array | AsyncIterable<Uint8Array> | ReadableByteStreamLike;

/** A source that must be read asynchronously -- the two non-`Uint8Array` members of {@link ByteSource}. */
export type AsyncByteSource = Exclude<ByteSource, Uint8Array>;

function isReadableByteStreamLike(source: AsyncByteSource): source is ReadableByteStreamLike {
  return typeof (source as { getReader?: unknown }).getReader === 'function';
}

/** Runs `makeTask` synchronously over `source`. */
export function runOverBytes<T>(source: Uint8Array, makeTask: (input: ByteInput) => Task<T>): T {
  return runSync(makeTask(fromBytes(source)));
}

/** Runs `makeTask` over `source`, pumping it as it arrives -- the async counterpart of {@link runOverBytes}, dispatching on which streaming shape `source` is. */
export function runOverAsyncSource<T>(
  source: AsyncByteSource,
  makeTask: (input: ByteInput) => Task<T>,
): Promise<T> {
  return isReadableByteStreamLike(source)
    ? runOverReadableStream(source, makeTask)
    : runOver(source, makeTask);
}
