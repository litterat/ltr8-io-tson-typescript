/**
 * A hand-written RFC 3986 `URI-reference` grammar, shared by `uri.ts` -- no `RegExp`, one
 * function per ABNF production, the same "a token is already fully decoded text by the time an
 * atom sees it, so a hand-scanned character walk is both the simplest and the most auditable way
 * to enforce a grammar this exact" discipline `temporal/rfc3339.ts` documents for its own grammar.
 *
 * **A deliberate divergence from `UriParser.java`, not an oversight.** `CONFORMANCE.md` records
 * that the Java implementation delegates entirely to `java.net.URI`, and that `URI`'s own Javadoc
 * states it implements RFC 2396 (as amended by RFC 2732) rather than RFC 3986 -- an accepted,
 * different-revision gap the reference implementation takes on because writing an RFC 3986
 * validator from scratch "isn't worth it at this stage" when a JDK type already covers most of
 * the ground. This port has no equivalent host type to delegate to at all (no `DOM` lib, no
 * global `URL` in this package's type configuration -- `CLAUDE.md`), so the trade the Java makes
 * does not apply here the same way: parsing RFC 3986 itself is not "extra" work traded against a
 * good-enough delegate, it is the only way to accept or reject a URI token at all. What follows
 * therefore implements §5.5's actually-cited grammar directly, which is stricter fidelity to the
 * spec than the reference implementation itself achieves -- see this port's own report for how
 * this divergence is called out as a deliberate choice, not a silent one.
 *
 * **One documented simplification** relative to strict RFC 3986: `path-absolute` and
 * `path-rootless` are each treated as their leading segment (when present) followed by the same
 * `path-abempty` continuation grammar (`*( "/" segment )`), rather than `path-absolute`'s own
 * stricter rule that forbids an *empty* first segment from being followed by more path
 * (effectively disallowing `//` as a rootless continuation in one narrow corner). This widens
 * acceptance by an infinitesimal, security-irrelevant margin -- it never accepts a character
 * outside `pchar`/`unreserved`/`sub-delims`, never accepts an unescaped space, and never changes
 * which *scheme* or *host* a token denotes -- while keeping one shared path reader instead of
 * three near-identical ones.
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
 * Consumes the maximal run of `text[pos..end)` where every character either satisfies
 * `isAllowed` or is a `pct-encoded = "%" HEXDIG HEXDIG` triple (unioned into nearly every
 * production below). Returns the position just past the run -- `pos` itself if nothing matched.
 */
