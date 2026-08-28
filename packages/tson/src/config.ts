/**
 * `createTson(config)` -- a config-bound convenience over the flat front door
 * (`facade/parse.ts`/`tree.ts`/`write.ts`), plus the one thing those flat functions cannot be:
 * a schema *registry*, resolving and linking a schema against every other schema this instance
 * already knows about, and (given a {@link SchemaSource}) fetching the ones it does not.
 *
 * **Not the primary way in.** `CLAUDE.md`'s own work-package brief: "the public API is flat and
 * tree-shakable first... with `createTson(config)` as a config-bound convenience over them, not
 * as the primary way in." A caller with one schema already compiled reaches for `readTree`/
 * `validate` directly, passing `{ schema, root }`; this module exists for a caller managing more
 * than one schema, or resolving `!!import`/`!!meta` against schemas it does not have compiled
 * ahead of time.
 *
 * **A fresh {@link Tson} starts with an empty registry**, unlike the reference implementation's
 * `Tson.builder().build()`, which loads `meta-kernel`/`meta.tn`/`core.tn` from packaged classpath
 * resources before a caller does anything. That is not a gap: this module's import graph is what a
 * browser consumer of `readTree` pays for, and 45 KB of schema text belongs on the other side of a
 * subpath boundary from it. `@ltr8/tson/stdlib` is that boundary, and it is one line to cross:
 *
 * ```ts
 * import { standardLibrary } from '@ltr8/tson/stdlib';
 *
 * const tson = standardLibrary(); // meta-kernel, meta.tn and core.tn already registered
 * const catalog = tson.resolveSchema(catalogSchemaText);
 * const value = tson.readTree(documentBytes, { schema: tson.compile(catalog), root: 'reading' });
 * ```
 *
 * A caller who wants the standard library from somewhere else -- a newer revision, a private
 * mirror -- registers it the same way `stdlib/index.ts` does, since meta-kernel's own bootstrap
 * circularity (§1.5: its `!!meta` names itself) needs `schema/bootstrap.ts`'s `bootstrapMetaKernel`
 * regardless, and nothing here can special-case it silently:
 *
 * ```ts
 * import { createTson, bootstrapMetaKernel, linkSchema } from '@ltr8/tson';
 *
 * const tson = createTson({ schemaSource: httpSchemaSource({ allowHosts: ['tson.io'] }) });
 * tson.register(linkSchema(bootstrapMetaKernel(metaKernelBytes)));
 * await tson.preload([
 *   'https://tson.io/2026/33/m/meta.tn',
 *   'https://tson.io/2026/33/m/core.tn',
 * ]);
 * ```
 *
 * **Resolution is synchronous; fetching is not — that split is why {@link preload} exists at
 * all.** `link/link.ts`'s `resolveImport`/`compiler/schemaResolver.ts`'s own `resolveImport` are
 * both plain, synchronous functions (`(uri) => ImportedSchema`), matching the frozen contract
 * every earlier wave built against — a schema fetch is real I/O and cannot honestly be
 * synchronous in JS the way the reference implementation's blocking `TsonSchemaSource.fetch`
 * is in Java. {@link Tson.preload}/{@link Tson.resolveSchema} therefore split the same way the
 * reference implementation's own docs recommend using it: fetch (and resolve, link, register)
 * every dependency *first*, in order, so that by the time a schema referencing them is resolved,
 * `resolveImport` finds each one already registered and never needs to suspend.
 */
import { TsonSchemaFetchError, TsonSchemaValidationError } from './core/errors.js';
import { canonicalizeIdentity } from './link/identity.js';
import { verifyContentHash } from './link/contentHash.js';
import { linkSchema, type LinkedSchema } from './link/link.js';
import {
  resolveSchema as resolveSchemaCore,
  type ImportResolver,
  type ImportedSchema,
} from './compiler/schemaResolver.js';
import type { DefinitionGetter } from './compiler/resolverTypes.js';
import { parseSchemaDocument } from './compiler/schemaParser.js';
import { compile as compileCore, type CompiledSchema } from './compiler/compile.js';
import { createDefinitionMetaReader } from './schema/metaReader.js';
import { topBinding } from './schema/bindings.js';
import { toCoreValue } from './bind/encode.js';
import { defaultAtomEncoder } from './write/bindingWriter.js';
import { fromBytes, runSync } from './io/bytes.js';
import { encodeUtf8 } from './io/utf8.js';
import { parse, type ParsedDocument } from './facade/parse.js';
import { readTree, validate, type ReadTreeOptions, type ValidationResult } from './facade/tree.js';
import { write, type WriteOptions } from './facade/write.js';
import type { AsyncByteSource } from './facade/byteSource.js';
import type { Value } from './tree/nodes.js';

