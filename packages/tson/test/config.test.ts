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

import { createTson, mapSchemaSource, type SchemaSource } from '../src/config.js';
import {
  DEFAULT_NAME_POLICY,
  DEFAULT_TOKEN_POLICY,
  tokenPolicy,
  withRestrictionLevel,
} from '../src/unicode/policy.js';
import { UTS39_VERSION } from '../src/unicode/uts39.js';
import { bootstrapMetaKernel } from '../src/schema/bootstrap.js';
import { linkSchema, type LinkedSchema } from '../src/link/link.js';
import type { Annotations, TypeDefinition } from '../src/schema/meta/typedef.js';
import {
  TsonContentHashMismatchError,
  TsonInternalError,
  TsonLimitRefusedError,
  TsonSchemaFetchError,
  TsonSchemaValidationError,
} from '../src/core/errors.js';
import { requireValue } from './reader-tree-helpers.js';

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

const META_TEXT = new TextDecoder().decode(META_BYTES);

const CATALOG_SCHEMA = `
!!id:"test://catalog.tn"
!!meta:"${META_ID}"
!!import:"${CORE_ID}"
{
  reading => { id: uuid label: non_empty_text }
  non_empty_text => !text ^ { min_length: 1 }
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

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected to throw, but it completed');
}

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
    expect(tson.schemas.get('tson.io/2026/37/m/meta-kernel.tn')).toBe(kernel);
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
    expect(tson.schemas.get('tson.io/2026/37/m/meta.tn')).toBe(meta);

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
    const resultValue = requireValue(result);
    expect(resultValue.kind).toBe('record');

    const value = tson.readTree(document, { schema: compiled, root: 'reading' });
    expect(value).toEqual(resultValue);
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

    expect(tson.schemas.get('tson.io/2026/37/m/meta.tn')?.id).toBe(META_ID);
    expect(tson.schemas.get('tson.io/2026/37/m/core.tn')?.id).toBe(CORE_ID);

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

  it('records each preloaded identity its own content hash, verified against a later pinned !!import to it ([TSON-SCHEMA] §10.2, WP3B)', async () => {
    const tson = createTson({ schemaSource: bundledOnlySource() });
    tson.register(linkSchema(bootstrapMetaKernel(KERNEL_BYTES)));
    await tson.preload([META_ID, CORE_ID]); // records core.tn's real hash, not only meta.tn's own pin on it

    // CATALOG_SCHEMA's own `!!import:"${CORE_ID}"` already carries core.tn's correct pin -- this
    // now actually verifies it against the recorded hash, rather than silently trusting it.
    expect(() => tson.resolveSchema(CATALOG_SCHEMA)).not.toThrow();

    const wrongHash = '0'.repeat(64);
    const badPin = CORE_ID.replace(/sha256=[0-9a-f]{64}/u, `sha256=${wrongHash}`);
    const badImport = `
