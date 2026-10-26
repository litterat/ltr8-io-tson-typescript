/**
 * Canonical identity ([TSON-DATA] §2.2.1): how a schema is named. An identity is an IRI, split into
 * a host and a path; the scheme is a transport hint and the query verification metadata (the
 * `?sha256=` pin `contentHash.ts` reads), so both are removed, and what remains -- the host's
 * canonical text plus the path -- is the identity, compared byte for byte.
 *
 * **The host is a `host` value** (§2.2.1, §5.5): RFC 3987's `ihost` with a DNS name. A registered
 * name must be a `hostname`, an IP literal an `ipv6`, an `IPv4address` an `ipv4`; IPvFuture and
 * zone identifiers are refused. The identity carries the host's canonical text -- lowercase
 * U-labels, a dotted-quad, RFC 5952 text in brackets -- so `Example.COM` and `example.com` are one
 * identity, as are `xn--bcher-kva.example` and `bücher.example`, and `[::1]` and `[0:0:0:0:0:0:0:1]`.
 *
 * **The path is NFC, and its URI spelling is read back:** each percent-encoded UTF-8 sequence of a
 * character beyond US-ASCII is that character, and hex case is not significant, so `sch%c3%a9mas`
 * and `schémas` are one path. What has no IRI form stays an error -- a percent-encoding that is not
 * the UTF-8 of an IRI character (`%FF`, an encoded bidi control), an encoded character that is not
 * NFC -- as does percent-encoding an unreserved ASCII character, a dot-segment, userinfo, a port
 * and a fragment. A percent-encoded reserved character (`%2F`) is part of the identity, written in
 * uppercase hex.
 *
 * **Two entry points, because a document's own name has one spelling.**
 * {@link canonicalizeIdentity} reads a *reference* -- `!!schema`, `!!import`, a source's key, a
 * request path -- in any spelling of its identity. {@link validateIdentity} judges a document's own
 * `!!id`, which must already be written in canonical form: the canonical host, the path with no
 * character beyond US-ASCII percent-encoded, reserved encodings in uppercase hex. Every published
 * document then has one spelling of its name. {@link identityToUri} is the other direction, a
 * reference's URI spelling for a wire that carries US-ASCII only.
 *
 * **An identity without a host is its absolute path.** A reference with no authority (`/x.tn`,
 * `file:/x.tn`) or an empty one (`file:///x.tn`) has an empty host, and its identity is the path
 * alone, which MUST begin with `/`: a relative `tson.io/2026/38/m/core.tn` would be the identity
 * `https://tson.io/2026/38/m/core.tn` reduces to, so the two kinds of identity are disjoint by their
 * first character. `/x.tn`, `file:/x.tn` and `file:///x.tn` are one identity.
 *
 * **Why this splits by hand rather than using the host `URL`.** The WHATWG `URL` is a *normalising*
 * parser -- it lowercases the host, resolves dot-segments, and percent-encodes or -decodes on its
 * own initiative -- and its host rules are UTS #46's, which map where IDNA2008 refuses. The
 * components are split with the generic expression RFC 3986 Appendix B itself specifies, after the
 * hand-written IRI grammar `!iri` uses has accepted the whole reference; the "no host regex" rule
 * in `CLAUDE.md` is scoped to `src/base/` and `src/atom/`'s grammars, not to URI splitting.
 */
import { TsonSchemaValidationError } from '../core/errors.js';
import { isIriReference } from '../atom/network/uri.js';
import { isUcscharCode } from '../atom/network/uriGrammar.js';
import { parseHostText, type HostValue } from '../atom/network/host.js';
import { toNfc } from '../unicode/nfc.js';

const UNRESERVED = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'.split(''),
);

const HEX_DIGITS = '0123456789ABCDEF';

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

/** A host as an identity holds it, read from the host as a reference wrote it. */
interface IdentityHost {
  /** The host's canonical text; an IPv6 address in the brackets the IRI grammar needs. */
  readonly canonical: string;
  /** The host for a URI: a host name's A-labels, otherwise the canonical text. */
  readonly ascii: string;
}

