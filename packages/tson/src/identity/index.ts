/**
 * `@ltr8/tson/identity` — [TSON-DATA] §2.2.1's two mechanisms, and nothing else: a reference's
 * **canonical identity** (what an `!!id`/`!!import`/`!!meta` URI is compared and registered
 * under) and a document's **content hash** (the `?sha256=` pin that makes a reference
 * content-addressed).
 *
 * This subpath exists because both are consumer-facing operations in their own right, distinct
 * from `Tson.preload`'s pin verification and the registry's identity canonicalisation. A caller
 * wanting to *compute* a hash for a document they hold — to stamp a reference, to check one
 * against a lock file, to write a `tson hash` of their own — calls here rather than
 * reimplementing §2.2.1.
 *
 * It is a separate subpath rather than part of the default entry for the reason that entry's own
 * note gives: an import should not drag in more than it needs. Nothing here reaches the schema
 * compiler, the lexer or the event stream — {@link sha256HexSync} and {@link contentStart}
 * operate on raw bytes and {@link canonicalizeIdentity} on a URI string — so this is the smallest
 * useful piece of the library that a build can take on its own.
 *
 * No platform API is involved at all: `link/contentHash.ts`'s own SHA-256 is a hand-written,
 * zero-dependency implementation (`CLAUDE.md`'s own constraint), so this subpath is not Node-only
 * the way `@ltr8/tson/source` is, and {@link sha256HexSync} needs no `await` to use.
 */
export {
  contentStart,
  declaredSha256,
  sha256Hex,
  sha256HexSync,
  verifyContentHash,
  withSha256Pin,
} from '../link/contentHash.js';
export { canonicalizeIdentity, sameIdentity, validateIdentity } from '../link/identity.js';
export { TsonContentHashMismatchError, TsonSchemaValidationError } from '../core/errors.js';
