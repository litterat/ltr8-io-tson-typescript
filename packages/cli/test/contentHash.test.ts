/**
 * `contentHash.ts` ([TSON-DATA] §2.2.1, §7.2.2) -- checked against the real, vendored bundled
 * schemas rather than synthetic fixtures alone: each of `spec/m/{meta-kernel,meta,core}.tn`
 * already carries a real `?sha256=` pin over its own bytes (`CLAUDE.md`: "Hash pins here are real
 * digests over the bytes of this copy"), so recomputing it and comparing is a correctness check
 * this module gets for free, and a much stronger one than anything hand-written could be.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentStart, readIdDirective, sha256Hex, withSha256Pin } from '../src/contentHash.js';

const SPEC_M = join(import.meta.dirname, '../../../spec/m');

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('contentStart ([TSON-DATA] §2.2.1, §7.3)', () => {
  it('starts past the first line’s LF', () => {
    const start = contentStart(bytesOf('!!id:"a"\nrest'));
    expect(start).toBe(9);
  });

  it('starts past CRLF', () => {
    expect(contentStart(bytesOf('!!id:"a"\r\nrest'))).toBe(10);
  });

  it('starts past a lone CR', () => {
    expect(contentStart(bytesOf('!!id:"a"\rrest'))).toBe(9);
  });

  it('skips a leading BOM before scanning for the terminator', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf('!!id:"a"\nrest')]);
    expect(contentStart(withBom)).toBe(3 + 9);
  });

  it('is undefined when the first line has no terminator', () => {
    expect(contentStart(bytesOf('!!id:"a"'))).toBeUndefined();
  });
});

describe('sha256Hex ([TSON-DATA] §2.2.1)', () => {
  it('hashes every byte past the first line, not the id line itself', async () => {
    const a = await sha256Hex(bytesOf('!!id:"a"\nsame body'));
    const b = await sha256Hex(bytesOf('!!id:"totally different"\nsame body'));
    expect(a).toBe(b);
  });

  it('is 64 lowercase hex characters', async () => {
    const hex = await sha256Hex(bytesOf('!!id:"a"\nbody'));
    expect(hex).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects a document whose first line has no terminator', async () => {
    await expect(sha256Hex(bytesOf('!!id:"a"'))).rejects.toThrow(RangeError);
  });
});

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
});

describe('withSha256Pin ([TSON-DATA] §2.2.1)', () => {
  it('appends a query when the reference has none', () => {
    expect(withSha256Pin('https://example.com/s.tn', 'ab'.repeat(32))).toBe(
      `https://example.com/s.tn?sha256=${'ab'.repeat(32)}`,
    );
  });

  it('replaces an existing sha256 parameter and keeps every other one', () => {
    const out = withSha256Pin('https://example.com/s.tn?foo=1&sha256=old&bar=2', 'cd'.repeat(32));
    expect(out).toBe(`https://example.com/s.tn?foo=1&bar=2&sha256=${'cd'.repeat(32)}`);
  });
});

describe('against the real vendored schemas', () => {
  const files = ['meta-kernel.tn', 'meta.tn', 'core.tn'];

  it.each(files)('%s’s own !!id pin matches its recomputed content hash', async (file) => {
    const bytes = readFileSync(join(SPEC_M, file));
    const id = readIdDirective(bytes);
    if (id === undefined) throw new Error(`${file} carries no readable !!id`);
    const declaredPin = new URL(id.id).searchParams.get('sha256');
    const recomputed = await sha256Hex(bytes);
    expect(recomputed).toBe(declaredPin);
  });
});