/** Reads `written`, the host as it stands in an authority (an IPv6 literal bracketed), as a `host` value. */
function readHost(reference: string, written: string): IdentityHost {
  if (written.startsWith('[') && (written[1] === 'v' || written[1] === 'V')) {
    throw new TsonSchemaValidationError(
      `'${reference}' has an IPvFuture host, which no identity can hold: an identity's host is a ` +
        'host name or an IPv4 or IPv6 address',
    );
  }
  const parsed = parseHostText(written);
  if (!parsed.ok) {
    throw new TsonSchemaValidationError(
      `'${reference}' has the host '${written}', which ${parsed.reason}`,
    );
  }
  return identityHost(parsed.value);
}

function identityHost(host: HostValue): IdentityHost {
  switch (host.kind) {
    case 'hostname':
      return { canonical: host.unicode, ascii: host.ascii };
    case 'ipv4':
      return { canonical: host.text, ascii: host.text };
    case 'ipv6':
      return { canonical: `[${host.text}]`, ascii: `[${host.text}]` };
  }
}

/** The octet a `%XX` triplet at `at` encodes, hex digits in either case. */
function octetAt(reference: string, text: string, at: number): number {
  const high = hexValue(text.charCodeAt(at + 1));
  const low = hexValue(text.charCodeAt(at + 2));
  if (at + 2 >= text.length || high < 0 || low < 0) {
    throw new TsonSchemaValidationError(`'${reference}' has a malformed percent-encoding`);
  }
  return (high << 4) | low;
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

/**
 * The code points of `bytes` read as UTF-8, or `undefined` when they are not the UTF-8 of any
 * character: a bad lead or continuation byte, a truncated sequence, an overlong form, a surrogate,
 * or a value past U+10FFFF.
 */
function decodeUtf8(bytes: readonly number[]): number[] | undefined {
  const codePoints: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const first = bytes[i] ?? 0;
    let continuations: number;
    let codePoint: number;
    if (first < 0x80) {
      continuations = 0;
      codePoint = first;
    } else if ((first & 0xe0) === 0xc0) {
      continuations = 1;
      codePoint = first & 0x1f;
    } else if ((first & 0xf0) === 0xe0) {
      continuations = 2;
      codePoint = first & 0x0f;
    } else if ((first & 0xf8) === 0xf0) {
      continuations = 3;
      codePoint = first & 0x07;
    } else {
      return undefined;
    }
    for (let k = 1; k <= continuations; k++) {
      const next = bytes[i + k];
      if (next === undefined || (next & 0xc0) !== 0x80) return undefined;
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    const shortest =
      continuations === 0 ? 0 : continuations === 1 ? 0x80 : continuations === 2 ? 0x800 : 0x10000;
    if (codePoint < shortest) return undefined;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return undefined;
    if (codePoint > 0x10ffff) return undefined;
    codePoints.push(codePoint);
    i += continuations + 1;
  }
  return codePoints;
}

/** RFC 3987 §4.1's bidi formatting characters, which an IRI MUST NOT hold. */
function isBidiFormatting(codePoint: number): boolean {
  return (
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0x061c
  );
}

function hexOf(codePoint: number): string {
  return codePoint.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * The path read back from its URI spelling: each percent-encoded UTF-8 sequence of an IRI
 * character beyond US-ASCII decoded, every other encoding kept in uppercase hex, and the result
 * required NFC.
 */
function readPath(reference: string, written: string): string {
  for (const segment of written.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new TsonSchemaValidationError(`'${reference}' contains a dot-segment in its path`);
    }
  }
  let path = '';
  let i = 0;
  while (i < written.length) {
    if (written[i] !== '%') {
      path += written[i] ?? '';
      i += 1;
      continue;
    }
    const octet = octetAt(reference, written, i);
    if (octet < 0x80) {
      const character = String.fromCharCode(octet);
      if (UNRESERVED.has(character)) {
        throw new TsonSchemaValidationError(
          `'${reference}' percent-encodes the unreserved character '${character}'`,
        );
      }
      path += `%${HEX_DIGITS[octet >> 4] ?? ''}${HEX_DIGITS[octet & 0xf] ?? ''}`;
      i += 3;
      continue;
    }
    let end = i;
    const bytes: number[] = [];
    while (
      end < written.length &&
      written[end] === '%' &&
      octetAt(reference, written, end) >= 0x80
    ) {
      bytes.push(octetAt(reference, written, end));
      end += 3;
    }
    const decoded = decodeUtf8(bytes);
    if (decoded === undefined) {
      throw new TsonSchemaValidationError(
        `'${reference}' percent-encodes '${written.slice(i, end)}', which is not the UTF-8 of any ` +
          'character, so the reference has no IRI form',
      );
    }
    for (const codePoint of decoded) {
      if (!isUcscharCode(codePoint) || isBidiFormatting(codePoint)) {
        throw new TsonSchemaValidationError(
          `'${reference}' percent-encodes U+${hexOf(codePoint)}, which an IRI cannot hold as ` +
            'itself, so the reference has no IRI form',
        );
      }
      path += String.fromCodePoint(codePoint);
    }
    i = end;
  }
  if (toNfc(path) !== path) {
    throw new TsonSchemaValidationError(
      `'${reference}' has a path not in Normalization Form C -- the path is '${toNfc(path)}'`,
    );
  }
  return path;
}

/** `path` with each character beyond US-ASCII as its percent-encoded UTF-8. */
function percentEncodeBeyondAscii(path: string): string {
  let out = '';
  for (const character of path) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x80) {
      out += character;
      continue;
    }
    const bytes =
      codePoint < 0x800
        ? [0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f)]
        : codePoint < 0x10000
          ? [0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f)]
          : [
              0xf0 | (codePoint >> 18),
              0x80 | ((codePoint >> 12) & 0x3f),
              0x80 | ((codePoint >> 6) & 0x3f),
              0x80 | (codePoint & 0x3f),
            ];
    for (const byte of bytes)
      out += `%${HEX_DIGITS[byte >> 4] ?? ''}${HEX_DIGITS[byte & 0xf] ?? ''}`;
  }
  return out;
}

