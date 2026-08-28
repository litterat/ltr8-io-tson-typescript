/**
 * `fileSchemaSource` -- deny-by-default host-to-directory mapping, containment checked after
 * `realpath` (so a symlink escaping the mapped directory is refused, not followed), only a
 * regular file is read, and a size cap enforced while streaming.
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fileSchemaSource } from '../src/source/fileSchemaSource.js';
import { TsonSchemaFetchError } from '../src/core/errors.js';

let dir: string | undefined;

function makeDir(): string {
  const created = mkdtempSync(join(tmpdir(), 'tson-file-source-'));
  dir = created;
  return created;
}

afterEach(() => {
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TsonSchemaFetchError) return error.reason;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('fileSchemaSource: deny by default', () => {
  it('refuses every reference when no host is mapped', async () => {
    const source = fileSchemaSource();
    expect(await reasonOf(source.fetch('https://example.com/a.tn'))).toBe('not-permitted');
  });

  it('refuses a host not mapped, matching exactly', async () => {
    const root = makeDir();
    const source = fileSchemaSource({ mapHosts: { 'schemas.example.com': root } });
    expect(await reasonOf(source.fetch('https://other.example.com/a.tn'))).toBe('not-permitted');
  });

  it('rejects a directory that does not exist, at construction', () => {
    expect(() =>
      fileSchemaSource({ mapHosts: { 'schemas.example.com': '/does/not/exist/at/all' } }),
    ).toThrow(TypeError);
  });
});

describe('fileSchemaSource: a mapped host', () => {
  it('reads the file the identity path resolves to, beneath the mapped directory', async () => {
    const root = makeDir();
    writeFileSync(join(root, 'a.tn'), '!!id:"x"\n{}\n');
    const source = fileSchemaSource({ mapHosts: { 'schemas.example.com': root } });
    const bytes = await source.fetch('https://schemas.example.com/a.tn');
    expect(new TextDecoder().decode(bytes)).toBe('!!id:"x"\n{}\n');
  });

  it('reads a nested path', async () => {
    const root = makeDir();
    mkdirSync(join(root, 'm'));
    writeFileSync(join(root, 'm', 'core.tn'), 'core');
    const source = fileSchemaSource({ mapHosts: { 'schemas.example.com': root } });
    const bytes = await source.fetch('https://schemas.example.com/m/core.tn');
    expect(new TextDecoder().decode(bytes)).toBe('core');
  });

  it('reports a missing file as not-found', async () => {
    const root = makeDir();
    const source = fileSchemaSource({ mapHosts: { 'schemas.example.com': root } });
    expect(await reasonOf(source.fetch('https://schemas.example.com/missing.tn'))).toBe(
      'not-found',
    );
  });

  it('refuses a reference naming no path at all', async () => {
    const root = makeDir();
    const source = fileSchemaSource({ mapHosts: { 'schemas.example.com': root } });
    expect(await reasonOf(source.fetch('https://schemas.example.com/'))).toBe('not-permitted');
  });

  it('refuses a directory (not a regular file)', async () => {
    const root = makeDir();
    mkdirSync(join(root, 'adir'));
    const source = fileSchemaSource({ mapHosts: { 'schemas.example.com': root } });
    expect(await reasonOf(source.fetch('https://schemas.example.com/adir'))).toBe('not-permitted');
  });
});

describe('fileSchemaSource: containment, checked after realpath', () => {
  it('refuses a symlink that escapes the mapped directory', async () => {
    const root = makeDir();
    const outside = mkdtempSync(join(tmpdir(), 'tson-file-source-outside-'));
    try {
      writeFileSync(join(outside, 'secret.tn'), 'top secret');
      symlinkSync(join(outside, 'secret.tn'), join(root, 'escape.tn'));
      const source = fileSchemaSource({ mapHosts: { 'schemas.example.com': root } });
      expect(await reasonOf(source.fetch('https://schemas.example.com/escape.tn'))).toBe(
        'not-permitted',
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a directory that realpaths to the filesystem root still serves the files under it', async () => {
    // The containment predicate is `real === root || real.startsWith(root + sep)`, and for a root
    // of '/' that second term is '//' -- which no real path begins with, so every file under it
    // was refused. It failed closed, so this was a denial rather than an escape, but a source
    // mapped to '/' that reads nothing is not the behaviour anyone configured.
    const root = makeDir();
    const target = join(root, 'schemas.tn');
    writeFileSync(target, 'served from the root');
    const viaRoot = join(root, 'slash');
    symlinkSync('/', viaRoot);
    const source = fileSchemaSource({ mapHosts: { 'schemas.example.com': viaRoot } });
    // The identity's path is the target's own absolute path, resolved beneath a root of '/'.
    const bytes = await source.fetch(`https://schemas.example.com${realpathSync(target)}`);
    expect(new TextDecoder().decode(bytes)).toBe('served from the root');
  });

  it('a symlink that resolves back inside the directory is fine', async () => {
    const root = makeDir();
    writeFileSync(join(root, 'real.tn'), 'real content');
    symlinkSync(join(root, 'real.tn'), join(root, 'alias.tn'));
    const source = fileSchemaSource({ mapHosts: { 'schemas.example.com': root } });
    const bytes = await source.fetch('https://schemas.example.com/alias.tn');
    expect(new TextDecoder().decode(bytes)).toBe('real content');
  });
});

describe('fileSchemaSource: size cap, enforced while streaming', () => {
  it('refuses a file larger than maxDocumentBytes as too-large', async () => {
    const root = makeDir();
    writeFileSync(join(root, 'big.tn'), 'x'.repeat(1000));
    const source = fileSchemaSource({
      mapHosts: { 'schemas.example.com': root },
      maxDocumentBytes: 100,
    });
    expect(await reasonOf(source.fetch('https://schemas.example.com/big.tn'))).toBe('too-large');
  });

  it('accepts a file exactly at the cap', async () => {
    const root = makeDir();
    writeFileSync(join(root, 'exact.tn'), 'x'.repeat(100));
    const source = fileSchemaSource({
      mapHosts: { 'schemas.example.com': root },
      maxDocumentBytes: 100,
    });
    const bytes = await source.fetch('https://schemas.example.com/exact.tn');
    expect(bytes.length).toBe(100);
  });
});

describe('fileSchemaSource: caching', () => {
  it('caches by canonical identity; a cache hit skips the disk but not the allow-list', async () => {
    const root = makeDir();
    writeFileSync(join(root, 'a.tn'), 'v1');
    const source = fileSchemaSource({ mapHosts: { 'schemas.example.com': root } });
    const first = await source.fetch('https://schemas.example.com/a.tn?sha256=' + 'a'.repeat(64));
    // Rewritten after the first read -- §10's immutability rule means this is the caller's own
    // mistake, and the cache is what makes the *previous* read still what a second one sees.
    writeFileSync(join(root, 'a.tn'), 'v2-should-not-be-seen');
    const second = await source.fetch('https://schemas.example.com/a.tn'); // different query, same identity
    expect(new TextDecoder().decode(first)).toBe('v1');
    expect(new TextDecoder().decode(second)).toBe('v1');
    expect(source.isCached('https://schemas.example.com/a.tn')).toBe(true);
    expect(source.isCached('https://not-mapped.example.com/a.tn')).toBe(false);
  });

  it('preload reads every reference so a later fetch finds it cached', async () => {
    const root = makeDir();
    writeFileSync(join(root, 'a.tn'), 'a');
    writeFileSync(join(root, 'b.tn'), 'b');
    const source = fileSchemaSource({ mapHosts: { 'schemas.example.com': root } });
    await source.preload(['https://schemas.example.com/a.tn', 'https://schemas.example.com/b.tn']);
    expect(source.isCached('https://schemas.example.com/a.tn')).toBe(true);
    expect(source.isCached('https://schemas.example.com/b.tn')).toBe(true);
  });
});

describe('fileSchemaSource: requireContentHashPin', () => {
  it('refuses a reference with no ?sha256= pin when required', async () => {
    const root = makeDir();
    writeFileSync(join(root, 'a.tn'), 'x');
    const source = fileSchemaSource({
      mapHosts: { 'schemas.example.com': root },
      requireContentHashPin: true,
    });
    expect(await reasonOf(source.fetch('https://schemas.example.com/a.tn'))).toBe('not-permitted');
  });
});
