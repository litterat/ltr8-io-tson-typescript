/**
 * The standard library, as this CLI wants it: the six bundled schemas registered into a
 * fresh `@ltr8/tson` registry, offline, with no `SchemaSource` configured at all.
 *
 * All of that lives in `@ltr8/tson/stdlib`, which embeds the same six documents as string
 * constants generated from `spec/m/` — so `tson validate --schema ...` works with no network
 * access, and nothing here ever reaches a `SchemaSource`. This module is the named seam over it,
 * so `commands/*.ts` say what they want ("the standard library") rather than how it is assembled.
 */
import { standardLibrary } from '@ltr8/tson/stdlib';
import type { Config, Tson } from '@ltr8/tson';

/**
 * A fresh {@link Tson} with the standard library registered.
 *
 * Deliberately not a module-level singleton: each call builds its own registry, so two commands
 * (or two test cases driving `main()` in the same process) never share mutable registration state.
 * Resolving six small, already-in-memory schemas costs nothing a CLI invocation needs to
 * amortise.
 *
 * `config` is forwarded to `standardLibrary` unchanged -- in practice `configOf`'s (`policyOptions.ts`): the
 * identifier and token policies and the two depth bounds. `identifierPolicy` is what
 * `Tson.resolveSchema` applies to a schema's own declared names at link time ([TSON-SCHEMA]
 * §11.4). The kernel (`meta.tn`)'s own bootstrap stays pinned to the library's default regardless
 * (`config.ts`'s own note on `identifierPolicy`), so relaxing this can never change whether the
 * kernel itself loads.
 */
export function stdlibTson(config?: Config): Tson {
  return standardLibrary(config);
}