/**
 * A reference, read: the canonical identity and its parts, the same parts as the reference wrote
 * them (so {@link validateIdentity} can tell a canonical spelling from another), and the forms a
 * source needs to locate the document.
 */
export interface IdentityReading {
  /** The canonical identity: {@link host} plus {@link path}. */
  readonly identity: string;
  /** The host's canonical text -- lowercase U-labels, a dotted-quad, bracketed RFC 5952 text -- or `''`. */
  readonly host: string;
  /** The host for a URI authority: a name's A-labels, otherwise {@link host}. `''` when there is none. */
  readonly asciiHost: string;
  /** The canonical path: percent-encoding read back, NFC, reserved encodings in uppercase hex. */
  readonly path: string;
  /** {@link path} with each character beyond US-ASCII as its percent-encoded UTF-8, for a URI. */
  readonly uriPath: string;
  /** The host and path exactly as the reference wrote them. */
  readonly written: string;
  /** The reference's scheme, when it wrote one. */
  readonly scheme?: string;
  /** Whether the reference wrote an authority (`//…`), even an empty one. */
  readonly hasAuthority: boolean;
  /** The reference's query, when it wrote one. */
  readonly query?: string;
}

/**
 * Reads `reference` as an identifying IRI: any spelling of its identity, refused when it names none.
 *
 * @throws TsonSchemaValidationError if `reference` names no identity.
 */
