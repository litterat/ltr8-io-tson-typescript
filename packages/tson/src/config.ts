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
 *   'https://tson.io/2026/34/m/meta.tn',
 *   'https://tson.io/2026/34/m/core.tn',
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
import {
  TsonInternalError,
  TsonSchemaFetchError,
  TsonSchemaValidationError,
} from './core/errors.js';
import type { NestingLimitOptions } from './core/limits.js';
import { processorPolicy } from './unicode/policy.js';
import type { NamePolicy, ProcessorPolicy, TokenPolicy } from './unicode/policy.js';
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
import { createAnnotationValueReader } from './schema/annotationReader.js';
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

/** Where a schema document's raw bytes come from, given the reference as written in a `!!schema`/`!!import`/`!!meta` directive -- satisfied by `@ltr8/tson/source`'s `httpSchemaSource`/`fileSchemaSource`, by {@link mapSchemaSource}, or by anything else with a matching `fetch` method (a test double). Never imported by this module -- see `source/index.ts`'s own top note on why the two Node-only shipped implementations stay behind that separate subpath. */
export interface SchemaSource {
  /**
   * Fetches `reference`'s schema document's raw bytes, or throws {@link TsonSchemaFetchError}.
   *
   * **The only way to say "cannot supply this."** Throwing anything else -- or resolving to
   * something other than a `Uint8Array`, `null`/`undefined` included -- is a fault in this
   * implementation, not an unavailable schema, and every caller treats it as one
   * (`createTson`'s own `fetchReference` guards this). A raw map lookup (`(id) =>
   * schemas.get(id)`) is the natural first thing to write here and resolves to `undefined` on a
   * miss instead of throwing -- {@link mapSchemaSource} is that lookup done to contract.
   */
  fetch(reference: string): Promise<Uint8Array>;
}

/**
 * A {@link SchemaSource} over schema documents already held in memory, keyed by identity --
 * what `schemas.get.bind(schemas)`/`(id) => schemas[id]` mean and do not do. Port of the
 * reference implementation's `TsonSchemaSource.ofMap` (`TsonSchemaSource.java:97-127`).
 *
 * **Matches by canonical identity, not by the string a document happened to write.** Each key
 * is canonicalized once here (via {@link canonicalizeIdentity}, §2.2.1: scheme and query
 * stripped) and every lookup likewise, so a reference carrying a `?sha256=` pin finds the entry
 * registered without one, and `http://`/`https://` spellings of one identity are one entry. A
 * raw `Map`/`Record` lookup matches none of those -- the second half of the trap this exists to
 * close, since it fails only for the references that pin, which are the ones a deployment that
 * cares about integrity writes.
 *
 * Two keys canonicalizing to the same identity are accepted only when their bytes are
 * identical (a schema registered twice under, say, an `http://` and an `https://` spelling);
 * otherwise construction throws {@link TsonSchemaValidationError} naming the colliding identity,
 * since two different documents cannot both answer for one identity.
 *
 * **A miss is {@link TsonSchemaFetchError} with reason `'not-found'`**, distinct from
 * {@link Tson.fetch}'s own `'not-permitted'` when no source is configured at all: this source
 * has somewhere to look and looked, and the answer is that this table does not hold that
 * identity.
 *
 * The input is copied at construction, so what this source serves cannot change under a
 * registry already reading from it.
 */
