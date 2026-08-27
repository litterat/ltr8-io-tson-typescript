/**
 * Adapts a web `ReadableStream<Uint8Array>` and a Node `Readable` into
 * `AsyncIterable<Uint8Array>` — the shape {@link runOver}, in `io/bytes.ts`, already knows how
 * to pump into a `ChunkInput`.
 *
 * Both platforms are handled from **one file with no platform types imported at all**, which
 * is what actually keeps them from leaking into each other: this package's type configuration
 * carries no DOM lib and no `@types/node` (see `CLAUDE.md`), so {@link ReadableByteStreamLike}
 * below is a narrow **structural** stand-in for the one WHATWG `ReadableStream` method this
 * module calls, not an import of `lib.dom.d.ts`'s real type — a real browser `ReadableStream`
 * satisfies it and can be passed here without either side referencing the other's ambient
 * globals. That claim is checked rather than asserted: `streams.test.ts` transcribes the
 * platform's own overload set and assigns a value of that type to this interface, which is the
 * only way to catch a stand-in that has quietly stopped matching what it stands in for. A Node `Readable` needs no stand-in at all: it already implements
 * `Symbol.asyncIterator` yielding `Buffer`, and `Buffer extends Uint8Array`, so it already *is*
 * an `AsyncIterable<Uint8Array>` structurally — {@link fromNodeReadable} exists only so a
 * caller never has to know which platform it is on, not because Node needs adapting.
 */

/**
 * The `ReadableStreamDefaultReader<Uint8Array>` surface {@link fromReadableStream} calls.
 *
 * `value` is spelled `?: Uint8Array | undefined` rather than `?: Uint8Array` because
 * `exactOptionalPropertyTypes` is on: the platform's own `ReadableStreamReadDoneResult` declares
 * `value?: T | undefined`, and under that flag the two are different types. Written the shorter
 * way, a real reader is not assignable here.
 */
export interface ByteStreamReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
  releaseLock(): void;
}

/**
 * The one WHATWG `ReadableStream<Uint8Array>` method {@link fromReadableStream} calls.
 *
 * The optional parameter is not decoration and is never passed. The platform declares `getReader`
 * as an overload set whose first member takes `{ mode: 'byob' }`, and a target signature taking no
 * arguments at all resolves against that one — "target signature provides too few arguments" —
 * so a real `ReadableStream` would not be assignable to this interface. Accepting an optional
 * options argument lets the no-argument overload match instead, which is the one this module uses.
 */
export interface ReadableByteStreamLike {
  getReader(options?: { readonly mode?: undefined }): ByteStreamReader;
}

/**
 * Adapts a web `ReadableStream<Uint8Array>` into an `AsyncIterable<Uint8Array>`.
 *
 * Acquires one reader for the lifetime of the iteration and releases it in a `finally`, which
 * runs whether the stream ends, the reader rejects, or the consumer stops early (a `break` out
 * of a `for await` invokes the generator's `return()`, which reaches this `finally` too) — a
 * stream is never left locked by a partial read.
 */
export async function* fromReadableStream(
  stream: ReadableByteStreamLike,
): AsyncGenerator<Uint8Array, void, void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value !== undefined && value.length > 0) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * A Node `Readable` is already `AsyncIterable<Uint8Array>` (its default, non-object-mode
 * iteration yields `Buffer`, and `Buffer extends Uint8Array`) — this is the identity function,
 * kept so call sites read symmetrically with {@link fromReadableStream} regardless of platform.
 */
export function fromNodeReadable(readable: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  return readable;
}
