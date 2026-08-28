/**
 * `parse` (§2, §7.4): synchronous over a complete `Uint8Array`, asynchronous over a streaming
 * source -- both paths must agree, and neither is schema-aware.
 */
import { describe, expect, it } from 'vitest';

import { parse } from '../src/facade/parse.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

async function* chunksOf(text: string, size: number): AsyncGenerator<Uint8Array> {
  const bytes = bytesOf(text);
  await Promise.resolve();
  for (let i = 0; i < bytes.length; i += size) {
    yield bytes.subarray(i, i + size);
  }
}

describe('parse', () => {
  it('parses a complete Uint8Array synchronously into a Document AST', () => {
    const result = parse(bytesOf('{ x: 1 y: "two" }'));
    expect(result.document.root.coreValue.kind).toBe('record');
    if (result.document.root.coreValue.kind !== 'record') throw new Error('unreachable');
    expect(result.document.root.coreValue.fields.map((f) => f.name)).toEqual(['x', 'y']);
  });

  it('records each CoreValue’s own start position', () => {
    const result = parse(bytesOf('{ x: 1 }'));
    const position = result.positions.get(result.document.root.coreValue);
    expect(position).toBeDefined();
  });

  it('parses an async-iterable byte source, chunked arbitrarily, to the identical result', async () => {
    const whole = parse(bytesOf('{ x: 1 y: [1 2 3] }'));
    const chunked = await parse(chunksOf('{ x: 1 y: [1 2 3] }', 3));
    expect(chunked.document).toEqual(whole.document);
  });

  it('throws a structural error for malformed input, synchronously', () => {
    expect(() => parse(bytesOf('{ x: '))).toThrow();
  });
});
