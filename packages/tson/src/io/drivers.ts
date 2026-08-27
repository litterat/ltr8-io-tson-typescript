/**
 * Convenience drivers over the platform stream adapters in `io/streams.ts`, so a caller with a
 * web `ReadableStream` or a Node `Readable` never has to reach for {@link chunkInput}/
 * {@link runAsync} directly. Each is `runOver` (`io/bytes.ts`) pre-composed with one adapter —
 * `runOver` already owns pumping a `ChunkInput` from an `AsyncIterable<Uint8Array>` and
 * propagating a source error through to the caller, so these add nothing but the adapter.
 */
import { runOver, type ByteInput, type Task } from './bytes.js';
import { fromNodeReadable, fromReadableStream, type ReadableByteStreamLike } from './streams.js';

/** Runs a {@link Task} over a web `ReadableStream<Uint8Array>`, start to finish. */
export function runOverReadableStream<T>(
  stream: ReadableByteStreamLike,
  makeTask: (input: ByteInput) => Task<T>,
): Promise<T> {
  return runOver(fromReadableStream(stream), makeTask);
}

/** Runs a {@link Task} over a Node `Readable` (or any `AsyncIterable<Uint8Array>`), start to finish. */
export function runOverNodeReadable<T>(
  readable: AsyncIterable<Uint8Array>,
  makeTask: (input: ByteInput) => Task<T>,
): Promise<T> {
  return runOver(fromNodeReadable(readable), makeTask);
}
