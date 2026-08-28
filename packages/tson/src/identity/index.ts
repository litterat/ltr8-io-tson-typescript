/**
 * `@ltr8/tson/identity` — [TSON-DATA] §2.2.1's two mechanisms, and nothing else: a reference's
 * **canonical identity** (what an `!!id`/`!!import`/`!!meta` URI is compared and registered
 * under) and a document's **content hash** (the `?sha256=` pin that makes a reference
 * content-addressed).
 *
 * This subpath exists because both are consumer-facing operations that the library previously
 * only performed inwardly. `Tson.preload` verifies a pin and the registry canonicalises every
 * identity, but a caller wanting to *compute* a hash for a document they hold — to stamp a
 * reference, to check one against a lock file, to write a `tson hash` of their own — had nothing
 * to call, and the alternative to exporting these is every such caller reimplementing §2.2.1.
 *
 * It is a separate subpath rather than part of the default entry for the reason that entry's own
 * note gives: an import should not drag in more than it needs. Nothing here reaches the schema
 * compiler, the lexer or the event stream — {@link sha256Hex} and {@link contentStart} operate on
 * raw bytes and {@link canonicalizeIdentity} on a URI string — so this is the smallest useful
 * piece of the library that a build can take on its own.
 *
 * `crypto.subtle` is the only platform API involved, and it is a global in Node 24 and in every
 * browser, so this subpath is not Node-only the way `@ltr8/tson/source` is.
 */
export {
  contentStart,
  declaredSha256,
  sha256Hex,
  verifyContentHash,
  withSha256Pin,
} from '../link/contentHash.js';
export { canonicalizeIdentity, sameIdentity, validateIdentity } from '../link/identity.js';
export { TsonContentHashMismatchError, TsonSchemaValidationError } from '../core/errors.js';
