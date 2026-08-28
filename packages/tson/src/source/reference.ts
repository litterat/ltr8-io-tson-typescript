/**
 * One schema reference checked against [TSON-DATA] §2.2.1's rules on what an identifying URI may
 * be, shared by {@link httpSchemaSource}/{@link fileSchemaSource} — the port of the reference
 * implementation's `SchemaReference` (`tson/src/main/java/io/ltr8/tson/SchemaReference.java`).
 * See that file's own module doc for the exhaustive rationale; this module states only what
 * differs in the port.
 *
 * **Identity is not location.** §2.2.1 makes a reference's canonical identity its lowercase host
 * plus path — the scheme is a transport hint, not part of the name, and the `?sha256=` pin is
 * verification metadata. What a reference *names* is settled once, here; where a given source
 * goes to get it (an HTTPS origin, a directory on disk) is that source's own business.
 *
 * **This is a security check, run before either source ever opens a connection or a file.**
 * {@link permittedReference} reuses `link/identity.ts`'s own {@link canonicalizeIdentity} for
 * every rule §2.2.1 states on the identity itself (lowercase host, no userinfo, no port, no
 * fragment, no dot-segments, no illegally-percent-encoded unreserved character) rather than
 * restating them — the reference reaching a source came out of a document, which in a server came
 * out of a request body, and two independent implementations of the same rule are two places for
 * one of them to drift lenient. What this module adds on top is host/path *splitting* (needed for
 * allow-list matching and for resolving a location under it), which canonical identity computation
 * deliberately does not expose, and the `?sha256=`-pin-required check neither source enforces
 * without being asked to.
 *
 * **What this deliberately does not do**, matching the reference implementation's own scope: it
 * does not verify a `?sha256=` pin against fetched content, and does not cross-check a fetched
 * document's own embedded `!!id`. Both are the loader's job, run *after* a source returns bytes —
 * repeating either here would be a second implementation of `link/contentHash.ts`'s own check to
 * drift from.
 */
import { TsonSchemaFetchError, TsonSchemaValidationError } from '../core/errors.js';
import { canonicalizeIdentity } from '../link/identity.js';
import { declaredSha256 } from '../link/contentHash.js';

/** A reference that has passed every identity/policy check §2.2.1 states — what it names, split for a source's own use. */
export interface PermittedReference {
  /** The canonical identity (`host + path`) — what this reference *names*, per §2.2.1. */
  readonly canonical: string;
  /** The lowercase host alone — what an allow-list is matched against. */
  readonly host: string;
  /** The path alone (always `canonical.slice(host.length)`), always starting `/` or empty. */
  readonly path: string;
}

// RFC 3986 Appendix B's own generic-syntax splitting regex, narrowed to the one capture this
// module needs (the authority). Run only *after* `canonicalizeIdentity` has already required an
// absolute URI with no userinfo/port in that authority, so the captured text is exactly the host.
const SCHEME_AUTHORITY = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/u;

/** Builds a {@link TsonSchemaFetchError} with reason `'not-permitted'` — the shared shape every policy refusal in `httpSchemaSource.ts`/`fileSchemaSource.ts` throws. */
export function notPermitted(reference: string, message: string): TsonSchemaFetchError {
  return new TsonSchemaFetchError(
    reference,
    'not-permitted',
    `cannot fetch schema '${reference}': ${message}`,
  );
}

/**
 * `reference` as a permitted identity, or a {@link TsonSchemaFetchError} with reason
 * `'not-permitted'` — thrown before any connection is opened or file is touched, per this
 * module's own top note.
 *
 * @param requireContentHashPin refuse a reference carrying no `?sha256=` pin (§2.2.1's own
 *   strongest control against a permitted host later being compromised — off by default, since a
 *   self-describing document naming a plain URL is the ordinary case).
 */
export function permittedReference(
  reference: string,
  requireContentHashPin: boolean,
): PermittedReference {
  let canonical: string;
  try {
    canonical = canonicalizeIdentity(reference);
  } catch (error) {
    throw notPermitted(reference, messageOf(error));
  }
  const host = SCHEME_AUTHORITY.exec(reference)?.[1];
  // Unreachable against a `reference` that already passed `canonicalizeIdentity`: that function
  // itself requires an absolute URI with a non-empty authority, and this regex captures exactly
  // that authority. Guarded rather than asserted away, matching this project's own rule against
  // non-null assertions.
  if (host === undefined || host === '') {
    throw notPermitted(reference, 'is not an absolute URI with a host');
  }
  // Checked unconditionally, not only when a pin is required: a malformed `?sha256=` value (bad
  // length, non-hex, an unrecognised query parameter alongside it) makes `reference` itself
  // malformed, which is a `'not-permitted'` refusal regardless of this source's own pin policy --
  // never silently accepted as "no pin" just because none was required.
  let pinned: string | undefined;
  try {
    pinned = declaredSha256(reference);
  } catch (error) {
    throw notPermitted(reference, messageOf(error));
  }
  if (requireContentHashPin) {
    if (pinned === undefined) {
      throw notPermitted(
        reference,
        'carries no ?sha256= content-hash pin, and this source requires one',
      );
    }
  }
  return { canonical, host, path: canonical.slice(host.length) };
}

function messageOf(error: unknown): string {
  return error instanceof TsonSchemaValidationError ? error.message : String(error);
}