/** Where a schema document's raw bytes come from, given the reference as written in a `!!schema`/`!!import`/`!!meta` directive -- satisfied by `@ltr8/tson/source`'s `httpSchemaSource`/`fileSchemaSource`, or by anything else with a matching `fetch` method (a test double, an in-memory map). Never imported by this module -- see `source/index.ts`'s own top note on why the two shipped implementations stay behind that separate, Node-only subpath. */
export interface SchemaSource {
  /** Fetches `reference`'s schema document's raw bytes, or throws {@link TsonSchemaFetchError}. */
  fetch(reference: string): Promise<Uint8Array>;
}

/** Configures a {@link Tson}. Every field is optional; an empty `{}` builds an instance with no schema source and an empty registry. */
export interface Config {
  /**
   * Fetches a schema document beyond what this instance already has registered -- consulted only
   * by {@link Tson.preload}/{@link Tson.fetch}, never automatically during {@link
   * Tson.resolveSchema} (which resolves only against what is already registered; see this
   * module's own top note on why). Omitted means nothing is ever fetched: `preload`/`fetch` then
   * throw {@link TsonSchemaFetchError} with reason `'not-permitted'` naming the missing source.
   */
  readonly schemaSource?: SchemaSource;
}

function requireRegistered(
  schemas: ReadonlyMap<string, LinkedSchema>,
  reference: string,
  resolving: string,
): LinkedSchema {
  const canonical = canonicalizeIdentity(reference);
  const found = schemas.get(canonical);
  if (found === undefined) {
    throw new TsonSchemaValidationError(
      `resolving '${resolving}': '${reference}' is not registered -- register (or preload) it, ` +
        'and everything it in turn depends on, before resolving a schema that names it',
    );
  }
  return found;
}

function importedFrom(schema: LinkedSchema): ImportedSchema {
  return {
    entries: schema.entries,
    originOf: (name) => schema.origins.get(name) ?? schema.id,
  };
}

/** Resolves and links `bytes` against `schemas` -- the synchronous core both {@link Tson.resolveSchema} and {@link Tson.preload} share. */
function resolveAgainstRegistry(
  schemas: ReadonlyMap<string, LinkedSchema>,
  bytes: Uint8Array,
): LinkedSchema {
  const document = runSync(parseSchemaDocument(fromBytes(bytes)));
  const id = document.id;
  if (id === undefined) {
    throw new TsonSchemaValidationError(
      `'!!meta:"${document.meta}"': !!id is required to resolve this schema (§2.2.1)`,
    );
  }
  const governingMeta = requireRegistered(schemas, document.meta, id);
  const metaDefinitions: DefinitionGetter = (name) => governingMeta.entries.get(name);
  const resolveImport: ImportResolver = (importUri) =>
    importedFrom(requireRegistered(schemas, importUri, id));
  const resolved = resolveSchemaCore(document, {
    definitionMetaReader: createDefinitionMetaReader(metaDefinitions),
    metaDefinitions,
    encodeSourceBody: (body) => toCoreValue(topBinding, body, defaultAtomEncoder),
    resolveImport,
  });
  return linkSchema(resolved, { structureNamespace: governingMeta.entries, resolveImport });
}

