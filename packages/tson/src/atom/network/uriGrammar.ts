/**
 * A hand-written RFC 3986 `URI-reference` grammar and its RFC 3987 `IRI-reference` extension,
 * shared by `uri.ts` and the directive-argument check -- no `RegExp`, one function per ABNF
 * production, the same "a token is already fully decoded text by the time an atom sees it, so a
 * hand-scanned character walk is both the simplest and the most auditable way to enforce a
 * grammar this exact" discipline `temporal/rfc3339.ts` documents for its own grammar.
 *
 * Both grammars are one set of productions parameterised by {@link UriGrammar}: under `iri`,
 * `ucschar` stands beside `unreserved` in every component (RFC 3987 §2.2) and `iprivate` stands
 * in the query alone. An IP literal stays US-ASCII under either. Characters are addressed as code
 * points, never UTF-16 units, so a supplementary-plane `ucschar` is one character.
 *
 * **A deliberate divergence from the JDK-leaning part of the reference.** `java.net.URI`
 * implements RFC 2396; the reference parses RFC 3986 itself (`IriGrammar.java`) and so does this
 * port, which has no host URI type at all.
 */

const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;
const ASCII_UPPER_A = 0x41;
const ASCII_UPPER_F = 0x46;
const ASCII_UPPER_Z = 0x5a;
const ASCII_LOWER_A = 0x61;
const ASCII_LOWER_F = 0x66;
const ASCII_LOWER_Z = 0x7a;
const ASCII_PERCENT = 0x25;
const ASCII_COLON = 0x3a;
const ASCII_SLASH = 0x2f;
const ASCII_QUESTION = 0x3f;
const ASCII_HASH = 0x23;
const ASCII_AT = 0x40;
const ASCII_OPEN_BRACKET = 0x5b;
const ASCII_DOT = 0x2e;
const ASCII_PLUS = 0x2b;
const ASCII_HYPHEN = 0x2d;
const ASCII_LOWER_V = 0x76;
const ASCII_UPPER_V = 0x56;

function isAlphaCode(code: number): boolean {
  return (
    (code >= ASCII_UPPER_A && code <= ASCII_UPPER_Z) ||
    (code >= ASCII_LOWER_A && code <= ASCII_LOWER_Z)
  );
}

function isDigitCode(code: number): boolean {
  return code >= ASCII_ZERO && code <= ASCII_NINE;
}

function isHexDigitCode(code: number): boolean {
  return (
    isDigitCode(code) ||
    (code >= ASCII_UPPER_A && code <= ASCII_UPPER_F) ||
    (code >= ASCII_LOWER_A && code <= ASCII_LOWER_F)
  );
}

/** `unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~"` (RFC 3986 §2.3). */
function isUnreservedCode(code: number): boolean {
  return (
    isAlphaCode(code) ||
    isDigitCode(code) ||
    code === ASCII_HYPHEN ||
    code === ASCII_DOT ||
    code === 0x5f ||
    code === 0x7e
  );
}

/** `sub-delims = "!" / "$" / "&" / "'" / "(" / ")" / "*" / "+" / "," / ";" / "="` (RFC 3986 §2.2). */
const SUB_DELIM_CHARS = "!$&'()*+,;=";

function isSubDelimCode(code: number): boolean {
  return SUB_DELIM_CHARS.includes(String.fromCharCode(code));
}

/** `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )` (RFC 3986 §3.1). */
function isSchemeTailCode(code: number): boolean {
  return (
    isAlphaCode(code) ||
    isDigitCode(code) ||
    code === ASCII_PLUS ||
    code === ASCII_HYPHEN ||
    code === ASCII_DOT
  );
}

/** `userinfo = *( unreserved / pct-encoded / sub-delims / ":" )` (RFC 3986 §3.2.1). */
function isUserinfoCode(code: number): boolean {
  return isUnreservedCode(code) || isSubDelimCode(code) || code === ASCII_COLON;
}

/** `reg-name = *( unreserved / pct-encoded / sub-delims )` (RFC 3986 §3.2.2). */
function isRegNameCode(code: number): boolean {
  return isUnreservedCode(code) || isSubDelimCode(code);
}

/** `pchar = unreserved / pct-encoded / sub-delims / ":" / "@"` (RFC 3986 §3.3). */
function isPcharCode(code: number): boolean {
  return (
    isUnreservedCode(code) || isSubDelimCode(code) || code === ASCII_COLON || code === ASCII_AT
  );
}