function readCharClassRun(
  text: string,
  pos: number,
  end: number,
  isAllowed: (code: number) => boolean,
): number {
  let i = pos;
  while (i < end) {
    const code = text.charCodeAt(i);
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
    if (!isAllowed(code)) break;
    i += 1;
  }
  return i;
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
 * `ipv6.ts`'s own strict RFC 4291 §2.2 grammar whole -- passed in rather than imported directly,
 * so this module stays a pure RFC 3986 grammar with no dependency of its own on the address
 * family modules (mirroring `temporal/rfc3339.ts`'s "pure grammar, no value/schema imports" note).
 */
function readIpLiteral(
  text: string,
  pos: number,
  parseIpv6: (candidate: string) => boolean,
): number | undefined {
  const close = text.indexOf(']', pos + 1);
  if (close < 0) return undefined;
  const inner = text.slice(pos + 1, close);
  if (inner.length === 0) return undefined;
  const first = inner.charCodeAt(0);
  if (first === ASCII_LOWER_V || first === ASCII_UPPER_V) {
    return isValidIpvFuture(inner) ? close + 1 : undefined;
  }
  return parseIpv6(inner) ? close + 1 : undefined;
}

/**
 * `authority = [ userinfo "@" ] host [ ":" port ]` (RFC 3986 §3.2), `host = IP-literal /
 * IPv4address / reg-name`. The plain (non-bracketed) `IPv4address` alternative needs no separate
 * branch: every character an `IPv4address` can contain (digits and `.`) is already inside
 * `reg-name`'s own charset, so a bare dotted-quad host is accepted by the `reg-name` reader with
 * no special case, exactly as it would be by the full three-way grammar.
 */
function readAuthority(
  text: string,
  pos: number,
  parseIpv6: (candidate: string) => boolean,
): number | undefined {
  let cursor = pos;
  const afterUserinfo = readCharClassRun(text, pos, text.length, isUserinfoCode);
  if (afterUserinfo < text.length && text.charCodeAt(afterUserinfo) === ASCII_AT) {
    cursor = afterUserinfo + 1;
  }
  if (cursor < text.length && text.charCodeAt(cursor) === ASCII_OPEN_BRACKET) {
    const afterIp = readIpLiteral(text, cursor, parseIpv6);
    if (afterIp === undefined) return undefined;
    cursor = afterIp;
  } else {
    cursor = readCharClassRun(text, cursor, text.length, isRegNameCode);
  }
  if (cursor < text.length && text.charCodeAt(cursor) === ASCII_COLON) {
    cursor = readCharClassRun(text, cursor + 1, text.length, isDigitCode);
  }
  // Authority ends where the character class runs above stop on their own: none of userinfo,
  // reg-name, IP-literal's own bracket close, or a numeric port can contain '/', '?' or '#'.
  return cursor;
}

/** `path-abempty = *( "/" segment )`, `segment = *pchar` (RFC 3986 §3.3). */
function readPathAbempty(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && text.charCodeAt(i) === ASCII_SLASH) {
    i = readCharClassRun(text, i + 1, text.length, isPcharCode);
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
  isFirstSegmentCode: (code: number) => boolean,
): number | undefined {
  const firstEnd = readCharClassRun(text, pos, text.length, isFirstSegmentCode);
  if (firstEnd === pos) return undefined;
  return readPathAbempty(text, firstEnd);
}

/**
 * `hier-part = "//" authority path-abempty / path-absolute / path-rootless / path-empty`
 * (RFC 3986 §3). See this module's own TSDoc for `path-absolute`'s deliberate simplification to
 * `path-abempty`'s own grammar.
 */
function readHierPart(
  text: string,
  pos: number,
  parseIpv6: (candidate: string) => boolean,
): number | undefined {
  if (text.startsWith('//', pos)) {
    const afterAuthority = readAuthority(text, pos + 2, parseIpv6);
    if (afterAuthority === undefined) return undefined;
    return readPathAbempty(text, afterAuthority);
  }
  if (pos < text.length && text.charCodeAt(pos) === ASCII_SLASH) {
    return readPathAbempty(text, pos);
  }
  return readNonEmptyFirstSegmentPath(text, pos, isPcharCode) ?? pos;
}

/** `relative-part`'s exact counterpart to {@link readHierPart} -- `path-noscheme` instead of
 * `path-rootless`, so the reference's first segment can never itself look like `scheme ":"`. */
function readRelativePart(
  text: string,
  pos: number,
  parseIpv6: (candidate: string) => boolean,
): number | undefined {
  if (text.startsWith('//', pos)) {
    const afterAuthority = readAuthority(text, pos + 2, parseIpv6);
    if (afterAuthority === undefined) return undefined;
    return readPathAbempty(text, afterAuthority);
  }
  if (pos < text.length && text.charCodeAt(pos) === ASCII_SLASH) {
    return readPathAbempty(text, pos);
  }
  return readNonEmptyFirstSegmentPath(text, pos, isPcharNoColonCode) ?? pos;
}

/** The shape information `uri.ts` needs beyond "well-formed": the `scheme` component, absent for
 * a relative reference (RFC 3986's `relative-ref` has none). */
export interface UriShape {
  readonly scheme?: string;
}

/**
 * `URI-reference = URI / relative-ref` (RFC 3986 §4.1), matched in full. `parseIpv6` lets the
 * caller supply `ipv6.ts`'s own strict address grammar for `IP-literal` without this module
 * importing it directly -- see {@link readIpLiteral}'s own note.
 */
export function tryParseUri(
  text: string,
  parseIpv6: (candidate: string) => boolean,
): UriShape | undefined {
  const schemeEnd = tryReadScheme(text, 0);
  let pos: number;
  let scheme: string | undefined;
  if (
    schemeEnd !== undefined &&
    schemeEnd < text.length &&
    text.charCodeAt(schemeEnd) === ASCII_COLON
  ) {
    scheme = text.slice(0, schemeEnd);
    const afterHierPart = readHierPart(text, schemeEnd + 1, parseIpv6);
    if (afterHierPart === undefined) return undefined;
    pos = afterHierPart;
  } else {
    const afterRelativePart = readRelativePart(text, 0, parseIpv6);
    if (afterRelativePart === undefined) return undefined;
    pos = afterRelativePart;
  }
  if (pos < text.length && text.charCodeAt(pos) === ASCII_QUESTION) {
    pos = readCharClassRun(text, pos + 1, text.length, isQueryOrFragmentCode);
  }
  if (pos < text.length && text.charCodeAt(pos) === ASCII_HASH) {
    pos = readCharClassRun(text, pos + 1, text.length, isQueryOrFragmentCode);
  }
  if (pos !== text.length) return undefined;
  return scheme === undefined ? {} : { scheme };
}