export function readIdentity(reference: string): IdentityReading {
  if (!isIriReference(reference)) {
    throw new TsonSchemaValidationError(`'${reference}' is not a valid IRI-reference (RFC 3987)`);
  }
  const uri = split(reference);

  if (uri.fragment !== undefined) {
    throw new TsonSchemaValidationError(
      `'${reference}' carries a fragment, not permitted in an identifying URI`,
    );
  }

  let writtenHost = '';
  let host: IdentityHost = { canonical: '', ascii: '' };
  if (uri.authority !== undefined) {
    const parts = splitAuthority(uri.authority);
    if (parts.userinfo !== undefined) {
      throw new TsonSchemaValidationError(
        `'${reference}' carries userinfo, not permitted in an identifying URI`,
      );
    }
    if (parts.port !== undefined) {
      throw new TsonSchemaValidationError(
        `'${reference}' carries a port, not permitted in an identifying URI`,
      );
    }
    writtenHost = parts.host;
    if (writtenHost !== '') host = readHost(reference, writtenHost);
  }
  if (writtenHost === '' && !uri.path.startsWith('/')) {
    throw new TsonSchemaValidationError(
      `'${reference}' has no host and a path that is not absolute: an identity without a host ` +
        'names a library entry by an absolute path, so that it can never be one a host and path ' +
        'also spell',
    );
  }

  const path = readPath(reference, uri.path);
  return {
    identity: host.canonical + path,
    host: host.canonical,
    asciiHost: host.ascii,
    path,
    uriPath: percentEncodeBeyondAscii(path),
    written: writtenHost + uri.path,
    hasAuthority: uri.authority !== undefined,
    ...(uri.scheme !== undefined ? { scheme: uri.scheme } : {}),
    ...(uri.query !== undefined ? { query: uri.query } : {}),
  };
}

/**
 * The canonical identity of `reference`, in any spelling of it -- scheme and query removed, the
 * host read as a `host` value and the path read back from its URI spelling. `http://` and
 * `https://` spellings name one identity, and a `?sha256=` pin does not distinguish a pinned
 * reference from a plain one.
 *
 * @throws TsonSchemaValidationError if `reference` names no identity.
 */
export function canonicalizeIdentity(reference: string): string {
  return readIdentity(reference).identity;
}

/**
 * Judges a document's own `!!id`: `id` must name an identity and be written in its canonical form,
 * so a published document has one spelling of its name.
 *
 * @throws TsonSchemaValidationError if `id` names no identity, or names one in another spelling.
 */
export function validateIdentity(id: string): void {
  const reading = readIdentity(id);
  if (reading.written !== reading.identity) {
    let spelling = reading.scheme === undefined ? '' : `${reading.scheme}:`;
    if (reading.hasAuthority) spelling += '//';
    spelling += reading.identity;
    if (reading.query !== undefined) spelling += `?${reading.query}`;
    throw new TsonSchemaValidationError(
      `'${id}' is not written in canonical form, which a document's own !!id must be -- write '${spelling}'`,
    );
  }
}

/**
 * Whether two references name one identity -- {@link canonicalizeIdentity} applied to both, then
 * compared.
 *
 * @throws TsonSchemaValidationError if either names no identity.
 */
export function sameIdentity(reference: string, otherReference: string): boolean {
  return canonicalizeIdentity(reference) === canonicalizeIdentity(otherReference);
}

/**
 * `reference`'s URI spelling (RFC 3987 §3.1), scheme and query kept: the host by ToASCII, each
 * character of the path beyond US-ASCII as its percent-encoded UTF-8. The spelling a wire carrying
 * US-ASCII only needs; it names the identity `reference` does.
 *
 * @throws TsonSchemaValidationError if `reference` names no identity.
 */
export function identityToUri(reference: string): string {
  const reading = readIdentity(reference);
  let uri = reading.scheme === undefined ? '' : `${reading.scheme}:`;
  if (reading.hasAuthority) uri += `//${reading.asciiHost}`;
  uri += reading.uriPath;
  if (reading.query !== undefined) uri += `?${reading.query}`;
  return uri;
}

/**
 * A host in the form an identity's host takes -- a host name's lowercase U-labels, a dotted-quad,
 * an IPv6 address in brackets -- so an allow-list entry `xn--bcher-kva.example` and an identity
 * written `bücher.example` meet.
 *
 * @throws TsonSchemaValidationError if `host` is not a host.
 */
export function identityHostKey(host: string): string {
  return hostOf(host).canonical;
}

/** `host`'s ASCII form, for locating a document: a host name's A-labels, an IPv6 address in brackets. */
export function identityAsciiHost(host: string): string {
  return hostOf(host).ascii;
}

function hostOf(host: string): IdentityHost {
  const parsed = parseHostText(host);
  if (!parsed.ok) {
    throw new TsonSchemaValidationError(`'${host}' is not a host: it ${parsed.reason}`);
  }
  return identityHost(parsed.value);
}
