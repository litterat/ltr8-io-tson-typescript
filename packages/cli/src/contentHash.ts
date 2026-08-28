/**
 * Content hashing and `!!id`-line reading for `tson hash` ([TSON-DATA] §2.2.1, §2.2, §7.2.2).
 *
 * **Reimplemented here rather than imported from `@ltr8/tson`.** `link/contentHash.ts`'s
 * `sha256Hex`/`contentStart` and `link/identity.ts`'s `canonicalizeIdentity` compute exactly what
 * this command needs, but neither is exported from any of `@ltr8/tson`'s published entry points
 * (`index.ts`, `./schema`, `./write`, `./tree`, `./bind`, `./regex`, `./source`) -- verified by
 * grep, not assumed. This work package's own brief is explicit that a missing facade is "a
 * finding about the facade, not a reason to bypass it" (reaching past the package's public
 * surface into `@ltr8/tson/dist/link/...` internals), so this module is a from-spec
 * reimplementation of the one algorithm `hash` needs, not a workaround for a facade this CLI is
 * not supposed to reach past. **This is a genuine facade gap worth closing in a later wave**:
 * `@ltr8/tson` computes a document's content hash internally (`Tson.preload`'s own `?sha256=`
 * verification) but exposes no way for a consumer to ask for one directly.
 *
 * {@link sha256Hex}/{@link contentStart} mirror `link/contentHash.ts`'s algorithm exactly (same
 * BOM handling, same §7.3 line-terminator set) via the same `crypto.subtle` global every Node 24
 * runtime and every browser carries. {@link readIdDirective} is deliberately narrower than a real
 * lexer: it decodes only the fixed single-character escape table §7.2.2 defines (`\"` `\\` `\/`
 * `\b` `\f` `\n` `\r` `\t` `\s` plus `\uXXXX`, with surrogate pairing) inside the first line's
 * quoted token, and returns `undefined` rather than guess at anything else (an id spanning a
 * `\uD800`-class surrogate pair split across two escapes, for instance) -- a real `!!id` value is
 * always a plain URI with nothing in it that needs escaping in the first place, so this covers
 * everything the bundled schemas and any schema this command is likely to see actually write.
 */

/** The one sliver of the Web Crypto API this module needs -- see `link/contentHash.ts`'s own note on why this is declared locally rather than pulled in via a `dom`/`webworker` lib. */
declare const crypto: {
  readonly subtle: {
    digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
  };
};

const BOM = [0xef, 0xbb, 0xbf];