/** `segment-nz-nc`'s own charset (RFC 3986 §3.3): `pchar` minus `":"`, so a relative reference's
 * first segment can never be mistaken for a scheme. */
function isPcharNoColonCode(code: number): boolean {
  return isUnreservedCode(code) || isSubDelimCode(code) || code === ASCII_AT;
}

/** `query = *( pchar / "/" / "?" )`, and `fragment` shares the identical production (RFC 3986 §3.4/§3.5). */
function isQueryOrFragmentCode(code: number): boolean {
  return isPcharCode(code) || code === ASCII_SLASH || code === ASCII_QUESTION;
}

/**
 * The grammar a reference is read under: RFC 3986's `URI-reference` (`iri: false`, US-ASCII
 * throughout) or RFC 3987's `IRI-reference` (`iri: true`). `parseIpv6` lets the caller supply
 * `ipv6.ts`'s strict address grammar for `IP-literal` without this module importing it, so it
 * stays a pure grammar (mirroring `temporal/rfc3339.ts`).
 */
export interface UriGrammar {
  readonly iri: boolean;
  readonly parseIpv6: (candidate: string) => boolean;
}

/** Which characters beyond US-ASCII a component admits under the IRI grammar (RFC 3987 §2.2). */
type Beyond = 'none' | 'ucschar' | 'ucschar-iprivate';

/**
 * `ucschar` (RFC 3987 §2.2): the BMP's letters and marks from U+00A0, then each plane from 1 to 14
 * but for its two last code points and plane 14's first 0x1000.
 */
export function isUcscharCode(code: number): boolean {
  if (
    (code >= 0xa0 && code <= 0xd7ff) ||
    (code >= 0xf900 && code <= 0xfdcf) ||
    (code >= 0xfdf0 && code <= 0xffef)
  ) {
    return true;
  }
  const plane = code >>> 16;
  return (
    plane >= 1 && plane <= 14 && (code & 0xffff) <= 0xfffd && (plane !== 14 || code >= 0xe1000)
  );
}

/** `iprivate` (RFC 3987 §2.2): the private-use area and planes 15 and 16. */
export function isIprivateCode(code: number): boolean {
  return (code >= 0xe000 && code <= 0xf8ff) || (code >= 0xf0000 && (code & 0xffff) <= 0xfffd);
}

/**
 * Consumes the maximal run of `text[pos..)` where every character either satisfies `isAllowed`
 * (US-ASCII only), is a `pct-encoded = "%" HEXDIG HEXDIG` triple, or is a code point beyond
 * US-ASCII that `beyond` admits (unioned into nearly every production below). Returns the position
 * just past the run -- `pos` itself if nothing matched.
 */
function readCharClassRun(
  text: string,
  pos: number,
  beyond: Beyond,
  isAllowed: (code: number) => boolean,
): number {
  const end = text.length;
  let i = pos;
  while (i < end) {
    const code = text.codePointAt(i) ?? 0;
    if (code === ASCII_PERCENT) {
      if (
        i + 2 < end &&
        isHexDigitCode(text.charCodeAt(i + 1)) &&
        isHexDigitCode(text.charCodeAt(i + 2))
      ) {
        i += 3;
        continue;
      }
      break;
    }
    if (code < 0x80) {
      if (!isAllowed(code)) break;
    } else if (
      beyond === 'none' ||
      !(isUcscharCode(code) || (beyond === 'ucschar-iprivate' && isIprivateCode(code)))
    ) {
      break;
    } else {
      i += code > 0xffff ? 2 : 1;
      continue;
    }
    i += 1;
  }
  return i;
}

/** What a component admits beyond US-ASCII under `g`. */
function ucs(g: UriGrammar): Beyond {
  return g.iri ? 'ucschar' : 'none';
}

/** `scheme` starting at `pos` (always 0 in practice), or `undefined` if `text` does not start
 * with `ALPHA` at all -- the one production here with a mandatory first character unlike the rest. */
function tryReadScheme(text: string, pos: number): number | undefined {
  if (pos >= text.length || !isAlphaCode(text.charCodeAt(pos))) return undefined;
  let i = pos + 1;
  while (i < text.length && isSchemeTailCode(text.charCodeAt(i))) i += 1;
  return i;
}