export function mapSchemaSource(
  schemas: ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>>,
): SchemaSource {
  const entries: Iterable<readonly [string, Uint8Array]> =
    schemas instanceof Map ? schemas : Object.entries(schemas);
  const byIdentity = new Map<string, Uint8Array>();
  for (const [reference, bytes] of entries) {
    const identity = canonicalizeIdentity(reference);
    const existing = byIdentity.get(identity);
    if (existing !== undefined && !bytesEqual(existing, bytes)) {
      throw new TsonSchemaValidationError(
        `mapSchemaSource: '${reference}' and an earlier key both canonicalize to '${identity}' ` +
          'but name different bytes -- a scheme or ?sha256= pin is not part of a schema\'s ' +
          'identity (§2.2.1), so keys differing only in those name one schema and cannot both ' +
          'be served',
      );
    }
    byIdentity.set(identity, bytes);
  }
  const served = new Map(byIdentity);
  return {
    // Not `async` -- a map lookup has no I/O to await, and this library's own eslint
    // configuration flags an `async` method that never does. Every path still returns a real
    // `Promise` rather than throwing synchronously (`Promise.reject`, not `throw`), so a direct
    // caller of `fetch` sees the same all-failures-are-a-rejection contract `httpSchemaSource`/
    // `fileSchemaSource` present, whether or not it happens to be awaited from inside another
    // `async` function.
    fetch(reference: string): Promise<Uint8Array> {
      let identity: string;
      try {
        identity = canonicalizeIdentity(reference);
      } catch (e) {
        // Refused rather than reported as a miss: nothing was looked for, because there is no
        // identity to look for.
        return Promise.reject(
          new TsonSchemaFetchError(
            reference,
            'not-permitted',
            `'${reference}' is not a legal schema identity: ${errorMessage(e)}`,
            { cause: e },
          ),
        );
      }
      const bytes = served.get(identity);
      if (bytes === undefined) {
        return Promise.reject(
          new TsonSchemaFetchError(
            reference,
            'not-found',
            `mapSchemaSource has no entry for '${reference}' (identity '${identity}')`,
          ),
        );
      }
      return Promise.resolve(bytes);
    },
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Configures a {@link Tson}. Every field is optional; an empty `{}` builds an instance with no schema source and an empty registry. */
export interface Config extends NestingLimitOptions {
  /**
   * Fetches a schema document beyond what this instance already has registered -- consulted only
   * by {@link Tson.preload}/{@link Tson.fetch}, never automatically during {@link
   * Tson.resolveSchema} (which resolves only against what is already registered; see this
   * module's own top note on why). Omitted means nothing is ever fetched: `preload`/`fetch` then
   * throw {@link TsonSchemaFetchError} with reason `'not-permitted'` naming the missing source.
   */
  readonly schemaSource?: SchemaSource;
  /**
   * [TSON-DATA] §8.2's name-hygiene policy, applied by {@link Tson.readTree}/{@link Tson.validate}
   * over each schemaless record's own field names (§8.2's one Part 1 scope). Omitted means
   * `reader/schemaless/tree.ts`'s own default (`DEFAULT_NAME_POLICY` -- mechanisms 1 and 2
   * enforced, mechanism 3 at Highly Restrictive over the whole name), matching §8.2's own
   * defaults exactly, the same way an omitted {@link NestingLimitOptions.maxNestingDepth} keeps
   * that module's own default.
   *
   * Stated once on the instance rather than per call, for the same reason {@link maxNestingDepth}
   * is: the whole reason to hold a `Tson` is to say a policy once. §8.2 requires any relaxation of
   * the three mechanisms to be a code decision, never read from the environment -- setting this
   * field is exactly that decision, made once, here, rather than implicitly per call.
   *
   * It governs both layers this instance reaches: §8.2's one Part 1 scope, a record's own field
   * names, on a schemaless read; and [TSON-SCHEMA] §11.4's schema-layer scopes when a schema is
   * resolved through {@link Tson.resolveSchema} or {@link Tson.preload}. A schema-governed *read*
   * consults it for neither -- a data field name under a schema inherits the declaration's own
   * verdict (§8.2), which the schema's own linking already reached.
   *
   * The meta-kernel's own bootstrap is deliberately outside its reach: that link is pinned to the
   * default, so relaxing a policy here can never change whether the kernel itself loads.
   */
  readonly identifierPolicy?: NamePolicy;

  /**
   * [TSON-DATA] §8.2's policy over *values* -- the token profile a read applies to every
   * token it decodes.
   *
   * Defaults to unrestricted, so an ordinary read scans nothing. Only the restricted-script
   * rule ever applies here: a value has no identifier profile to violate, and no scope to be
   * distinct within, so the other two mechanisms have nothing to say about one.
   */
  readonly tokenPolicy?: TokenPolicy;
}

/**
 * The nesting bound (§9.1) this instance applies to everything it does -- every schema it
 * resolves, and every document it reads.
 *
 * Stated once on the instance rather than per call, because the whole reason to hold a `Tson` is
 * to say a policy once. A schema is the more important half: it is routinely fetched from
 * somewhere else, and a deeply nested annotation value or type expression in one used to exhaust
 * the host call stack inside `resolveSchema` before this bound existed.
 */
function limitOf(config: Config): NestingLimitOptions {
  return config.maxNestingDepth === undefined ? {} : { maxNestingDepth: config.maxNestingDepth };
}

/** {@link Config.identifierPolicy} and {@link Config.tokenPolicy}, as the fragment {@link createTson}'s `readTree`/`validate` wrappers merge ahead of a caller's own per-call options -- `limitOf`'s own shape, two fields over. */
function policyOptionsOf(
  config: Config,
): { readonly identifierPolicy?: NamePolicy; readonly tokenPolicy?: TokenPolicy } {
  return {
    ...(config.identifierPolicy === undefined ? {} : { identifierPolicy: config.identifierPolicy }),
    ...(config.tokenPolicy === undefined ? {} : { tokenPolicy: config.tokenPolicy }),
  };
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

/**
 * The governing meta, compiled -- memoized per {@link LinkedSchema}, because every schema governed
 * by one needs the same compiled readers and compiling is not free. Keyed by identity in a
 * `WeakMap`: a linked schema nobody holds any more takes its compiled form with it.
 */
const compiledMetas = new WeakMap<LinkedSchema, CompiledSchema>();

function compiledMetaFor(meta: LinkedSchema): CompiledSchema {
  const already = compiledMetas.get(meta);
  if (already !== undefined) return already;
  const compiled = compileCore(meta);
  compiledMetas.set(meta, compiled);
  return compiled;
}

/** Resolves and links `bytes` against `schemas` -- the synchronous core both {@link Tson.resolveSchema} and {@link Tson.preload} share. */
function resolveAgainstRegistry(
  schemas: ReadonlyMap<string, LinkedSchema>,
  bytes: Uint8Array,
  limit: NestingLimitOptions,
  identifierPolicy: NamePolicy | undefined,
): LinkedSchema {
  const document = runSync(parseSchemaDocument(fromBytes(bytes), limit));
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
    // §6/§3.3.3: a declaration's key annotations (`@doc` and anything else a meta-schema defines)
    // name ordinary entries of the governing meta, and their values are read through that
    // schema's own compiled readers. Without this every key annotation resolved name-only, so a
    // resolved schema lost the documentation the author wrote on it.
    annotationValueReader: createAnnotationValueReader(compiledMetaFor(governingMeta)),
    metaDefinitions,
    encodeSourceBody: (body) => toCoreValue(topBinding, body, defaultAtomEncoder),
    resolveImport,
  });
  return linkSchema(resolved, {
    structureNamespace: governingMeta.entries,
    resolveImport,
    ...(identifierPolicy === undefined ? {} : { identifierPolicy }),
  });
}

/**
 * A {@link createTson} instance: the flat front door, plus a schema registry keyed by canonical
 * identity (§2.2.1).
 *
 * **Concurrency contract.** JS has one thread, so there is no analogue to a reference
 * implementation's "safe from any number of threads" -- the real question here is overlapping
 * *async* operations on one event loop, i.e. two calls in flight at once with an `await` between
 * them.
 *
 * - **Reading is safe to overlap.** {@link parse}/{@link readTree}/{@link validate}/{@link write}
 *   and {@link compile} only read `schemas`/`config`; nothing they do mutates this instance, so
 *   any number of them may be in flight together, including two resolving the same not-yet-cached
 *   compiled meta (`compiledMetaFor`'s `WeakMap` memo): the worst a race there costs is compiling
 *   it twice, never a wrong or torn result.
 * - **Registering is not covered the same way.** {@link register}/{@link resolveSchema}/
 *   {@link preload} mutate the registry, and each one assumes nothing else is registering into it
 *   at the same moment. Fetch, resolve, link, and register everything a read will need *before*
 *   starting reads against it, exactly as this module's own top note recommends -- do not treat
 *   "the registry is a `Map`" as license to grow it from concurrent callers.
 * - **One narrow, known, and accepted race inside {@link preload} itself:** it checks
 *   `schemas.has(canonical)`, then `await`s a fetch, then `schemas.set(canonical, linked)` --
 *   a real await boundary between the check and the write. Two overlapping `preload()` calls
 *   naming the same identity (or `preload` racing a direct `resolveSchema()` call for it) can
 *   both pass the check, both fetch and resolve, and the second `.set()` silently wins,
 *   discarding the first `LinkedSchema` object. This is harmless rather than corrupting --
 *   {@link register} has no duplicate check at all, so registering the same identity twice is
 *   simply idempotent by design here, unlike a reference implementation that treats any duplicate
 *   registration as a strict error regardless of a race -- but the discarded object does take an
 *   entry in the `compiledMetaFor` `WeakMap` memo with it, keyed by the object identity that lost.
 *   Avoid it by not calling `preload`/`resolveSchema` for one identity from more than one place
 *   at a time, the same discipline the "registering is not covered" rule above already asks for.
 * - **No `DataBindContext`-shaped hazard exists to warn about.** A reference implementation's
 *   bind registry is mutable after construction and warns against adding to a live one; this
 *   port's `bind/registry.ts` builds an immutable `Map` from a fixed table once and exposes only
 *   `get` -- there is no `register`/mutation method for a race to reach, by construction rather
 *   than by discipline.
 */
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
   *
   * See {@link Tson}'s own top note on this instance's concurrency contract -- in particular the
   * narrow, known race between this method's own has-check and its later write when two calls
   * name the same not-yet-registered identity.
   */
  preload(references: readonly string[]): Promise<void>;

  /**
   * The [TSON-DATA] §8.2 policy this instance judges under, and the UCD release it was computed
   * against -- stated once for the instance rather than repeated on every refusal.
   *
   * Three reasons it belongs here and not on a diagnostic. **Cardinality**: the version is
   * constant for the life of the instance, so a copy inside every refusal is waste. **Time**: a
   * sender needs the policy *before* writing a document, not after being refused one. And
   * **direction**: a version says what refused you, where a level says what would be accepted --
   * only the second is actionable.
   */
  readonly processorPolicy: ProcessorPolicy;

  parse(source: Uint8Array, options?: NestingLimitOptions): ParsedDocument;
  parse(source: AsyncByteSource, options?: NestingLimitOptions): Promise<ParsedDocument>;
  readTree(source: Uint8Array, options?: ReadTreeOptions): Value;
  readTree(source: AsyncByteSource, options?: ReadTreeOptions): Promise<Value>;
  validate(source: Uint8Array, options?: ReadTreeOptions): ValidationResult;
  validate(source: AsyncByteSource, options?: ReadTreeOptions): Promise<ValidationResult>;
  write(value: Value, options?: WriteOptions): string;
}