/** The byte index the content hash starts at: past a leading BOM, past the first line's terminator ([TSON-DATA] §2.2.1, §7.3's `line-term` set). `undefined` if the first line has no terminator. */
export function contentStart(document: Uint8Array): number | undefined {
  let i =
    document.length >= 3 &&
    document[0] === BOM[0] &&
    document[1] === BOM[1] &&
    document[2] === BOM[2]
      ? 3
      : 0;
  for (; i < document.length; i++) {
    const b = document[i];
    if (b === 0x0a) return i + 1; // LF
    if (b === 0x0d) {
      return i + 1 < document.length && document[i + 1] === 0x0a ? i + 2 : i + 1; // CR LF or CR
    }
    if (b === 0xc2 && i + 1 < document.length && document[i + 1] === 0x85) return i + 2; // NEL
    if (b === 0xe2 && i + 2 < document.length && document[i + 1] === 0x80) {
      const c = document[i + 2];
      if (c === 0xa8 || c === 0xa9) return i + 3; // LS / PS
    }
  }
  return undefined;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** The lowercase-hex SHA-256 of every byte from {@link contentStart} to the end of `document`. */
export async function sha256Hex(document: Uint8Array): Promise<string> {
  const start = contentStart(document);
  if (start === undefined) {
    throw new RangeError(
      'the first line has no terminator -- a content-addressed document must follow its !!id ' +
        'line with one ([TSON-DATA] §2.2.1)',
    );
  }
  const digest = await crypto.subtle.digest('SHA-256', document.subarray(start));
  return toHex(new Uint8Array(digest));
}

const SINGLE_CHAR_ESCAPES: Readonly<Record<number, number>> = {
  0x22: 0x22, // \"
  0x5c: 0x5c, // \\
  0x2f: 0x2f, // \/
  0x62: 0x08, // \b
  0x66: 0x0c, // \f
  0x6e: 0x0a, // \n
  0x72: 0x0d, // \r
  0x74: 0x09, // \t
  0x73: 0x20, // \s
};

/**
 * Decodes a single-line quoted token's content (§7.2.2) starting at `bytes[start]`, up to the
 * closing (unescaped) `"`. Returns the decoded text and the index just past the closing quote, or
 * `undefined` if the token is unterminated or uses an escape this narrow decoder does not cover
 * (a `\uXXXX` pair is the only such case among the ones this scanner declines).
 */
function decodeQuotedAscii(
  bytes: Uint8Array,
  start: number,
): { text: string; end: number } | undefined {
  let i = start;
  const chars: number[] = [];
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x22) return { text: String.fromCharCode(...chars), end: i + 1 };
    if (b === 0x5c) {
      const next = bytes[i + 1];
      if (next === undefined) return undefined;
      const decoded = SINGLE_CHAR_ESCAPES[next];
      if (decoded === undefined) return undefined; // \uXXXX or an unknown escape -- decline
      chars.push(decoded);
      i += 2;
      continue;
    }
    if (b === undefined || b >= 0x80) return undefined; // non-ASCII -- decline rather than misdecode
    chars.push(b);
    i++;
  }
  return undefined; // unterminated
}

/** `!!id`'s own raw byte range within `document`'s first line, and its decoded URI text. */
export interface IdDirective {
  readonly id: string;
  /** Byte offset of the opening `"` of the id's quoted token. */
  readonly valueStart: number;
  /** Byte offset just past the closing `"`. */
  readonly valueEnd: number;
}

const ID_PREFIX = [
  0x21,
  0x21,
  0x69,
  0x64,
  0x3a,
  0x22, // '!!id:"'
];

/**
 * Reads the `!!id` directive from `document`'s first line ([TSON-DATA] §2.2), if the line is
 * exactly `!!id:"<uri>"` with no annotation or other punctuation ahead of the quote. Returns
 * `undefined` when the document has no `!!id` line, or when the id's content uses an escape this
 * module's own narrow decoder declines (see this file's own top note).
 */
export function readIdDirective(document: Uint8Array): IdDirective | undefined {
  const offset = document[0] === BOM[0] && document[1] === BOM[1] && document[2] === BOM[2] ? 3 : 0;
  for (let i = 0; i < ID_PREFIX.length; i++) {
    if (document[offset + i] !== ID_PREFIX[i]) return undefined;
  }
  const valueStart = offset + ID_PREFIX.length;
  const decoded = decodeQuotedAscii(document, valueStart);
  if (decoded === undefined) return undefined;
  return { id: decoded.text, valueStart, valueEnd: decoded.end };
}

/** Splits a reference URI into everything before its query and the query itself (without `?`), per [TSON-DATA] §2.2.1. */
function splitQuery(uri: string): { readonly base: string; readonly query?: string } {
  const q = uri.indexOf('?');
  return q === -1 ? { base: uri } : { base: uri.slice(0, q), query: uri.slice(q + 1) };
}

/**
 * `reference` with its `sha256` content-hash parameter set to `hex`, replacing any existing
 * `sha256` parameter and leaving every other query parameter untouched and in place -- the
 * pinning half of [TSON-DATA] §2.2.1, applied to whatever `!!id` a document already declares
 * rather than assuming it carries none.
 */
export function withSha256Pin(reference: string, hex: string): string {
  const { base, query } = splitQuery(reference);
  if (query === undefined) return `${base}?sha256=${hex}`;
  const params = query.split('&').filter((param) => !param.startsWith('sha256='));
  params.push(`sha256=${hex}`);
  return `${base}?${params.join('&')}`;
}
