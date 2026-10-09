/**
 * Canonical identity ([TSON-DATA] §2.2.1): the algorithm every `!!id`/`!!import`/`!!meta` reference
 * is compared and registered under, and the half of that section not owned by `contentHash.ts`
 * (which reads the `?sha256=` pin this module strips).
 *
 * **This is not general URI normalisation.** §2.2.1 is explicit that a canonical identity is
 * reached by exactly two reductions — strip the scheme (and its `://` delimiter), strip the query
 * — and that everything else MUST already be canonical: lowercase host, no userinfo, no port, no
 * percent-encoding of an unreserved character, no dot-segments, no fragment. An identifier failing
 * any of those is an *error*, never something to fix up — "no case folding, path resolution, or
 * percent-decoding is ever performed at comparison time." {@link canonicalizeIdentity} therefore
 * performs only the two reductions the spec names; every other rule below is a rejection, never a
 * rewrite.
 *
 * **The reference is read as an IRI-reference** (§2.2.1, §3.3; RFC 3987 §2.2), by the same
 * hand-written grammar `!iri` uses, so a host or path beyond US-ASCII is held as written and
 * compared as written, and a percent-encoded spelling of the same characters is another identity.
 * A raw backslash, a space and every other character outside that grammar fail it.
 *
 * **An identity without a host is its absolute path.** A reference with no authority (`/x.tn`,
 * `file:/x.tn`) or an empty one (`file:///x.tn`) has an empty host, and its identity is the path
 * alone, which MUST begin with `/`: a relative `tson.io/2026/37/m/core.tn` would be the identity
 * `https://tson.io/2026/37/m/core.tn` reduces to, so the two kinds of identity are disjoint by
 * their first character. `/x.tn`, `file:/x.tn` and `file:///x.tn` are one identity.
 *
 * **Why this splits by hand rather than using the host `URL`.** The WHATWG `URL` is a
 * *normalising* parser — it lowercases the host, resolves dot-segments, and percent-encodes or
 * -decodes on its own initiative — exactly the behaviour §2.2.1 forbids. The components are split
 * with the generic expression RFC 3986 Appendix B itself specifies, after the grammar above has
 * accepted the whole reference; the "no host regex" rule in `CLAUDE.md` is scoped to `src/base/`'s
 * ABNF grammars, not to URI splitting.
 */
import { TsonSchemaValidationError } from '../core/errors.js';
import { isIriReference } from '../atom/network/uri.js';

const UNRESERVED = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'.split(''),
);

/** RFC 3986 Appendix B's own generic-syntax splitting regex, verbatim. */
const URI_SPLIT = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/u;

interface SplitUri {
  readonly scheme: string | undefined;
  readonly authority: string | undefined;
  readonly path: string;
  readonly query: string | undefined;
  readonly fragment: string | undefined;
}

function split(uriString: string): SplitUri {
  const match = URI_SPLIT.exec(uriString);
  // The regex above matches every string (every group is optional), so this is unreachable --
  // guarded rather than asserted away, matching this project's own no-non-null-assertion rule.
  if (match === null) {
    throw new TsonSchemaValidationError(`'${uriString}' is not a valid IRI-reference (RFC 3987)`);
  }
  return {
    scheme: match[1],
    authority: match[2],
    path: match[3] ?? '',
    query: match[4],
    fragment: match[5],
  };
}

/** Splits `authority` into userinfo/host/port, RFC 3986 §3.2's grammar (`[userinfo@]host[:port]`). */
function splitAuthority(authority: string): {
  readonly userinfo: string | undefined;
  readonly host: string;
  readonly port: string | undefined;
} {
  const at = authority.lastIndexOf('@');
  const userinfo = at === -1 ? undefined : authority.slice(0, at);
  const hostAndPort = at === -1 ? authority : authority.slice(at + 1);
  // An IPv6 literal (`[::1]:8080`) carries colons of its own; the port, if any, follows the `]`.
  if (hostAndPort.startsWith('[')) {
    const close = hostAndPort.indexOf(']');
    if (close === -1) {
      return { userinfo, host: hostAndPort, port: undefined };
    }
    const rest = hostAndPort.slice(close + 1);
    const port = rest.startsWith(':') ? rest.slice(1) : undefined;
    return { userinfo, host: hostAndPort.slice(0, close + 1), port };
  }
  const colon = hostAndPort.indexOf(':');
  if (colon === -1) {
    return { userinfo, host: hostAndPort, port: undefined };
  }
  return { userinfo, host: hostAndPort.slice(0, colon), port: hostAndPort.slice(colon + 1) };
}

