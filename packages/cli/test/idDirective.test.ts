/**
 * `idDirective.ts` ([TSON-DATA] §2.2, §7.2.2), plus the `@ltr8/tson/identity` subpath the CLI now
 * takes its hashing from -- checked against the real, vendored bundled schemas rather than
 * synthetic fixtures alone: each of `spec/m/{meta-kernel,meta,core}.tn` already carries a real
 * `?sha256=` pin over its own bytes (`CLAUDE.md`: "Hash pins here are real digests over the bytes
 * of this copy"), so recomputing it and comparing is a correctness check this gets for free, and a
 * much stronger one than anything hand-written could be. It is also the end-to-end proof that the
 * subpath is really reachable from this package rather than only from inside the library.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex, withSha256Pin } from '@ltr8/tson/identity';
import { readIdDirective } from '../src/idDirective.js';

const SPEC_M = join(import.meta.dirname, '../../../spec/m');

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('readIdDirective ([TSON-DATA] §2.2)', () => {
  it('reads a plain !!id line', () => {
    const result = readIdDirective(bytesOf('!!id:"https://example.com/s.tn"\n!!meta:"x"\n'));
    expect(result?.id).toBe('https://example.com/s.tn');
  });

  it('is undefined when the document has no !!id line', () => {
    expect(readIdDirective(bytesOf('!!meta:"x"\n{}\n'))).toBeUndefined();
  });

  it('decodes the single-character escape table (§7.2.2)', () => {
    const result = readIdDirective(bytesOf('!!id:"a\\"b\\\\c"\n'));
    expect(result?.id).toBe('a"b\\c');
  });

  it('skips a leading BOM, which is not a character of the line (§7.1)', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf('!!id:"x"\n')]);
    expect(readIdDirective(withBom)?.id).toBe('x');
  });

  it('declines a \\uXXXX escape rather than half-decoding it', () => {
    // The narrow decoder covers the fixed single-character table only. Returning undefined loses
    // the pinned-reference line; guessing would print a reference that resolves to nothing.
    expect(readIdDirective(bytesOf('!!id:"a\\u0041b"\n'))).toBeUndefined();
  });

  it('reports the byte range of the quoted value, not of the whole line', () => {
    const result = readIdDirective(bytesOf('!!id:"xy"\n'));
    expect(result?.valueStart).toBe(6);
    expect(result?.valueEnd).toBe(9);
  });
});

describe('against the real vendored schemas, through @ltr8/tson/identity', () => {
  const files = ['meta-kernel.tn', 'meta.tn', 'core.tn'];

  it.each(files)('%s’s own !!id pin matches its recomputed content hash', async (file) => {
    const bytes = readFileSync(join(SPEC_M, file));
    const id = readIdDirective(bytes);
    if (id === undefined) throw new Error(`${file} carries no readable !!id`);
    const declaredPin = new URL(id.id).searchParams.get('sha256');
    const recomputed = await sha256Hex(bytes);
    expect(recomputed).toBe(declaredPin);
  });

  it.each(files)('%s’s !!id is exactly what withSha256Pin would stamp', async (file) => {
    // The other direction: the library's pinning function reproduces the reference the vendored
    // schema already declares, so a caller stamping a hash and a caller reading one agree.
    const bytes = readFileSync(join(SPEC_M, file));
    const id = readIdDirective(bytes);
    if (id === undefined) throw new Error(`${file} carries no readable !!id`);
    const unpinned = id.id.slice(0, id.id.indexOf('?'));
    expect(withSha256Pin(unpinned, await sha256Hex(bytes))).toBe(id.id);
  });
});
