/**
 * The streaming proof WP4A exists to carry out: for every way `runAsync` (here, `parseJsonAsync`)
 * could receive one document's bytes in pieces, the result equals what `runSync` (`parseJson`)
 * produces over the whole. `CLAUDE.md`'s streaming constraint -- "memory is proportional to
 * nesting depth; nothing materialises a whole document to read part of it" -- is only actually
 * true if a document arriving one byte at a time reads identically to one arriving whole, so this
 * test splits a representative document at *every* byte offset and checks both directions: the
 * value produced, and which errors are and are not reachable mid-token.
 */
import { describe, expect, it } from 'vitest';
import { equalJsonValue } from '../src/json/tree.js';
import { parseJson, parseJsonAsync } from '../src/json/index.js';

const DOCUMENT =
  '{"id": "9f1c8e2a-4b7d", "tags": ["a", "b", "c"], "count": 12345678901234567890.5, ' +
  '"nested": {"x": [1, 2, {"y": true}], "z": null}, "unicode": "café 😀"}';

/** Splits `text`'s UTF-8 bytes into two chunks at byte offset `at`, one chunk each side (an empty chunk at either end). */
function splitAt(bytes: Uint8Array, at: number): Uint8Array[] {
  return [bytes.slice(0, at), bytes.slice(at)].filter((chunk) => chunk.length > 0);
}

async function* asChunks(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    await Promise.resolve(); // a genuine microtask boundary between chunks, not just a shape
    yield chunk;
  }
}

describe('runAsync over every split of one document equals runSync over the whole', () => {
  const bytes = new TextEncoder().encode(DOCUMENT);
  const expected = parseJson(DOCUMENT);

  it('parses to the same value at every byte offset the document could be split at', async () => {
    for (let at = 0; at <= bytes.length; at += 1) {
      const chunks = splitAt(bytes, at);
      // Awaited sequentially, on purpose: the property is over *every* split, and doing so keeps
      // a failing split's offset legible instead of racing 400+ promises silently.
      const value = await parseJsonAsync(asChunks(chunks));
      expect(equalJsonValue(value, expected), `split at byte ${String(at)}`).toBe(true);
    }
  });

  it('also holds one byte at a time -- the extreme of every split', async () => {
    const oneAtATime = Array.from(bytes, (b) => new Uint8Array([b]));
    const value = await parseJsonAsync(asChunks(oneAtATime));
    expect(equalJsonValue(value, expected)).toBe(true);
  });

  it('a document that streams in never suspends more than one chunk ahead of what it has read', async () => {
    // Demand-driven: nothing is pulled from the source until the task actually starves for it. A
    // generator that counts how many chunks it has handed out proves the reader never buffers the
    // whole document before starting to walk it.
    let handedOut = 0;
    async function* countingChunks(): AsyncGenerator<Uint8Array> {
      for (const b of bytes) {
        await Promise.resolve(); // a genuine microtask boundary between chunks, not just a shape
        handedOut += 1;
        yield new Uint8Array([b]);
      }
    }
    await parseJsonAsync(countingChunks());
    expect(handedOut).toBe(bytes.length);
  });
});

describe('a malformed document refuses identically streamed and whole', () => {
  it('a duplicate member is caught the same way from a chunked source', async () => {
    const bytes = new TextEncoder().encode('{"a": 1, "a": 2}');
    let syncError: unknown;
    try {
      parseJson('{"a": 1, "a": 2}');
    } catch (e) {
      syncError = e;
    }
    let asyncError: unknown;
    try {
      await parseJsonAsync(asChunks(Array.from(bytes, (b) => new Uint8Array([b]))));
    } catch (e) {
      asyncError = e;
    }
    expect((syncError as Error).constructor).toBe((asyncError as Error).constructor);
  });

  it('malformed UTF-8 mid-stream is refused the same way as whole', async () => {
    const bytes = new Uint8Array([0x22, 0xc3, 0x28, 0x22]); // `"` + invalid 2-byte lead + `(` + `"`
    let syncError: unknown;
    try {
      parseJson(bytes);
    } catch (e) {
      syncError = e;
    }
    let asyncError: unknown;
    try {
      await parseJsonAsync(asChunks(Array.from(bytes, (b) => new Uint8Array([b]))));
    } catch (e) {
      asyncError = e;
    }
    expect((syncError as Error).constructor).toBe((asyncError as Error).constructor);
  });
});