/** RFC 3986 §2.3's unreserved characters MUST NOT be percent-encoded; anything else may be. */
function requireNoPercentEncodedUnreservedCharacters(uriString: string, component: string): void {
  for (let i = 0; i < component.length; i++) {
    if (component[i] !== '%') continue;
    const hex = component.slice(i + 1, i + 3);
    if (hex.length !== 2 || !/^[0-9a-fA-F]{2}$/u.test(hex)) {
      throw new TsonSchemaValidationError(`'${uriString}' has a malformed percent-encoding`);
    }
    const decoded = Number.parseInt(hex, 16);
    if (decoded < 128 && UNRESERVED.has(String.fromCharCode(decoded))) {
      throw new TsonSchemaValidationError(
        `'${uriString}' percent-encodes the unreserved character '${String.fromCharCode(decoded)}'`,
      );
    }
    i += 2;
  }
}

/**
 * The canonical identity of `uriString` — scheme and query stripped, the rest required already
 * canonical. This is the identity references are matched by, so a `?sha256=` pin (verification
 * metadata, not identity) doesn't distinguish a pinned reference from a plain one, and `http://`
 * and `https://` spellings name the same thing.
 *
 * @throws TsonSchemaValidationError if `uriString` isn't a valid canonical-identity candidate.
 */
export function canonicalizeIdentity(uriString: string): string {
  if (!isIriReference(uriString)) {
    throw new TsonSchemaValidationError(`'${uriString}' is not a valid IRI-reference (RFC 3987)`);
  }
  const uri = split(uriString);

  if (uri.fragment !== undefined) {
    throw new TsonSchemaValidationError(
      `'${uriString}' carries a fragment, not permitted in an identifying URI`,
    );
  }

  let host = '';
  if (uri.authority !== undefined) {
    const parts = splitAuthority(uri.authority);
    if (parts.userinfo !== undefined) {
      throw new TsonSchemaValidationError(
        `'${uriString}' carries userinfo, not permitted in an identifying URI`,
      );
    }
    if (parts.port !== undefined) {
      throw new TsonSchemaValidationError(
        `'${uriString}' carries a port, not permitted in an identifying URI`,
      );
    }
    host = parts.host;
    if (host !== host.toLowerCase()) {
      throw new TsonSchemaValidationError(`'${uriString}' has a non-lowercase host '${host}'`);
    }
  }
  if (host === '' && !uri.path.startsWith('/')) {
    throw new TsonSchemaValidationError(
      `'${uriString}' has no host and a path that is not absolute: an identity without a host ` +
        'names a library entry by an absolute path, so that it can never be one a host and path ' +
        'also spell',
    );
  }

  for (const segment of uri.path.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new TsonSchemaValidationError(`'${uriString}' contains a dot-segment in its path`);
    }
  }

  requireNoPercentEncodedUnreservedCharacters(uriString, host);
  requireNoPercentEncodedUnreservedCharacters(uriString, uri.path);

  return host + uri.path;
}

/**
 * Runs {@link canonicalizeIdentity}'s checks and discards the identity — for a caller validating
 * a candidate `!!id` up front (before resolving a whole document that will eventually need one)
 * rather than looking anything up. Exists so intent reads at the call site, where computing an
 * identity only to throw it away would not.
 *
 * @throws TsonSchemaValidationError if `uriString` isn't a valid canonical-identity candidate.
 */
export function validateIdentity(uriString: string): void {
  canonicalizeIdentity(uriString);
}

/**
 * Whether two URIs name one identity — {@link canonicalizeIdentity} applied to both, then
 * compared. The spelling-insensitive comparison §2.2.1 calls for: scheme and `?sha256=` pin
 * differences don't make two references distinct.
 *
 * @throws TsonSchemaValidationError if either argument isn't a valid canonical-identity candidate.
 */
export function sameIdentity(uriString: string, otherUriString: string): boolean {
  return canonicalizeIdentity(uriString) === canonicalizeIdentity(otherUriString);
}
