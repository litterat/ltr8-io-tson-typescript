/**
 * `@ltr8/tson/stdlib` — the three schemas every TSON schema is ultimately written against
 * (`meta-kernel`, `meta.tn`, `core.tn`), embedded as source text, and the one function that
 * registers them into a {@link Tson}.
 *
 * **Its own subpath, never the default entry.** The reference implementation's
 * `Tson.builder().build()` loads all three from packaged classpath resources before a caller does
 * anything, and a JVM can afford that. A browser bundle cannot: someone importing `parse` to read
 * a document with no schema in scope should not carry 45 KB of schema text they will never look
 * at. Splitting it out is what lets both callers get what they want — `import { standardLibrary }
 * from '@ltr8/tson/stdlib'` is one line, and not writing that line costs nothing.
 *
 * **No I/O, on any platform.** The three documents are string constants generated into
 * `schemas.generated.ts` from `spec/m/` by `scripts/gen-stdlib-schemas.mjs`, not files read at
 * run time — a published package is not installed next to this repository's `spec/`, and a
 * browser cannot read files at all. Nothing here touches a {@link SchemaSource}, so registering
 * the standard library never reaches the network even when one is configured.
 *
 * **Registration order is the whole algorithm.** `meta-kernel`'s `!!meta` names itself (§1.5), so
 * it cannot be resolved the ordinary way and goes through `schema/bootstrap.ts`'s own
 * `bootstrapMetaKernel`; `meta.tn` then resolves against the registered kernel and `core.tn`
 * against both. Because each is registered before the next is resolved, `resolveImport` always
 * finds what it needs already present and never has to suspend — which is exactly the property
 * `config.ts`'s own note says `preload` exists to arrange for schemas that must be fetched.
 */
import { encodeUtf8 } from '../io/utf8.js';
import { bootstrapMetaKernel } from '../schema/bootstrap.js';
import { linkSchema } from '../link/link.js';
import { createTson, type Config, type Tson } from '../config.js';
import { CORE_TN, META_KERNEL_TN, META_TN } from './schemas.generated.js';

export { CORE_TN, META_KERNEL_TN, META_TN } from './schemas.generated.js';

/**
 * Registers `meta-kernel`, `meta.tn` and `core.tn` into `tson`, in the order their dependencies
 * require, and returns the same instance so a caller can chain.
 *
 * Idempotent per instance is *not* claimed: registering twice is a caller error, and the registry
 * says so rather than silently accepting a second copy of a schema under the same identity.
 */
export function registerStandardLibrary(tson: Tson): Tson {
  // `io/utf8.ts`'s own encoder rather than the host `TextEncoder`: this project's type
  // configuration carries no `DOM` lib, and the library encodes UTF-8 itself everywhere else too.
  tson.register(linkSchema(bootstrapMetaKernel(encodeUtf8(META_KERNEL_TN))));
  // Then meta-kernel again, ordinarily, governed by the bootstrap output just registered --
  // exactly what `schema/bootstrap.ts` says to do: "a caller wanting meta-kernel's entries
  // properly marked runs `resolveSchema` over the same document instead, governed by this
  // function's own output". The bootstrap route exists to break §1.5's circularity (meta-kernel's
  // `!!meta` names itself) and stops there: it attaches no `@synthetic` marker to the entries it
  // lifts and carries no key annotations at all, so without this second pass the standard
  // library's own kernel is the one schema in it missing both. It re-registers under the same
  // canonical identity, replacing the transient form.
  tson.resolveSchema(META_KERNEL_TN);
  tson.resolveSchema(META_TN);
  tson.resolveSchema(CORE_TN);
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
