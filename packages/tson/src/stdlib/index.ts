/**
 * `@ltr8/tson/stdlib` — the six bundled schemas (the kernel `meta.tn`, the `numeric.tn`,
 * `temporal.tn` and `net.tn` libraries, `core.tn`, and the `policy.tn` vocabulary), embedded as
 * source text, and the one function that registers them into a {@link Tson}.
 *
 * **Its own subpath, never the default entry.** The reference implementation's
 * `Tson.builder().build()` loads every bundled schema from packaged classpath resources before a
 * caller does anything, and a JVM can afford that. A browser bundle cannot: someone importing
 * `parse` to read a document with no schema in scope should not carry the schema text they will
 * never look at. Splitting it out is what lets both callers get what they want — `import {
 * standardLibrary } from '@ltr8/tson/stdlib'` is one line, and not writing that line costs nothing.
 *
 * **No I/O, on any platform.** The six documents are string constants generated into
 * `schemas.generated.ts` from `spec/m/` by `scripts/gen-stdlib-schemas.mjs`, not files read at
 * run time — a published package is not installed next to this repository's `spec/`, and a
 * browser cannot read files at all. Nothing here touches a {@link SchemaSource}, so registering
 * the standard library never reaches the network even when one is configured.
 *
 * **Registration order is the whole algorithm.** The kernel is pre-loaded (Part 2 §3.4): it imports
 * nothing and `schema/bootstrap.ts`'s `bootstrapKernel` resolves it from its own source. Each library is
 * then resolved after everything it imports is registered -- `numeric.tn`, `temporal.tn` and `net.tn`
 * import the kernel alone, `core.tn` the three, `policy.tn` the kernel -- so `resolveImport` always finds
 * what it needs already present and never has to suspend, which is exactly the property `config.ts`'s own
 * note says `preload` exists to arrange for schemas that must be fetched.
 */
import { encodeUtf8 } from '../io/utf8.js';
import { bootstrapKernel } from '../schema/bootstrap.js';
import { linkSchema } from '../link/link.js';
import { createTson, type Config, type Tson } from '../config.js';
import {
  CORE_TN,
  META_TN,
  NET_TN,
  NUMERIC_TN,
  POLICY_TN,
  TEMPORAL_TN,
} from './schemas.generated.js';

export {
  CORE_TN,
  META_TN,
  NET_TN,
  NUMERIC_TN,
  POLICY_TN,
  TEMPORAL_TN,
} from './schemas.generated.js';

/**
 * Registers the kernel (`meta.tn`), `numeric.tn`, `temporal.tn`, `net.tn`, `core.tn` and
 * `policy.tn` into `tson`, in the order their imports require, and returns the same instance so a
 * caller can chain.
 *
 * Idempotent per instance is *not* claimed: registering twice is a caller error, and the registry
 * says so rather than silently accepting a second copy of a schema under the same identity.
 */
export function registerStandardLibrary(tson: Tson): Tson {
  // `io/utf8.ts`'s own encoder rather than the host `TextEncoder`: this project's type
  // configuration carries no `DOM` lib, and the library encodes UTF-8 itself everywhere else too.
  tson.register(linkSchema(bootstrapKernel(encodeUtf8(META_TN))));
  // The three data-format libraries each import the kernel alone (Part 2 §9).
  tson.resolveSchema(NUMERIC_TN);
  tson.resolveSchema(TEMPORAL_TN);
  tson.resolveSchema(NET_TN);
  // Core imports the three libraries and declares the author annotations.
  tson.resolveSchema(CORE_TN);
  // The processor-policy vocabulary (Part 1 §8.2) imports the kernel alone. Nothing here loads a
  // policy *document*, and no document or schema selects the policy it is judged under.
  tson.resolveSchema(POLICY_TN);
  return tson;
}

/**
 * A fresh {@link Tson} with the standard library already registered — `createTson(config)` plus
 * {@link registerStandardLibrary}, which is what the reference implementation's
 * `Tson.builder().build()` hands back.
 *
 * Deliberately not a module-level singleton. A registry is mutable state, and two callers sharing
 * one would see each other's registrations; building three small, already-in-memory schemas costs
 * a few milliseconds, which is not something worth trading that for.
 */
export function standardLibrary(config: Config = {}): Tson {
  return registerStandardLibrary(createTson(config));
}