/** `IPvFuture = "v" 1*HEXDIG "." 1*( unreserved / sub-delims / ":" )` (RFC 3986 §3.2.2). `inner`
 * excludes the surrounding `[`/`]`; its first character was already confirmed to be `v`/`V`. */
function isValidIpvFuture(inner: string): boolean {
  let i = 1;
  const digitsStart = i;
  while (i < inner.length && isHexDigitCode(inner.charCodeAt(i))) i += 1;
  if (i === digitsStart) return false;
  if (i >= inner.length || inner.charCodeAt(i) !== ASCII_DOT) return false;
  i += 1;
  const bodyStart = i;
  while (i < inner.length) {
    const code = inner.charCodeAt(i);
    if (!isUnreservedCode(code) && !isSubDelimCode(code) && code !== ASCII_COLON) break;
    i += 1;
  }
  return i > bodyStart && i === inner.length;
}

/**
 * `IP-literal = "[" ( IPv6address / IPvFuture ) "]"` (RFC 3986 §3.2.2), starting at `pos` where
 * `text.charCodeAt(pos)` is already known to be `"["`. The `IPv6address` alternative reuses
 * `ipv6.ts`'s own strict RFC 4291 §2.2 grammar whole.
 */
function readIpLiteral(text: string, pos: number, g: UriGrammar): number | undefined {
  const close = text.indexOf(']', pos + 1);
  if (close < 0) return undefined;
  const inner = text.slice(pos + 1, close);
  if (inner.length === 0) return undefined;
  const first = inner.charCodeAt(0);
  if (first === ASCII_LOWER_V || first === ASCII_UPPER_V) {
    return isValidIpvFuture(inner) ? close + 1 : undefined;
  }
  return g.parseIpv6(inner) ? close + 1 : undefined;
}

/**
 * `authority = [ userinfo "@" ] host [ ":" port ]` (RFC 3986 §3.2), `host = IP-literal /
 * IPv4address / reg-name`, with `iuserinfo`/`ireg-name` under the IRI grammar. The plain
 * (non-bracketed) `IPv4address` alternative needs no separate branch: every character an
 * `IPv4address` can contain (digits and `.`) is already inside `reg-name`'s own charset. The host
 * may be empty (`reg-name = *( ... )`), and a port is digits only and may be empty (`port = *DIGIT`).
 */
function readAuthority(text: string, pos: number, g: UriGrammar): number | undefined {
  let cursor = pos;
  const afterUserinfo = readCharClassRun(text, pos, ucs(g), isUserinfoCode);
  if (afterUserinfo < text.length && text.charCodeAt(afterUserinfo) === ASCII_AT) {
    cursor = afterUserinfo + 1;
  }
  if (cursor < text.length && text.charCodeAt(cursor) === ASCII_OPEN_BRACKET) {
    const afterIp = readIpLiteral(text, cursor, g);
    if (afterIp === undefined) return undefined;
    cursor = afterIp;
  } else {
    cursor = readCharClassRun(text, cursor, ucs(g), isRegNameCode);
  }
  if (cursor < text.length && text.charCodeAt(cursor) === ASCII_COLON) {
    cursor = readCharClassRun(text, cursor + 1, 'none', isDigitCode);
  }
  // Authority ends where the character class runs above stop on their own: none of userinfo,
  // reg-name, IP-literal's own bracket close, or a numeric port can contain '/', '?' or '#'.
  return cursor;
}

/** `path-abempty = *( "/" segment )`, `segment = *pchar` (RFC 3986 §3.3). */
function readPathAbempty(text: string, pos: number, g: UriGrammar): number {
  let i = pos;
  while (i < text.length && text.charCodeAt(i) === ASCII_SLASH) {
    i = readCharClassRun(text, i + 1, ucs(g), isPcharCode);
  }
  return i;
}

/** `segment-nz *( "/" segment )` -- `path-rootless`'s body (RFC 3986 §3.3), and (with the
 * no-colon-in-the-first-segment charset swapped in) `path-noscheme`'s. `undefined` when the
 * leading `segment-nz`/`segment-nz-nc` cannot match at all -- the caller falls back to
 * `path-empty`, a distinct, always-valid zero-length alternative. */
