/**
 * Test-only fixtures for `compiler/compile.ts`'s own integration tests -- not itself a `*.test.ts`
 * file, so vitest never tries to run it. Resolves and links the three real, vendored bundled
 * schemas (`spec/m/*.tn`) the same way `bundled-schemas-resolve.test.ts` does, and resolves a
 * caller-supplied user schema text against `core.tn`'s own governing chain -- the "a user schema
 * importing core.tn" shape Wave 5's own gate is measured against, reused here at unit-test scale.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { fromBytes, fromString, runSync } from '../src/io/bytes.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';
import { bootstrapMetaKernel } from '../src/schema/bootstrap.js';
import { resolveSchema, type Schema } from '../src/compiler/schemaResolver.js';
import { compile } from '../src/compiler/compile.js';
import { createAnnotationValueReader } from '../src/schema/annotationReader.js';
import { linkSchema, type LinkedSchema } from '../src/link/link.js';
import type { DefinitionGetter } from '../src/compiler/resolverTypes.js';
import { toCoreValue, type AtomEncoder } from '../src/bind/encode.js';
import { topBinding } from '../src/schema/bindings.js';
import { createDefinitionMetaReader } from '../src/schema/metaReader.js';
import type { TokenValue } from '../src/ast/value.js';

const SPEC = fileURLToPath(new URL('../../../spec/m/', import.meta.url));

function bundledSource(file: string): Uint8Array {
  return new Uint8Array(readFileSync(SPEC + file));
}

/** As `bundled-schemas-resolve.test.ts`'s own `encodeAtom` -- needed to close over `SourceBodyEncoder` for §5.6's chained atom-refinement merge (`uint8 => !integer ^ { ... }`, which every fixed-width core.tn integer instance uses). */
const encodeAtom: AtomEncoder = (binding, value): TokenValue => {
  if (typeof value === 'object' && value !== null && 'text' in value && 'form' in value) {
    const token = value as { text: string; form: TokenValue['form'] };
    return { kind: 'token', text: token.text, form: token.form };
  }
  if (typeof value === 'string') {
    return {
      kind: 'token',
      text: value,
      form: binding.wireType === 'text' ? 'single-line' : 'unquoted',
    };
  }
  if (typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'number') {
    return { kind: 'token', text: String(value), form: 'unquoted' };
  }
  return { kind: 'token', text: JSON.stringify(value), form: 'unquoted' };
};

type BundledName = 'meta-kernel' | 'meta' | 'core';
const CHAIN: Record<BundledName, readonly BundledName[]> = {
  'meta-kernel': [],
  meta: ['meta-kernel'],
  core: ['meta-kernel', 'meta'],
};

const cache = new Map<BundledName, LinkedSchema>();

function structureNamespaceFor(name: BundledName): DefinitionGetter {
  const chain = [...CHAIN[name]].reverse().map(resolvedBundled); // nearest first
  return (typeName) => {
    for (const schema of chain) {
      const found = schema.entries.get(typeName);
      if (found !== undefined) return found;
    }
    return undefined;
  };
}

function resolveBundled(name: BundledName, meta: LinkedSchema): Schema {
  const document = runSync(parseSchemaDocument(fromBytes(bundledSource(`${name}.tn`))));
  const metaDefinitions = structureNamespaceFor(name);
  return resolveSchema(document, {
    definitionMetaReader: createDefinitionMetaReader(metaDefinitions),
    // §6/§3.3.3: a key annotation's value is read through the *governing meta's* own compiled
    // reader for the annotation's name. Without one every key annotation resolves name-only, and
    // the `@doc` on each declaration is lost from the resolved output.
    annotationValueReader: createAnnotationValueReader(compile(meta)),
    metaDefinitions,
    encodeSourceBody: (body) => toCoreValue(topBinding, body, encodeAtom),
    resolveImport: () => ({ entries: meta.entries, originOf: () => meta.id }),
  });
}

/** The real, vendored `<name>.tn` (`meta-kernel`/`meta`/`core`), resolved against its own governing chain and linked -- cached, since `core` depends on `meta` depends on `meta-kernel`. */
export function resolvedBundled(name: BundledName): LinkedSchema {
  const already = cache.get(name);
  if (already !== undefined) return already;
  const chain = CHAIN[name];
  const last = chain.at(-1);
  const governingMeta = last === undefined ? undefined : resolvedBundled(last);
  const unlinked =
    governingMeta === undefined
      ? bootstrapMetaKernel(bundledSource('meta-kernel.tn'))
      : resolveBundled(name, governingMeta);
  const linked = linkSchema(unlinked, {
    ...(governingMeta === undefined
      ? {}
      : {
          structureNamespace: governingMeta.entries,
          resolveImport: () => ({
            entries: governingMeta.entries,
            originOf: () => governingMeta.id,
          }),
        }),
  });
  cache.set(name, linked);
  return linked;
}

/**
 * Resolves and links `source` (real TSON schema text) as a user schema governed by `meta.tn` and
 * importing `core.tn` -- the "a user schema importing core.tn" shape Wave 5's own gate is measured
 * against. `source`'s own `!!meta`/`!!import` URIs are never matched against a real fetch: both
 * resolvers here are stubs that hand back `meta`'s/`core`'s own real, already-linked namespace
 * regardless of the URI text asked for, since nothing in this test suite fetches schemas over the
 * network (`CLAUDE.md`'s zero-runtime-dependency rule extends to test-time fetches too).
 */
export function resolveUserSchema(source: string): LinkedSchema {
  const meta = resolvedBundled('meta');
  const core = resolvedBundled('core');
  const document = runSync(parseSchemaDocument(fromString(source)));
  const metaDefinitions: DefinitionGetter = (typeName) =>
    meta.entries.get(typeName) ?? resolvedBundled('meta-kernel').entries.get(typeName);
  const unlinked = resolveSchema(document, {
    definitionMetaReader: createDefinitionMetaReader(metaDefinitions),
    annotationValueReader: createAnnotationValueReader(compile(meta)),
    metaDefinitions,
    encodeSourceBody: (body) => toCoreValue(topBinding, body, encodeAtom),
    resolveImport: () => ({ entries: core.entries, originOf: () => core.id }),
  });
  return linkSchema(unlinked, {
    structureNamespace: meta.entries,
    resolveImport: () => ({ entries: core.entries, originOf: () => core.id }),
  });
}
