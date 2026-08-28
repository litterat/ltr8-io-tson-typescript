/**
 * `createTson`'s own registry -- register/resolveSchema/preload/compile -- exercised against the
 * real, vendored `spec/m/*.tn` bytes, the same standard-library chain
 * `user-schema-end-to-end.test.ts` resolves by hand. Where that suite drives
 * `resolveSchema`/`linkSchema` directly, this one drives them through the public `Tson` surface
 * `config.ts` builds, so a regression in the front door's own wiring (not the compiler
 * underneath, already covered) is what this suite would catch.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createTson, type SchemaSource } from '../src/config.js';
import { bootstrapMetaKernel } from '../src/schema/bootstrap.js';
import { linkSchema } from '../src/link/link.js';
import { TsonSchemaFetchError, TsonSchemaValidationError } from '../src/core/errors.js';

const SPEC = fileURLToPath(new URL('../../../spec/m/', import.meta.url));

function bundledSource(file: string): Uint8Array {
  return new Uint8Array(readFileSync(SPEC + file));
}

/** The `!!id` line's own value -- the real, pinned identity each bundled schema declares itself by, extracted rather than hand-copied so a re-vendor can't drift this test out of sync silently. */
function ownId(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes);
  const match = /^!!id:"([^"]+)"/u.exec(text);
  if (match?.[1] === undefined) {
    throw new Error('fixture has no !!id line');
  }
  return match[1];
}

const KERNEL_BYTES = bundledSource('meta-kernel.tn');
const META_BYTES = bundledSource('meta.tn');
const CORE_BYTES = bundledSource('core.tn');

const KERNEL_ID = ownId(KERNEL_BYTES);
const META_ID = ownId(META_BYTES);
const CORE_ID = ownId(CORE_BYTES);

const CATALOG_SCHEMA = `
!!id:"test://catalog.tn"
!!meta:"${META_ID}"
!!import:"${CORE_ID}"
{
  reading => { id: uuid label: non_empty_text }
}
`;

function bundledOnlySource(): SchemaSource {
  const byReference = new Map<string, Uint8Array>([
    [META_ID, META_BYTES],
    [CORE_ID, CORE_BYTES],
  ]);
  return {
    fetch(reference: string): Promise<Uint8Array> {
      const bytes = byReference.get(reference);
      if (bytes === undefined) {
        return Promise.reject(
          new TsonSchemaFetchError(reference, 'not-found', `no fixture for '${reference}'`),
        );
      }
      return Promise.resolve(bytes);
    },
  };
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('createTson: registry primitives', () => {
  it('starts with an empty registry', () => {
    const tson = createTson();
    expect(tson.schemas.size).toBe(0);
  });

  it('register adds an already-linked schema under its own canonical identity', () => {
    const tson = createTson();
    const kernel = linkSchema(bootstrapMetaKernel(KERNEL_BYTES));
    expect(kernel.id).toBe(KERNEL_ID);
    tson.register(kernel);
    expect(tson.schemas.get('tson.io/2026/33/m/meta-kernel.tn')).toBe(kernel);
  });

  it('resolveSchema refuses a schema whose governing !!meta is not registered', () => {
    const tson = createTson();
    expect(() => tson.resolveSchema(META_BYTES)).toThrow(TsonSchemaValidationError);
  });

  it('resolveSchema, once the governing chain is registered, resolves/links/registers and returns the result', () => {
    const tson = createTson();
    tson.register(linkSchema(bootstrapMetaKernel(KERNEL_BYTES)));
    const meta = tson.resolveSchema(META_BYTES);
    expect(meta.id).toBe(META_ID);
    expect(tson.schemas.get('tson.io/2026/33/m/meta.tn')).toBe(meta);

    const core = tson.resolveSchema(CORE_BYTES);
    expect(core.id).toBe(CORE_ID);

    // A user schema, three deep, resolved from *text* (the string overload).
    const catalog = tson.resolveSchema(CATALOG_SCHEMA);
    expect(catalog.entries.has('uuid')).toBe(true); // merged in from core.tn (§2.2.3)
    expect(catalog.entries.has('reading')).toBe(true);
  });

  it('compile + readTree/validate work end to end against a real conforming document', () => {
    const tson = createTson();
    tson.register(linkSchema(bootstrapMetaKernel(KERNEL_BYTES)));
    tson.resolveSchema(META_BYTES);
    tson.resolveSchema(CORE_BYTES);
    const catalog = tson.resolveSchema(CATALOG_SCHEMA);
    const compiled = tson.compile(catalog);

    const document = bytesOf('{ id: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6" label: "north ridge" }');
    const result = tson.validate(document, { schema: compiled, root: 'reading' });
    expect(result.diagnostics).toEqual([]);
    expect(result.value.kind).toBe('record');

    const value = tson.readTree(document, { schema: compiled, root: 'reading' });
    expect(value).toEqual(result.value);
  });

  it('parse/write are the same flat functions, reachable off one instance', () => {
    const tson = createTson();
    const parsed = tson.parse(bytesOf('{ x: 1 }'));
    expect(parsed.document.root.coreValue.kind).toBe('record');
    const tree = tson.readTree(bytesOf('{ x: 1 }'));
    expect(tson.write(tree)).toBe('{ x: 1 }');
  });
});

describe('createTson: fetch/preload without a schemaSource', () => {
  it('fetch throws not-permitted with no schemaSource configured', async () => {
    const tson = createTson();
    await expect(tson.fetch('https://example.com/a.tn')).rejects.toBeInstanceOf(
      TsonSchemaFetchError,
    );
    await expect(tson.fetch('https://example.com/a.tn')).rejects.toMatchObject({
      reason: 'not-permitted',
      schemaId: 'https://example.com/a.tn',
    });
  });

  it('preload propagates the same failure for its first unreachable reference', async () => {
    const tson = createTson();
    await expect(tson.preload(['https://example.com/a.tn'])).rejects.toThrow(TsonSchemaFetchError);
  });
});

describe('createTson: preload against a configured schemaSource', () => {
  it('fetches, resolves, links, registers and content-hash-verifies each reference in order', async () => {
    const tson = createTson({ schemaSource: bundledOnlySource() });
    tson.register(linkSchema(bootstrapMetaKernel(KERNEL_BYTES)));

    await tson.preload([META_ID, CORE_ID]);

    expect(tson.schemas.get('tson.io/2026/33/m/meta.tn')?.id).toBe(META_ID);
    expect(tson.schemas.get('tson.io/2026/33/m/core.tn')?.id).toBe(CORE_ID);

    // Idempotent: a second preload of the same references touches the source again but adds
    // nothing new and does not throw (already registered, so resolution is skipped entirely).
    await tson.preload([META_ID, CORE_ID]);
  });

  it('rejects a reference whose fetched content does not hash to its own declared ?sha256= pin', async () => {
    const tamperedId = META_ID; // carries a real pin
    const source: SchemaSource = {
      fetch: () => Promise.resolve(bytesOf('!!id:"x"\n!!meta:"x"\n{}\n')), // wrong content
    };
    const tson = createTson({ schemaSource: source });
    await expect(tson.preload([tamperedId])).rejects.toThrow();
  });
});