function readNonEmptyFirstSegmentPath(
  text: string,
  pos: number,
  g: UriGrammar,
  isFirstSegmentCode: (code: number) => boolean,
): number | undefined {
  const firstEnd = readCharClassRun(text, pos, ucs(g), isFirstSegmentCode);
  if (firstEnd === pos) return undefined;
  return readPathAbempty(text, firstEnd, g);
}

/**
 * `hier-part = "//" authority path-abempty / path-absolute / path-rootless / path-empty`
 * (RFC 3986 §3). A leading `//` is always the authority form, so `path-absolute` (which may not
 * begin `//`) and `path-abempty` read identically from a single leading `/`.
 */
function readHierPart(text: string, pos: number, g: UriGrammar): number | undefined {
  if (text.startsWith('//', pos)) {
    const afterAuthority = readAuthority(text, pos + 2, g);
    if (afterAuthority === undefined) return undefined;
    return readPathAbempty(text, afterAuthority, g);
  }
  if (pos < text.length && text.charCodeAt(pos) === ASCII_SLASH) {
    return readPathAbempty(text, pos, g);
  }
  return readNonEmptyFirstSegmentPath(text, pos, g, isPcharCode) ?? pos;
}

/** `relative-part`'s exact counterpart to {@link readHierPart} -- `path-noscheme` instead of
 * `path-rootless`, so the reference's first segment can never itself look like `scheme ":"`. */
function readRelativePart(text: string, pos: number, g: UriGrammar): number | undefined {
  if (text.startsWith('//', pos)) {
    const afterAuthority = readAuthority(text, pos + 2, g);
    if (afterAuthority === undefined) return undefined;
    return readPathAbempty(text, afterAuthority, g);
  }
  if (pos < text.length && text.charCodeAt(pos) === ASCII_SLASH) {
    return readPathAbempty(text, pos, g);
  }
  return readNonEmptyFirstSegmentPath(text, pos, g, isPcharNoColonCode) ?? pos;
}

/** `query = *( pchar / "/" / "?" )`, with `iprivate` beside `ucschar` under the IRI grammar (RFC 3987 §2.2). */
function readQuery(text: string, pos: number, g: UriGrammar): number {
  return readCharClassRun(text, pos, g.iri ? 'ucschar-iprivate' : 'none', isQueryOrFragmentCode);
}

/** `fragment = *( pchar / "/" / "?" )` (RFC 3986 §3.5); `iprivate` is not admitted here. */
function readFragment(text: string, pos: number, g: UriGrammar): number {
  return readCharClassRun(text, pos, ucs(g), isQueryOrFragmentCode);
}

/** The shape information the facets need beyond "well-formed": the `scheme` component (absent
 * for a relative reference, which RFC 3986's `relative-ref` has none) and whether a `#` fragment
 * is present -- a present-but-empty fragment is a fragment. */
export interface UriShape {
  readonly scheme?: string;
  readonly fragment: boolean;
}

/**
 * `URI-reference = URI / relative-ref` (RFC 3986 §4.1), or `IRI-reference` (RFC 3987 §2.2) under
 * `g.iri`, matched in full; `undefined` when `text` is not one.
 */
export function tryParseUri(text: string, g: UriGrammar): UriShape | undefined {
  const schemeEnd = tryReadScheme(text, 0);
  let pos: number;
  let scheme: string | undefined;
  if (
    schemeEnd !== undefined &&
    schemeEnd < text.length &&
    text.charCodeAt(schemeEnd) === ASCII_COLON
  ) {
    scheme = text.slice(0, schemeEnd);
    const afterHierPart = readHierPart(text, schemeEnd + 1, g);
    if (afterHierPart === undefined) return undefined;
    pos = afterHierPart;
  } else {
    const afterRelativePart = readRelativePart(text, 0, g);
    if (afterRelativePart === undefined) return undefined;
    pos = afterRelativePart;
  }
  if (pos < text.length && text.charCodeAt(pos) === ASCII_QUESTION) {
    pos = readQuery(text, pos + 1, g);
  }
  let fragment = false;
  if (pos < text.length && text.charCodeAt(pos) === ASCII_HASH) {
    pos = readFragment(text, pos + 1, g);
    fragment = true;
  }
  if (pos !== text.length) return undefined;
  return scheme === undefined ? { fragment } : { scheme, fragment };
}