!!id:"test://catalog-bad.tn"
!!meta:"${META_ID}"
!!import:"${badPin}"
{
  reading => { id: uuid }
}
`;
    expect(() => tson.resolveSchema(badImport)).toThrow(TsonContentHashMismatchError);
  });

  it('never verifies a pin against an identity registered directly as a LinkedSchema, with no source text to hash ([TSON-SCHEMA] §10.2)', () => {
    // meta-kernel here is `register`ed directly (a LinkedSchema built by `bootstrapMetaKernel`,
    // never resolved from bytes through this instance), so it is never hashed -- meta.tn's own
    // `!!meta` line pins it, and that pin goes unverified, exactly as `verifyPin`'s own doc
    // states. This is the one route `recordContentHash` cannot reach: `register`'s whole point is
    // accepting a schema this instance did not resolve for itself, and there is no source text
    // to hash. `registerStandardLibrary` (`stdlib/index.ts`) avoids the gap for its own bootstrap
    // by re-resolving meta-kernel's own source a second time right after -- the next test.
    const tson = createTson();
    tson.register(linkSchema(bootstrapMetaKernel(KERNEL_BYTES)));
    expect(() => tson.resolveSchema(META_BYTES)).not.toThrow();
  });

  it('a schema resolved from source text (not only a preloaded one) has its own content hash recorded and verified against its own !!id pin ([TSON-SCHEMA] §10.2, WP3B)', () => {
    // The gap above closes once meta-kernel is *resolved* rather than merely registered --
    // exactly what `registerStandardLibrary` does for its own bootstrap (`stdlib/index.ts`'s own
    // doc: "meta-kernel again, ordinarily, governed by the bootstrap output just registered").
    const tson = createTson();
    tson.register(linkSchema(bootstrapMetaKernel(KERNEL_BYTES)));
    tson.resolveSchema(KERNEL_BYTES); // records meta-kernel's own real hash this time
    expect(() => tson.resolveSchema(META_BYTES)).not.toThrow(); // meta.tn's real pin on it verifies clean

    const wrongPin = KERNEL_ID.replace(/sha256=[0-9a-f]{64}/u, `sha256=${'0'.repeat(64)}`);
    const tamperedMeta = META_TEXT.replace(/!!meta:"[^"]+"/u, `!!meta:"${wrongPin}"`);
    const badTson = createTson();
    badTson.register(linkSchema(bootstrapMetaKernel(KERNEL_BYTES)));
    badTson.resolveSchema(KERNEL_BYTES);
    expect(() => badTson.resolveSchema(tamperedMeta)).toThrow(TsonContentHashMismatchError);
  });

  it('refuses to register a schema whose own !!id declares a ?sha256= pin that does not match its own content ([TSON-SCHEMA] §10.2)', () => {
    const tson = createTson();
    tson.register(linkSchema(bootstrapMetaKernel(KERNEL_BYTES)));
    tson.resolveSchema(KERNEL_BYTES);
    tson.resolveSchema(META_BYTES);
    tson.resolveSchema(CORE_BYTES);

    const selfMispinned = `
!!id:"test://self-mispinned.tn?sha256=${'f'.repeat(64)}"
!!meta:"${META_ID}"
!!import:"${CORE_ID}"
{ thing => {} }
`;
    expect(() => tson.resolveSchema(selfMispinned)).toThrow(TsonContentHashMismatchError);
  });
});

describe('createTson: a schema registered from source text is pin-checked like a fetched one ([TSON-SCHEMA] §10.2, WP3B)', () => {
  function tsonWithStdlib(): ReturnType<typeof createTson> {
    const tson = createTson();
    tson.register(linkSchema(bootstrapMetaKernel(KERNEL_BYTES)));
    tson.resolveSchema(META_BYTES);
    tson.resolveSchema(CORE_BYTES);
    return tson;
  }

  it('a single-line schema (no !!id-line terminator) loads', () => {
    const tson = tsonWithStdlib();
    const oneLiner = `!!id:"test://oneliner.tn" !!meta:"${META_ID}" !!import:"${CORE_ID}" { thing => { label: text } }`;
    expect(() => tson.resolveSchema(oneLiner)).not.toThrow();
  });

  it('but no reference may pin a single-line schema -- a pinned !!import to it is refused, an unpinned one still resolves', () => {
    const tson = tsonWithStdlib();
    const oneLiner = `!!id:"test://oneliner.tn" !!meta:"${META_ID}" !!import:"${CORE_ID}" { thing => { label: text } }`;
    tson.resolveSchema(oneLiner);

    const pinned = `
!!id:"test://pins-oneliner.tn"
!!meta:"${META_ID}"
!!import:"test://oneliner.tn?sha256=${'a'.repeat(64)}"
{
  holder => { t: thing }
}
`;
    expect(() => tson.resolveSchema(pinned)).toThrow(TsonContentHashMismatchError);

    const unpinned = `
