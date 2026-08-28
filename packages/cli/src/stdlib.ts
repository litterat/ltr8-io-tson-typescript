/**
 * The standard library, as this CLI wants it: `meta-kernel`/`meta.tn`/`core.tn` registered into a
 * fresh `@ltr8/tson` registry, offline, with no `SchemaSource` configured at all.
 *
 * All of that lives in `@ltr8/tson/stdlib`, which embeds the same three documents as string
 * constants generated from `spec/m/` — so `tson validate --schema ...` works with no network
 * access, and nothing here ever reaches a `SchemaSource`. This module is the named seam over it,
 * so `commands/*.ts` say what they want ("the standard library") rather than how it is assembled.
 */
import { standardLibrary } from '@ltr8/tson/stdlib';
import type { Tson } from '@ltr8/tson';

/**
 * A fresh {@link Tson} with the standard library registered.
 *
 * Deliberately not a module-level singleton: each call builds its own registry, so two commands
 * (or two test cases driving `main()` in the same process) never share mutable registration state.
 * Resolving three small, already-in-memory schemas costs nothing a CLI invocation needs to
 * amortise.
 */
export function stdlibTson(): Tson {
  return standardLibrary();
}