/** A {@link createTson} instance: the flat front door, plus a schema registry keyed by canonical identity (§2.2.1). */
export interface Tson {
  readonly config: Config;
  /** Every registered schema, keyed by canonical identity -- read-only; use {@link register}/{@link resolveSchema}/{@link preload} to add to it. */
  readonly schemas: ReadonlyMap<string, LinkedSchema>;
  /** Registers an already-resolved-and-linked schema directly under its own canonical identity -- for one built without going through this instance (`bootstrapMetaKernel`, or a schema resolved against a different registry entirely). */
  register(schema: LinkedSchema): void;
  /**
   * Resolves and links `source` (schema text, or its already-UTF-8-encoded bytes) against this
   * instance's own registry, registers the result, and returns it. `source`'s own `!!meta` and
   * every `!!import` it declares must already be registered -- see this module's own top note on
   * why this never fetches, even with a {@link Config.schemaSource} configured.
   */
  resolveSchema(source: string | Uint8Array): LinkedSchema;
  /** Builds a {@link CompiledSchema} for `schema` -- `compiler/compile.ts`'s own `compile`, re-exported here so the whole resolve-link-compile sequence is reachable off one instance. */
  compile(schema: LinkedSchema): CompiledSchema;
  /** Fetches `reference`'s raw schema bytes through {@link Config.schemaSource} -- throws {@link TsonSchemaFetchError} (`'not-permitted'`) when none is configured. Does not resolve, link, or register; {@link preload} does all three. */
  fetch(reference: string): Promise<Uint8Array>;
  /**
   * Fetches, resolves, links, and registers each of `references`, **in order** -- so a reference
   * depending on an earlier one in this same call (or on anything already registered) finds it
   * in place by the time its own turn comes. A `?sha256=` pin declared on a reference is verified
   * against what was fetched (`link/contentHash.ts`'s own `verifyContentHash`, §2.2.1's MUST),
   * and the fetched document's own `!!id` is cross-checked against the identity that was asked
   * for -- both regardless of whether {@link HttpSchemaSourceOptions.requireContentHashPin}-style
   * policy required a pin to be *present*, since verifying one that *is* declared is unconditional.
   * A reference already registered is left alone (idempotent) and never re-fetched.
   */
  preload(references: readonly string[]): Promise<void>;

  parse(source: Uint8Array): ParsedDocument;
  parse(source: AsyncByteSource): Promise<ParsedDocument>;
  readTree(source: Uint8Array, options?: ReadTreeOptions): Value;
  readTree(source: AsyncByteSource, options?: ReadTreeOptions): Promise<Value>;
  validate(source: Uint8Array, options?: ReadTreeOptions): ValidationResult;
  validate(source: AsyncByteSource, options?: ReadTreeOptions): Promise<ValidationResult>;
  write(value: Value, options?: WriteOptions): string;
}

/** Builds a {@link Tson}: an empty schema registry, and the flat front door bound onto one instance. See this module's own top note for the standard-library bootstrap sequence a schema-governed read needs before it. */
export function createTson(config: Config = {}): Tson {
  const schemas = new Map<string, LinkedSchema>();

  function register(schema: LinkedSchema): void {
    schemas.set(canonicalizeIdentity(schema.id), schema);
  }

  function resolveSchemaMethod(source: string | Uint8Array): LinkedSchema {
    const bytes = typeof source === 'string' ? encodeUtf8(source) : source;
    const linked = resolveAgainstRegistry(schemas, bytes);
    register(linked);
    return linked;
  }

  async function fetchReference(reference: string): Promise<Uint8Array> {
    if (config.schemaSource === undefined) {
      throw new TsonSchemaFetchError(
        reference,
        'not-permitted',
        `cannot fetch schema '${reference}': this Tson instance has no schemaSource configured`,
      );
    }
    return config.schemaSource.fetch(reference);
  }

  async function preload(references: readonly string[]): Promise<void> {
    for (const reference of references) {
      const canonical = canonicalizeIdentity(reference);
      if (schemas.has(canonical)) {
        continue; // idempotent -- already registered, from an earlier call or an earlier entry
      }
      const bytes = await fetchReference(reference);
      await verifyContentHash(bytes, reference);
      const linked = resolveAgainstRegistry(schemas, bytes);
      const declared = canonicalizeIdentity(linked.id);
      if (declared !== canonical) {
        throw new TsonSchemaValidationError(
          `fetched '${reference}' but it declares !!id "${linked.id}" (identity '${declared}'), ` +
            `a different identity -- a mirror or file behind this reference is serving the wrong document`,
        );
      }
      schemas.set(canonical, linked);
    }
  }

  return {
    config,
    schemas,
    register,
    resolveSchema: resolveSchemaMethod,
    compile: compileCore,
    fetch: fetchReference,
    preload,
    parse,
    readTree,
    validate,
    write,
  };
}