!!id:"test://uses-oneliner.tn"
!!meta:"${META_ID}"
!!import:"test://oneliner.tn"
{
  holder => { t: thing }
}
`;
    expect(() => tson.resolveSchema(unpinned)).not.toThrow();
  });
});

describe('createTson: a SchemaSource resolving to a non-Uint8Array is a fault, not a fetch failure', () => {
  it('throws TsonInternalError -- never TsonSchemaFetchError -- naming the reference', async () => {
    const source = {
      // A source violating its own declared contract: resolves to `undefined` instead of
      // throwing TsonSchemaFetchError. Cast past the type system the same way a loosely-typed
      // or plain-JS caller would reach this at runtime.
      fetch: () => Promise.resolve(undefined),
    } as unknown as SchemaSource;
    const tson = createTson({ schemaSource: source });
    await expect(tson.fetch('https://example.com/a.tn')).rejects.toBeInstanceOf(TsonInternalError);
    await expect(tson.fetch('https://example.com/a.tn')).rejects.not.toBeInstanceOf(
      TsonSchemaFetchError,
    );
    await expect(tson.fetch('https://example.com/a.tn')).rejects.toThrow(/a\.tn/u);
  });

  it('preload surfaces the same fault rather than reporting the schema unavailable', async () => {
    const source = {
      fetch: () => Promise.resolve(null),
    } as unknown as SchemaSource;
    const tson = createTson({ schemaSource: source });
    await expect(tson.preload(['https://example.com/a.tn'])).rejects.toBeInstanceOf(
      TsonInternalError,
    );
  });
});

describe('mapSchemaSource: a SchemaSource over an in-memory table (port of TsonSchemaSource.ofMap)', () => {
  it('serves an entry by its exact key', async () => {
    const source = mapSchemaSource(new Map([['https://example.com/a.tn', bytesOf('a')]]));
    await expect(source.fetch('https://example.com/a.tn')).resolves.toEqual(bytesOf('a'));
  });

  it('accepts a plain Record as well as a Map', async () => {
    const source = mapSchemaSource({ 'https://example.com/a.tn': bytesOf('a') });
    await expect(source.fetch('https://example.com/a.tn')).resolves.toEqual(bytesOf('a'));
  });

  it('matches by canonical identity: a ?sha256= pin and a scheme difference both still find the entry', async () => {
    const source = mapSchemaSource(new Map([['http://example.com/a.tn', bytesOf('a')]]));
    await expect(source.fetch('https://example.com/a.tn?sha256=deadbeef')).resolves.toEqual(
      bytesOf('a'),
    );
  });

  it('a miss throws TsonSchemaFetchError with reason not-found, distinct from no-source-configured', async () => {
    const source = mapSchemaSource(new Map());
    const error: unknown = await source
      .fetch('https://example.com/missing.tn')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TsonSchemaFetchError);
    expect(error).toMatchObject({
      reason: 'not-found',
      schemaId: 'https://example.com/missing.tn',
    });
  });

  it('a syntactically illegal reference at fetch time is not-permitted, not not-found', async () => {
    const source = mapSchemaSource(new Map([['https://example.com/a.tn', bytesOf('a')]]));
    const error: unknown = await source.fetch('not a uri at all').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TsonSchemaFetchError);
    expect(error).toMatchObject({ reason: 'not-permitted' });
  });

  it('two keys canonicalizing to the same identity with identical bytes are accepted', () => {
    expect(() =>
      mapSchemaSource(
        new Map([
          ['http://example.com/a.tn', bytesOf('a')],
          ['https://example.com/a.tn', bytesOf('a')],
        ]),
      ),
    ).not.toThrow();
  });

  it('two keys canonicalizing to the same identity with different bytes are refused at construction', () => {
    expect(() =>
      mapSchemaSource(
        new Map([
          ['http://example.com/a.tn', bytesOf('a')],
          ['https://example.com/a.tn', bytesOf('b')],
        ]),
      ),
    ).toThrow(TsonSchemaValidationError);
  });

  it("used as a Tson instance's schemaSource, a miss surfaces through fetch/preload as usual", async () => {
    const tson = createTson({
      schemaSource: mapSchemaSource(new Map([['https://example.com/a.tn', bytesOf('a')]])),
    });
    await expect(tson.fetch('https://example.com/missing.tn')).rejects.toMatchObject({
      reason: 'not-found',
    });
  });
});

describe('Tson.processorPolicy -- §8.2 stated once for the instance', () => {
  it('reports both policies and the UCD release they were computed against', () => {
    const tson = createTson();
    expect(tson.processorPolicy.identifierPolicy).toEqual(DEFAULT_NAME_POLICY);
    expect(tson.processorPolicy.tokenPolicy).toEqual(DEFAULT_TOKEN_POLICY);
    expect(tson.processorPolicy.unicodeDataVersion).toBe(UTS39_VERSION);
  });

  it('carries the policies the instance was configured with, not the defaults', () => {
    const identifierPolicy = withRestrictionLevel(DEFAULT_NAME_POLICY, 'ASCII_ONLY');
    const token = tokenPolicy('SINGLE_SCRIPT');
    const tson = createTson({ identifierPolicy, tokenPolicy: token });
    expect(tson.processorPolicy.identifierPolicy).toEqual(identifierPolicy);
    expect(tson.processorPolicy.tokenPolicy).toEqual(token);
  });

  it('is answerable with no document in hand -- a sender needs the policy before writing', () => {
    // The whole point of stating it on the instance: nothing has been read, and there is still an
    // answer. A version discoverable only from a refusal arrives one round trip too late.
    expect(createTson().processorPolicy.unicodeDataVersion).toBe(UTS39_VERSION);
  });
});

describe('resolveSchema: [TSON-SCHEMA] §11.5\'s "import closure" limit', () => {
  /** A minimal, hand-registered `LinkedSchema` stub -- `!!meta`/`!!import` are what the closure walk follows, and neither needs to be a real, resolvable schema for that walk alone to be exercised (`register` accepts any `LinkedSchema`, real parse or not). */
  function stubSchema(id: string, meta: string, imports: readonly string[]): LinkedSchema {
    return {
      id,
      meta,
      imports,
      entries: new Map<string, TypeDefinition>(),
      keyAnnotations: new Map<string, Annotations>(),
      bootstrap: false,
      origins: new Map<string, string>(),
    };
  }

  const PLACEHOLDER_META = 'test://placeholder-meta.tn';

  /** Registers a straight `!!import` chain `s0 <- s1 <- ... <- s{depth-1}`, each governed by the same unregistered `PLACEHOLDER_META` (so the closure counts it once, however many chain links reach it). Returns the id of the last link, the one a caller's own document should `!!import`. */
  function registerChain(tson: ReturnType<typeof createTson>, depth: number): string {
    let previous: string | undefined;
    let last = '';
    for (let i = 0; i < depth; i++) {
      const id = `test://s${String(i)}.tn`;
      tson.register(stubSchema(id, PLACEHOLDER_META, previous === undefined ? [] : [previous]));
      previous = id;
      last = id;
    }
    return last;
  }

  function documentImporting(chainTail: string): Uint8Array {
    return new TextEncoder().encode(
      `!!id:"test://top.tn"\n!!meta:"${PLACEHOLDER_META}"\n!!import:"${chainTail}"\n{ t => {} }`,
    );
  }

  it('a closure of exactly 64 distinct schema documents (the default) is not refused on that ground', () => {
    const tson = createTson();
    // 63 chain links + the shared placeholder meta = 64.
    const tail = registerChain(tson, 63);
    const error = (() => {
      try {
        tson.resolveSchema(documentImporting(tail));
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    // The placeholder meta is never registered, so resolution still fails downstream -- just not
    // for reaching too many schema documents, which is the one thing this test checks.
    expect(error).not.toBeInstanceOf(TsonLimitRefusedError);
  });

  it('a closure of 65 distinct schema documents is a limit refusal, not a resolver error', () => {
    const tson = createTson();
    // 64 chain links + the shared placeholder meta = 65.
    const tail = registerChain(tson, 64);
    const error = thrownBy(() => tson.resolveSchema(documentImporting(tail)));
    expect(error).toBeInstanceOf(TsonLimitRefusedError);
    expect((error as TsonLimitRefusedError).limit).toBe('import-closure');
    expect((error as TsonLimitRefusedError).configuredThreshold).toBe(64);
  });
});

describe('resolveSchema: [TSON-SCHEMA] §11.5\'s "entries" limit', () => {
  it('a schema resolving to more than the default (65,536) declarations is a limit refusal, not a resolver error', () => {
    const tson = createTson();
    tson.register(linkSchema(bootstrapMetaKernel(KERNEL_BYTES)));
    tson.register(tson.resolveSchema(META_BYTES));
    tson.register(tson.resolveSchema(CORE_BYTES));
    // One more declaration than the default admits -- every one a bare, fieldless record, the
    // cheapest possible entry to resolve, since only the count is under test here.
    const lines = ['!!id:"test://huge.tn"', `!!meta:"${META_ID}"`, `!!import:"${CORE_ID}"`, '{'];
    for (let i = 0; i <= 65_536; i++) lines.push(`d${String(i)} => {}`);
    lines.push('}');
    const bytes = new TextEncoder().encode(lines.join('\n'));
    const error = thrownBy(() => tson.resolveSchema(bytes));
    expect(error).toBeInstanceOf(TsonLimitRefusedError);
    expect((error as TsonLimitRefusedError).limit).toBe('schema-entries');
    expect((error as TsonLimitRefusedError).configuredThreshold).toBe(65_536);
  }, 20_000);
});