/** Builds a {@link Tson}: an empty schema registry, and the flat front door bound onto one instance. See this module's own top note for the standard-library bootstrap sequence a schema-governed read needs before it. */
export function createTson(config: Config = {}): Tson {
  const schemas = new Map<string, LinkedSchema>();
  const limit = limitOf(config);
  const policyOptions = policyOptionsOf(config);

  function register(schema: LinkedSchema): void {
    schemas.set(canonicalizeIdentity(schema.id), schema);
  }

  function resolveSchemaMethod(source: string | Uint8Array): LinkedSchema {
    const bytes = typeof source === 'string' ? encodeUtf8(source) : source;
    const linked = resolveAgainstRegistry(schemas, bytes, limit, config.identifierPolicy);
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
    const bytes: unknown = await config.schemaSource.fetch(reference);
    if (!(bytes instanceof Uint8Array)) {
      // Deliberately not a TsonSchemaFetchError -- a source signals "cannot supply this" only
      // by throwing one, so treating a wrong return type as a fetch failure would make the wrong
      // spelling "work" and misreport a fault in this instance's own configuration as a verdict
      // on the document that named the schema. See TsonInternalError's own doc.
      throw new TsonInternalError(
        `the SchemaSource fetching '${reference}' resolved to ` +
          `${bytes === null ? 'null' : typeof bytes} instead of a Uint8Array -- a SchemaSource ` +
          "signals \"cannot supply this\" only by throwing TsonSchemaFetchError; anything else " +
          'is a fault in that source. If this source is a plain map lookup, mapSchemaSource(...) ' +
          'is that lookup done to contract',
      );
    }
    return bytes;
  }

  async function preload(references: readonly string[]): Promise<void> {
    for (const reference of references) {
      const canonical = canonicalizeIdentity(reference);
      if (schemas.has(canonical)) {
        continue; // idempotent -- already registered, from an earlier call or an earlier entry
      }
      const bytes = await fetchReference(reference);
      await verifyContentHash(bytes, reference);
      const linked = resolveAgainstRegistry(schemas, bytes, limit, config.identifierPolicy);
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
    processorPolicy: processorPolicy(config.identifierPolicy, config.tokenPolicy),
    // Bound to this instance's limit (and, for a schemaless tree read, its two Unicode policies) rather
    // than passed through bare, so `tson.parse(bytes)`/`tson.readTree(bytes)`/`tson.validate(bytes)`
    // obey the policy the instance was configured with. A caller's own per-call options still
    // win: they are spread after the instance's.
    //
    // `policyOptions` is spread into `readTree`/`validate` only -- `parse`'s own options are
    // `NestingLimitOptions` alone (it produces a parsed *document*, not a schemaless tree, and
    // has no record-scope name-hygiene check of its own to configure).
    parse: ((source: never, options?: NestingLimitOptions) =>
      parse(source, { ...limit, ...options })) as Tson['parse'],
    readTree: ((source: never, options?: ReadTreeOptions) =>
      readTree(source, { ...limit, ...policyOptions, ...options })) as Tson['readTree'],
    validate: ((source: never, options?: ReadTreeOptions) =>
      validate(source, { ...limit, ...policyOptions, ...options })) as Tson['validate'],
    write,
  };
}
