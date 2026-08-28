/**
 * Bootstraps the standard library (meta-kernel, meta.tn, core.tn) into a fresh `@ltr8/tson`
 * registry -- the sequence `@ltr8/tson`'s own `config.ts` documents at its top ("A caller wanting
 * the standard library registers it themselves") and `STATUS.md`'s "known gaps" names as
 * deliberately out of `@ltr8/tson`'s own scope: a browser consumer of `parse`/`readTree` should
 * not pay for a standard library it never asked to load.
 *
 * This CLI always wants it, and always wants it offline -- `tson validate --schema ...` has to
 * work with no network access -- so it carries its own copy the same way `spec/` itself is
 * vendored, generated once by `scripts/gen-cli-bundled-schemas.mjs` into
 * `bundledSchemas.generated.ts` and embedded as string constants rather than read from disk at
 * run time (a published `@ltr8/tson-cli` package is not installed next to this repository's
 * `spec/` directory).
 *
 * **No network fetch is involved.** `meta.tn`'s own `!!meta`/`!!import` and `core.tn`'s own
 * `!!meta` both name meta-kernel/meta.tn by canonical identity (query-stripped), so registering
 * them in dependency order with {@link Tson.resolveSchema} alone -- exactly `config.ts`'s own
 * documented bootstrap sequence, minus `preload`, which exists only to *fetch* a schema this
 * module already has the bytes for -- is enough; nothing here ever calls `Tson.preload`/`fetch`,
 * so no `SchemaSource` is configured at all.
 */
import { bootstrapMetaKernel, createTson, linkSchema, type Tson } from '@ltr8/tson';
import { CORE_TN, META_KERNEL_TN, META_TN } from './bundledSchemas.generated.js';

/**
 * A fresh {@link Tson} instance with meta-kernel/meta.tn/core.tn already registered.
 *
 * Deliberately not a module-level singleton: each call builds its own registry from scratch, so
 * two commands (or two test cases driving `main()` in the same process) never share mutable
 * registration state. Resolving three small, already-in-memory schemas costs nothing a CLI
 * invocation needs to amortise.
 */
export function stdlibTson(): Tson {
  const tson = createTson({});
  const metaKernelBytes = new TextEncoder().encode(META_KERNEL_TN);
  tson.register(linkSchema(bootstrapMetaKernel(metaKernelBytes)));
  tson.resolveSchema(META_TN);
  tson.resolveSchema(CORE_TN);
  return tson;
}
