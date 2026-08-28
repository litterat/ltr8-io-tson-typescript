/**
 * `!!id`-line reading for `tson hash` ([TSON-DATA] §2.2, §7.2.2).
 *
 * The hashing and pinning half of that section is **not** here: `sha256Hex`, `contentStart` and
 * `withSha256Pin` come from `@ltr8/tson/identity`, the subpath the library added for exactly this
 * — a consumer holding a document and wanting §2.2.1's content hash for it. What remains is the
 * one thing that subpath does not offer and should not: reading the `!!id` value back out of a
 * document's first line **without parsing the document**.
 *
 * That distinction is the point. `parse()` would give the id, but it also decides the whole
 * document is well-formed first, and `hash` must work on a document that does not parse — a
 * content hash is a property of the bytes, and refusing to hash a file because something deep
 * inside it is malformed would be answering a question nobody asked.
 *
 * {@link readIdDirective} is therefore deliberately narrower than a real lexer: it decodes only
 * the fixed single-character escape table §7.2.2 defines (`\"` `\\` `\/` `\b` `\f` `\n` `\r`
 * `\t` `\s`) inside the first line's quoted token, and returns `undefined` rather than guess at
 * anything else (a `\uXXXX` escape, or a surrogate pair split across two of them). A real `!!id`
 * value is a plain URI with nothing in it that needs escaping in the first place, so this covers
 * everything the bundled schemas and any schema this command is likely to see actually write.
 */
const BOM = [0xef, 0xbb, 0xbf];

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
