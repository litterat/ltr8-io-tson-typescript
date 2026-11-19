/**
 * `write` -- the inverse of `readTree`, canonical form, with and without a `!!id`/`!!schema`
 * header.
 */
import { describe, expect, it } from 'vitest';

import { write } from '../src/facade/write.js';
import { readTree } from '../src/facade/tree.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('write', () => {
  it('writes a plain Value with no header, round-tripping readTree', () => {
    const value = readTree(bytesOf('{ x: 1 y: "two" }'));
    expect(write(value)).toBe('{ x: 1 y: "two" }');
  });

  it('writes the !!id header when options.id is given', () => {
    const value = readTree(bytesOf('1'));
    expect(write(value, { id: 'https://example.com/a' })).toBe('!!id:"https://example.com/a"\n1');
  });

  it('writes one !!import header per options.imports entry, in order, over a root value carrying its own type-ref (§2.2)', () => {
    const value = readTree(bytesOf('!x 1'), { preserveUnknownTypeRefs: true });
    expect(
      write(value, { imports: ['https://example.com/a.tn', 'https://example.com/b.tn'] }),
    ).toBe('!!import:"https://example.com/a.tn"\n!!import:"https://example.com/b.tn"\n!x 1');
  });

  it('round-trips through readTree a second time', () => {
    const value = readTree(bytesOf('[1 2 3]'));
    const text = write(value);
    expect(readTree(bytesOf(text))).toEqual(value);
  });
});
