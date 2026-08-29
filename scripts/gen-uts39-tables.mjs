#!/usr/bin/env node
/**
 * Generates the two checked-in UTS #39 tables ([TSON-DATA] §8.2, §7.7 rule 2):
 *
 *   packages/tson/src/unicode/uts39.ts         Identifier_Status, the Script partition, and the
 *                                               Joining_Type/Canonical_Combining_Class/
 *                                               Indic_Syllabic_Category tables §7.7 rule 2 needs
 *   packages/tson/src/unicode/confusables.ts    the UTS #39 §4 confusables map
 *
 * Two different sources feed them, because they need two different kinds of data:
 *
 * - `Identifier_Status`, `confusables.txt`, and `Joining_Type`/`Canonical_Combining_Class`/
 *   `Indic_Syllabic_Category` have **no ECMAScript `\p{...}` property escape** — V8 exposes
 *   `Script`, `Script_Extensions` and `General_Category` and nothing else UTS #39 needs. So these
 *   are extracted **verbatim** from the pinned Java reference implementation
 *   (`.references/ltr8-io-tson-java/tson-compiler/.../lexer/{Confusables,IdentifierStatus,
 *   JoiningControls}.java`), which already carries them as parseable hex literals. Deriving from
 *   the pinned reference isn't a workaround; it is what guarantees this port and the Java return
 *   identical verdicts on the same document, which is the whole point of a conformance-driven
 *   port. This script fails with a clear message if that checkout is absent — see
 *   `scripts/fetch-references.sh`.
 * - `Script` and the four general-category classes §7.7 rule 2's own algorithm needs
 *   (`Non_Spacing_Mark`, `Enclosing_Mark`, `Format`, `Letter`) **do** have a host escape, so —
 *   exactly like `scripts/gen-unicode-tables.mjs` — they are probed from this host's Unicode
 *   property escapes at generation time and checked in, rather than consulted from the host at
 *   runtime. A generated table is what lets two runtimes on different Node builds (and so
 *   different Unicode versions) agree regardless of which one produced it.
 *
 * `UNICODE_VERSION` (this Node build's `process.versions.unicode`) is recorded as
 * `UTS39_VERSION` in the output: §8.2 requires a refusal to name "the UTS #39 data version", and
 * UTS #39 carries no version number of its own independent of the UCD release its data files
 * ship with, so naming the UCD version *is* naming the data version.
 *
 * Encoding: every boolean range table reuses `gen-unicode-tables.mjs`'s delta-varint scheme
 * unchanged (gap from the previous range's end, then the range's own width, base64-wrapped). The
 * Script partition is a **total, non-overlapping** cover of every non-surrogate code point (every
 * scalar value has exactly one `Script` value — verified below, not assumed), so it reuses the
 * same range shape with one extra varint per range: a small integer script id. The confusables
 * map is a relation, not a set, so it gets its own encoding: entries sorted by source code point,
 * each a delta-varint gap from the previous source, a varint count of replacement code points,
 * then that many absolute (non-delta — a replacement's code points have no ordering relationship
 * to each other or to the source) varints.
 *
 * Run with `npm run gen:uts39`. Output must be a no-op diff on a matching Unicode version.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import prettier from 'prettier';

const MAX_CODE_POINT = 0x10ffff;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UTS39_PATH = join(REPO_ROOT, 'packages/tson/src/unicode/uts39.ts');
const CONFUSABLES_PATH = join(REPO_ROOT, 'packages/tson/src/unicode/confusables.ts');

const JAVA_LEXER_DIR = join(
  REPO_ROOT,
  '.references/ltr8-io-tson-java/tson-compiler/src/main/java/io/ltr8/tson/compiler/lexer',
);

const unicodeVersion = process.versions.unicode;

/* ------------------------------------------------------------------------ Java extraction ------ */

/**
 * @param {string} relativePath - path under {@link JAVA_LEXER_DIR}
 * @returns {string}
 */
function readJavaSource(relativePath) {
  const path = join(JAVA_LEXER_DIR, relativePath);
  if (!existsSync(path)) {
    throw new Error(
      `${path} does not exist. This generator reads UTS #39 tables from the pinned Java ` +
        `reference implementation, which is gitignored and populated by ` +
        `\`./scripts/fetch-references.sh\` (or \`npm run refs\`). Run it first.`,
    );
  }
  return readFileSync(path, 'utf8');
}

/**
 * Extracts a `private static final int[] NAME = { 0x.., 0x.., ... };` array as flattened
 * inclusive `[start, end]` range pairs, in source order.
 *
 * @param {string} source
 * @param {string} name
 * @returns {Array<[number, number]>}
 */
function extractRangeArray(source, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*\\{([\\s\\S]*?)\\};`).exec(source);
  if (!match) throw new Error(`could not find \`${name}\` in the Java source`);
  const hex = [...match[1].matchAll(/0x[0-9A-Fa-f]+/g)].map((m) => parseInt(m[0], 16));
  if (hex.length % 2 !== 0) throw new Error(`\`${name}\` has an odd number of bounds`);
  /** @type {Array<[number, number]>} */
  const ranges = [];
  for (let i = 0; i < hex.length; i += 2) ranges.push([hex[i], hex[i + 1]]);
  return ranges;
}

/**
 * Extracts `Confusables.TABLE` — a `String[]` of comma-separated `src>t1 t2 ...` hex entries,
 * split across constants only because a single Java class-file string may not exceed 65,535
 * bytes — the same way `Confusables.parse()` does: `String.join(",", TABLE)`, then split on `,`.
 *
 * @param {string} source
 * @returns {Map<number, number[]>} source code point -> replacement code points, in source order
 */
function extractConfusablesTable(source) {
  const match = /\bTABLE\s*=\s*\{([\s\S]*?)\};/.exec(source);
  if (!match) throw new Error('could not find `TABLE` in Confusables.java');
  const pieces = [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (pieces.length === 0) throw new Error('`TABLE` had no string literals');
  const entries = pieces.join(',').split(',');

  /** @type {Map<number, number[]>} */
  const mapping = new Map();
  for (const entry of entries) {
    const arrow = entry.indexOf('>');
    if (arrow < 0) throw new Error(`malformed confusables entry: ${entry}`);
    const source_ = parseInt(entry.slice(0, arrow), 16);
    const targets = entry
      .slice(arrow + 1)
      .split(' ')
      .map((h) => parseInt(h, 16));
    mapping.set(source_, targets);
  }
  return mapping;
}

/* ---------------------------------------------------------------------- host range collection ------ */

/**
 * Collects the inclusive ranges of code points matching a single property escape. Identical to
 * `gen-unicode-tables.mjs`'s `collectRanges` — duplicated rather than imported because generator
 * scripts here are each self-contained, the same reasoning that duplicates the tiny runtime
 * decoder into every generated leaf file below.
 *
 * @param {string} escape
 * @returns {Array<[number, number]>}
 */
function collectRanges(escape) {
  const test = new RegExp(`^\\p{${escape}}$`, 'u');
  /** @type {Array<[number, number]>} */
  const ranges = [];
  let start = -1;
  for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const matches = test.test(String.fromCodePoint(cp));
    if (matches && start < 0) {
      start = cp;
    } else if (!matches && start >= 0) {
      ranges.push([start, cp - 1]);
      start = -1;
    }
  }
  if (start >= 0) ranges.push([start, MAX_CODE_POINT]);
  return ranges;
}

/* -------------------------------------------------------------------------------- encoding ------ */

/**
 * @param {number[]} out
 * @param {number} value
 */
function pushVarint(out, value) {
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

/**
 * @param {Array<[number, number]>} ranges
 * @returns {Uint8Array}
 */
function encodeRanges(ranges) {
  /** @type {number[]} */
  const out = [];
  let previousEnd = -1;
  for (const [start, end] of ranges) {
    pushVarint(out, start - previousEnd - 1);
    pushVarint(out, end - start);
    previousEnd = end;
  }
  return Uint8Array.from(out);
}

/**
 * @param {Uint8Array} bytes
 * @returns {Array<[number, number]>}
 */
function decodeRanges(bytes) {
  /** @type {Array<[number, number]>} */
  const ranges = [];
  let i = 0;
  let previousEnd = -1;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[i++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  };
  while (i < bytes.length) {
    const start = previousEnd + 1 + readVarint();
    const end = start + readVarint();
    ranges.push([start, end]);
    previousEnd = end;
  }
  return ranges;
}

/**
 * @param {string} label
 * @param {Array<[number, number]>} ranges
 */
function encodeVerified(label, ranges) {
  const bytes = encodeRanges(ranges);
  const back = decodeRanges(bytes);
  const same =
    back.length === ranges.length &&
    back.every((r, i) => r[0] === ranges[i][0] && r[1] === ranges[i][1]);
  if (!same) throw new Error(`${label}: encode/decode round trip disagreed`);
  return { base64: Buffer.from(bytes).toString('base64'), byteLength: bytes.length };
}

/**
 * @param {Array<[number, number, number]>} taggedRanges - sorted by start, non-overlapping
 * @returns {Uint8Array}
 */
function encodeScriptRanges(taggedRanges) {
  /** @type {number[]} */
  const out = [];
  let previousEnd = -1;
  for (const [start, end, id] of taggedRanges) {
    pushVarint(out, start - previousEnd - 1);
    pushVarint(out, end - start);
    pushVarint(out, id);
    previousEnd = end;
  }
  return Uint8Array.from(out);
}

/**
 * @param {Uint8Array} bytes
 * @returns {Array<[number, number, number]>}
 */
function decodeScriptRanges(bytes) {
  /** @type {Array<[number, number, number]>} */
  const ranges = [];
  let i = 0;
  let previousEnd = -1;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[i++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  };
  while (i < bytes.length) {
    const start = previousEnd + 1 + readVarint();
    const end = start + readVarint();
    const id = readVarint();
    ranges.push([start, end, id]);
    previousEnd = end;
  }
  return ranges;
}

/**
 * @param {Array<[number, number, number]>} taggedRanges
 * @returns {{base64: string, byteLength: number}}
 */
function encodeScriptRangesVerified(taggedRanges) {
  const bytes = encodeScriptRanges(taggedRanges);
  const back = decodeScriptRanges(bytes);
  const same =
    back.length === taggedRanges.length &&
    back.every(
      (r, i) =>
        r[0] === taggedRanges[i][0] && r[1] === taggedRanges[i][1] && r[2] === taggedRanges[i][2],
    );
  if (!same) throw new Error('script table: encode/decode round trip disagreed');
  return { base64: Buffer.from(bytes).toString('base64'), byteLength: bytes.length };
}

/**
 * @param {Array<[number, number[]]>} entries - sorted by source code point ascending
 * @returns {Uint8Array}
 */
function encodeConfusables(entries) {
  /** @type {number[]} */
  const out = [];
  let previousSource = -1;
  for (const [source, targets] of entries) {
    pushVarint(out, source - previousSource - 1);
    pushVarint(out, targets.length);
    for (const cp of targets) pushVarint(out, cp);
    previousSource = source;
  }
  return Uint8Array.from(out);
}

/**
 * @param {Uint8Array} bytes
 * @returns {Array<[number, number[]]>}
 */
function decodeConfusables(bytes) {
  /** @type {Array<[number, number[]]>} */
  const entries = [];
  let i = 0;
  let previousSource = -1;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[i++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  };
  while (i < bytes.length) {
    const source = previousSource + 1 + readVarint();
    const count = readVarint();
    /** @type {number[]} */
    const targets = [];
    for (let k = 0; k < count; k++) targets.push(readVarint());
    entries.push([source, targets]);
    previousSource = source;
  }
  return entries;
}

/**
 * @param {Array<[number, number[]]>} entries
 * @returns {{base64: string, byteLength: number}}
 */
function encodeConfusablesVerified(entries) {
  const bytes = encodeConfusables(entries);
  const back = decodeConfusables(bytes);
  const same =
    back.length === entries.length &&
    back.every(
      ([src, targets], i) =>
        src === entries[i][0] &&
        targets.length === entries[i][1].length &&
        targets.every((cp, k) => cp === entries[i][1][k]),
    );
  if (!same) throw new Error('confusables table: encode/decode round trip disagreed');
  return { base64: Buffer.from(bytes).toString('base64'), byteLength: bytes.length };
}

/* ------------------------------------------------------------------------ emitted runtime ------ */

/**
 * @param {number} unknownScriptId - the generated `SCRIPT_UNKNOWN` id, inlined as a literal so
 *   `scriptIdAt`'s fallback needs no forward reference to a `const` declared later in the file
 * @returns {string}
 */
function booleanTableHelpers(unknownScriptId) {
  return `const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decodes a base64 string to bytes without \`atob\` or \`Buffer\`.
 *
 * The package declares no ambient host globals beyond what it already needs, and this runs in both
 * Node and browsers, so the decode is spelled out rather than delegated.
 */
function fromBase64(text: string): Uint8Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    lookup[BASE64_ALPHABET.charCodeAt(i)] = i;
  }

  // A character outside the alphabet reads as -1, which is also what an out-of-range index
  // yields here. Padding is the only such character these tables contain.
  const sextet = (index: number): number => lookup[text.charCodeAt(index)] ?? -1;

  let padding = 0;
  while (padding < 2 && text.charCodeAt(text.length - 1 - padding) === 0x3d /* '=' */) padding++;

  const bytes = new Uint8Array((text.length >> 2) * 3 - padding);
  let out = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = sextet(i);
    const b = sextet(i + 1);
    const c = sextet(i + 2);
    const d = sextet(i + 3);
    const chunk = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
    if (out < bytes.length) bytes[out++] = (chunk >> 16) & 0xff;
    if (out < bytes.length) bytes[out++] = (chunk >> 8) & 0xff;
    if (out < bytes.length) bytes[out++] = chunk & 0xff;
  }
  return bytes;
}

/** Expands a delta-varint encoded range table into a flat array of inclusive \`[start, end]\` pairs. */
function decodeTable(encoded: string): Uint32Array {
  const bytes = fromBase64(encoded);
  const bounds: number[] = [];
  let i = 0;
  let previousEnd = -1;

  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[i++];
      if (byte === undefined) return result >>> 0;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  };

  while (i < bytes.length) {
    const gap = readVarint();
    const width = readVarint();
    const start = previousEnd + 1 + gap;
    const end = start + width;
    bounds.push(start, end);
    previousEnd = end;
  }

  return Uint32Array.from(bounds);
}

/** Binary search over a flat \`[start, end, start, end, ...]\` array of inclusive ranges. */
function contains(table: Uint32Array, codePoint: number): boolean {
  let low = 0;
  let high = (table.length >> 1) - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = table[mid << 1];
    const end = table[(mid << 1) + 1];
    if (start === undefined || end === undefined) return false;
    if (codePoint < start) {
      high = mid - 1;
    } else if (codePoint > end) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

/**
 * Expands a delta-varint encoded table of \`[start, end, id]\` triples into three parallel flat
 * arrays. The Script partition covers every non-surrogate code point exactly once (verified at
 * generation time), which is what lets a lookup default to {@link SCRIPT_UNKNOWN} rather than
 * needing to represent "no entry" at all — the default only ever applies to a lone surrogate code
 * unit, which cannot occur in a well-formed document.
 */
function decodeScriptTable(encoded: string): { starts: Uint32Array; ends: Uint32Array; ids: Uint16Array } {
  const bytes = fromBase64(encoded);
  const starts: number[] = [];
  const ends: number[] = [];
  const ids: number[] = [];
  let i = 0;
  let previousEnd = -1;

  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[i++];
      if (byte === undefined) return result >>> 0;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  };

  while (i < bytes.length) {
    const start = previousEnd + 1 + readVarint();
    const end = start + readVarint();
    const id = readVarint();
    starts.push(start);
    ends.push(end);
    ids.push(id);
    previousEnd = end;
  }

  return { starts: Uint32Array.from(starts), ends: Uint32Array.from(ends), ids: Uint16Array.from(ids) };
}

/** Binary search over a decoded script table; {@link SCRIPT_UNKNOWN} for a code point outside every range. */
function scriptIdAt(
  table: { starts: Uint32Array; ends: Uint32Array; ids: Uint16Array },
  codePoint: number,
): number {
  let low = 0;
  let high = table.starts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = table.starts[mid];
    const end = table.ends[mid];
    if (start === undefined || end === undefined) break;
    if (codePoint < start) {
      high = mid - 1;
    } else if (codePoint > end) {
      low = mid + 1;
    } else {
      return table.ids[mid] ?? ${String(unknownScriptId)};
    }
  }
  return ${String(unknownScriptId)};
}`;
}

const CONFUSABLES_HELPERS = `const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decodes a base64 string to bytes without \`atob\` or \`Buffer\`. Duplicated from \`uts39.ts\`
 * rather than imported so this module stays independently loadable — the same reasoning
 * \`regex/categories.ts\` gives for its own copy.
 */
function fromBase64(text: string): Uint8Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    lookup[BASE64_ALPHABET.charCodeAt(i)] = i;
  }

  const sextet = (index: number): number => lookup[text.charCodeAt(index)] ?? -1;

  let padding = 0;
  while (padding < 2 && text.charCodeAt(text.length - 1 - padding) === 0x3d /* '=' */) padding++;

  const bytes = new Uint8Array((text.length >> 2) * 3 - padding);
  let out = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = sextet(i);
    const b = sextet(i + 1);
    const c = sextet(i + 2);
    const d = sextet(i + 3);
    const chunk = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
    if (out < bytes.length) bytes[out++] = (chunk >> 16) & 0xff;
    if (out < bytes.length) bytes[out++] = (chunk >> 8) & 0xff;
    if (out < bytes.length) bytes[out++] = chunk & 0xff;
  }
  return bytes;
}

/**
 * Expands the delta-varint confusables encoding into the lookup map: a gap from the previous
 * source code point, a replacement length, then that many absolute (non-delta) code points —
 * unlike a range table's bounds, a replacement's code points carry no ordering relationship to
 * encode a delta against.
 */
function decodeConfusables(encoded: string): Map<number, string> {
  const bytes = fromBase64(encoded);
  const map = new Map<number, string>();
  let i = 0;
  let previousSource = -1;

  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[i++];
      if (byte === undefined) return result >>> 0;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  };

  while (i < bytes.length) {
    const source = previousSource + 1 + readVarint();
    const count = readVarint();
    let replacement = '';
    for (let k = 0; k < count; k++) replacement += String.fromCodePoint(readVarint());
    map.set(source, replacement);
    previousSource = source;
  }

  return map;
}`;

/* ---------------------------------------------------------------------------- uts39.ts ------ */

function buildUts39() {
  // ---- Identifier_Status (from IdentifierStatus.java, verbatim) -----------------------------
  const identifierStatusSource = readJavaSource('IdentifierStatus.java');
  const allowedRanges = extractRangeArray(identifierStatusSource, 'ALLOWED');
  const allowed = encodeVerified('Identifier_Status=Allowed', allowedRanges);

  // ---- Script partition (probed from this host, verified total and non-overlapping) --------
  //
  // Every Unicode Script value name this Node's ICU build recognises is a candidate; an
  // unsupported name simply fails to compile and is dropped; unicode/gen-uts39-tables.mjs then
  // *verifies* — rather than assumes — that the surviving set covers every non-surrogate code
  // point exactly once, so a name this generator's candidate list happens to be missing fails
  // loudly (a coverage gap) instead of silently mis-scripting the code points it names.
  const scriptCandidates = [
    'Common',
    'Latin',
    'Greek',
    'Cyrillic',
    'Armenian',
    'Hebrew',
    'Arabic',
    'Syriac',
    'Thaana',
    'Devanagari',
    'Bengali',
    'Gurmukhi',
    'Gujarati',
    'Oriya',
    'Tamil',
    'Telugu',
    'Kannada',
    'Malayalam',
    'Sinhala',
    'Thai',
    'Lao',
    'Tibetan',
    'Myanmar',
    'Georgian',
    'Hangul',
    'Ethiopic',
    'Cherokee',
    'Canadian_Aboriginal',
    'Ogham',
    'Runic',
    'Khmer',
    'Mongolian',
    'Hiragana',
    'Katakana',
    'Bopomofo',
    'Han',
    'Yi',
    'Old_Italic',
    'Gothic',
    'Deseret',
    'Inherited',
    'Tagalog',
    'Hanunoo',
    'Buhid',
    'Tagbanwa',
    'Limbu',
    'Tai_Le',
    'Linear_B',
    'Ugaritic',
    'Shavian',
    'Osmanya',
    'Cypriot',
    'Braille',
    'Buginese',
    'Coptic',
    'New_Tai_Lue',
    'Glagolitic',
    'Tifinagh',
    'Syloti_Nagri',
    'Old_Persian',
    'Kharoshthi',
    'Balinese',
    'Cuneiform',
    'Phoenician',
    'Phags_Pa',
    'Nko',
    'Sundanese',
    'Lepcha',
    'Ol_Chiki',
    'Vai',
    'Saurashtra',
    'Kayah_Li',
    'Rejang',
    'Lycian',
    'Carian',
    'Lydian',
    'Cham',
    'Tai_Tham',
    'Tai_Viet',
    'Avestan',
    'Egyptian_Hieroglyphs',
    'Samaritan',
    'Lisu',
    'Bamum',
    'Javanese',
    'Meetei_Mayek',
    'Imperial_Aramaic',
    'Old_South_Arabian',
    'Inscriptional_Parthian',
    'Inscriptional_Pahlavi',
    'Old_Turkic',
    'Kaithi',
    'Batak',
    'Brahmi',
    'Mandaic',
    'Chakma',
    'Meroitic_Cursive',
    'Meroitic_Hieroglyphs',
    'Miao',
    'Sharada',
    'Sora_Sompeng',
    'Takri',
    'Unknown',
    'Caucasian_Albanian',
    'Bassa_Vah',
    'Duployan',
    'Elbasan',
    'Grantha',
    'Pahawh_Hmong',
    'Khojki',
    'Linear_A',
    'Mahajani',
    'Manichaean',
    'Mende_Kikakui',
    'Modi',
    'Mro',
    'Old_North_Arabian',
    'Nabataean',
    'Palmyrene',
    'Pau_Cin_Hau',
    'Old_Permic',
    'Psalter_Pahlavi',
    'Siddham',
    'Khudawadi',
    'Tirhuta',
    'Warang_Citi',
    'Ahom',
    'Anatolian_Hieroglyphs',
    'Hatran',
    'Multani',
    'Old_Hungarian',
    'SignWriting',
    'Adlam',
    'Bhaiksuki',
    'Marchen',
    'Newa',
    'Osage',
    'Tangut',
    'Masaram_Gondi',
    'Nushu',
    'Soyombo',
    'Zanabazar_Square',
    'Dogra',
    'Gunjala_Gondi',
    'Hanifi_Rohingya',
    'Makasar',
    'Medefaidrin',
    'Old_Sogdian',
    'Sogdian',
    'Elymaic',
    'Nandinagari',
    'Nyiakeng_Puachue_Hmong',
    'Wancho',
    'Chorasmian',
    'Dives_Akuru',
    'Khitan_Small_Script',
    'Yezidi',
    'Cypro_Minoan',
    'Old_Uyghur',
    'Tangsa',
    'Toto',
    'Vithkuqi',
    'Kawi',
    'Nag_Mundari',
    'Todhri',
    'Garay',
    'Tulu_Tigalari',
    'Sunuwar',
    'Gurung_Khema',
    'Kirat_Rai',
    'Ol_Onal',
  ];

  const supportedScripts = scriptCandidates.filter((name) => {
    try {
      new RegExp(`\\p{Script=${name}}`, 'u');
    } catch {
      return false;
    }
    return true;
  });

  // Deterministic id assignment, independent of the candidate list's own (arbitrary) order: two
  // regenerations against the same Unicode version must be byte-identical.
  const scriptNames = [...supportedScripts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const scriptId = new Map(scriptNames.map((name, id) => [name, id]));

  /** @type {Array<[number, number, number]>} */
  const taggedRanges = [];
  for (const name of scriptNames) {
    const id = /** @type {number} */ (scriptId.get(name));
    for (const [start, end] of collectRanges(`Script=${name}`)) taggedRanges.push([start, end, id]);
  }
  taggedRanges.sort((a, b) => a[0] - b[0]);

  // Verified total and non-overlapping over the whole scalar-value space, not assumed: a missing
  // candidate name would otherwise silently leave a gap that later reads as SCRIPT_UNKNOWN.
  let previousEnd = -1;
  for (const [start, end] of taggedRanges) {
    if (start <= previousEnd) {
      throw new Error(
        `script partition overlaps at U+${start.toString(16).toUpperCase()} (previous range ended at ` +
          `U+${previousEnd.toString(16).toUpperCase()})`,
      );
    }
    if (start > previousEnd + 1) {
      throw new Error(
        `script partition has a gap: U+${(previousEnd + 1).toString(16).toUpperCase()}..` +
          `U+${(start - 1).toString(16).toUpperCase()} matches no probed script name`,
      );
    }
    previousEnd = end;
  }
  if (previousEnd < MAX_CODE_POINT) {
    throw new Error(
      `script partition does not reach U+10FFFF (stops at U+${previousEnd.toString(16).toUpperCase()})`,
    );
  }

  const scripts = encodeScriptRangesVerified(taggedRanges);

  const NAMED_SCRIPTS = [
    ['SCRIPT_COMMON', 'Common'],
    ['SCRIPT_INHERITED', 'Inherited'],
    ['SCRIPT_UNKNOWN', 'Unknown'],
    ['SCRIPT_LATIN', 'Latin'],
    ['SCRIPT_HAN', 'Han'],
    ['SCRIPT_HIRAGANA', 'Hiragana'],
    ['SCRIPT_KATAKANA', 'Katakana'],
    ['SCRIPT_BOPOMOFO', 'Bopomofo'],
    ['SCRIPT_HANGUL', 'Hangul'],
    ['SCRIPT_CYRILLIC', 'Cyrillic'],
    ['SCRIPT_GREEK', 'Greek'],
  ];
  for (const [, name] of NAMED_SCRIPTS) {
    if (!scriptId.has(name)) throw new Error(`script "${name}" is referenced but was not probed`);
  }

  // ---- Joining_Type / Canonical_Combining_Class / Indic_Syllabic_Category (from
  // JoiningControls.java, verbatim — neither property has a host escape) ---------------------
  const joiningSource = readJavaSource('JoiningControls.java');
  const JOINING_TABLES = [
    ['LEFT_JOINING', 'LEFT_JOINING', 'Joining_Type Dual_Joining or Left_Joining ($LJ)'],
    ['RIGHT_JOINING', 'RIGHT_JOINING', 'Joining_Type Dual_Joining or Right_Joining ($RJ)'],
    [
      'TRANSPARENT_ADDED',
      'TRANSPARENT_ADDED',
      'explicitly Joining_Type=Transparent beyond the General_Category default',
    ],
    [
      'TRANSPARENT_REMOVED',
      'TRANSPARENT_REMOVED',
      'explicitly not Joining_Type=Transparent where the General_Category default would say so',
    ],
    ['VIRAMA', 'VIRAMA', 'Canonical_Combining_Class=9 ($V)'],
    ['NONZERO_COMBINING', 'NONZERO_COMBINING', 'Canonical_Combining_Class other than 0 ($M₁)'],
    ['VOWEL_DEPENDENT', 'VOWEL_DEPENDENT', 'Indic_Syllabic_Category=Vowel_Dependent ($D)'],
  ].map(([constant, javaName, label]) => {
    const ranges = extractRangeArray(joiningSource, javaName);
    return { constant, label, ...encodeVerified(label, ranges), rangeCount: ranges.length };
  });

  // ---- General-category helpers §7.7 rule 2's own algorithm needs, host-probed --------------
  const GC_TABLES = [
    ['GC_MN', 'General_Category=Mn', 'non-spacing mark (Mn)'],
    ['GC_ME', 'General_Category=Me', 'enclosing mark (Me)'],
    ['GC_CF', 'Cf', 'format (Cf)'],
    ['GC_LETTER', 'Letter', 'letter (L)'],
  ].map(([constant, escape, label]) => {
    const ranges = collectRanges(escape);
    return { constant, label, ...encodeVerified(label, ranges), rangeCount: ranges.length };
  });

  const source = `/**
 * UTS #39 identifier-hygiene data ([TSON-DATA] §7.7 rule 2, §8.2): \`Identifier_Status\`, the
 * \`Script\` partition, and the \`Joining_Type\`/\`Canonical_Combining_Class\`/
 * \`Indic_Syllabic_Category\` tables the joining-control contexts need, generated from Unicode
 * ${unicodeVersion}.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with \`npm run gen:uts39\`.
 *
 * \`Identifier_Status\` and the joining-control property tables are extracted **verbatim** from
 * the pinned Java reference implementation (\`IdentifierStatus.java\`, \`JoiningControls.java\`),
 * because none of \`Identifier_Status\`, \`Joining_Type\`, \`Canonical_Combining_Class\`, or
 * \`Indic_Syllabic_Category\` has an ECMAScript \`\\p{...}\` property escape — deriving from the
 * pinned reference is what guarantees this port and the Java return identical verdicts on the
 * same document. \`Script\` and the four general-category helpers below do have a host escape and
 * are probed from it at generation time instead, the same way \`xid.ts\` derives \`XID_Start\`.
 *
 * {@link UTS39_VERSION} is what [TSON-DATA] §8.2 requires a name-hygiene refusal to name: UTS #39
 * carries no version of its own independent of the UCD release its data files ship with, so
 * naming the UCD version names the data version.
 */

/** The Unicode Character Database release every table in this file was computed against. */
export const UTS39_VERSION = '${unicodeVersion}';

${booleanTableHelpers(/** @type {number} */ (scriptId.get('Unknown')))}

/** UTS #39 §3.1's Allowed set: ${allowedRanges.length} ranges, ${allowed.byteLength} bytes encoded. */
const IDENTIFIER_STATUS_ALLOWED = /* @__PURE__ */ decodeTable('${allowed.base64}');

/**
 * Whether \`codePoint\` is \`Identifier_Status=Allowed\` (UTS #39 §3.1) — [TSON-DATA] §8.2
 * mechanism 2. This narrows \`XID_Continue\` by removing the characters UTS #39 calls Obsolete,
 * Technical, Limited_Use and Exclusion: historic scripts, musical and technical notation, and
 * letters no modern orthography uses. It is per-character with no cross-script judgement in it —
 * it does not reject a mixed-script name such as \`id_пользователя\` — and it covers the joining
 * controls (ZWNJ, ZWJ) without a special case: both are Restricted here, so a caller needs no
 * hand-picked exclusion for them,
 * and what admits them where they do shaping work is the contextual rule in
 * {@link "./joining-controls.js"} rather than this predicate.
 *
 * This is the *name* profile's rule, not the token profile's: an unquoted value in a historic
 * script stays legal, because a value's content is its own.
 */
export function identifierStatusAllowed(codePoint: number): boolean {
  return contains(IDENTIFIER_STATUS_ALLOWED, codePoint);
}

/** ${scriptNames.length} scripts, ${taggedRanges.length} ranges, ${scripts.byteLength} bytes encoded. */
const SCRIPT_TABLE = /* @__PURE__ */ decodeScriptTable('${scripts.base64}');

/**
 * An opaque id for one Unicode \`Script\` property value. Comparable by \`===\`; the only ids a
 * caller ever names are the ones the restriction-level and joining-control checks read by name
 * below — every other script still gets a distinct, stable-within-this-file id, which is all
 * "are these two characters the same script?" needs.
 */
export type ScriptId = number;

${NAMED_SCRIPTS.map(([constant, name]) => `/** \`Script=${name}\`. */\nexport const ${constant}: ScriptId = ${String(scriptId.get(name))};`).join('\n\n')}

/**
 * The \`Script\` property value of \`codePoint\` (UAX #24), as one of the ids above. Total over
 * every code point: a lone surrogate code unit — never producible from a well-formed document —
 * reads as {@link SCRIPT_UNKNOWN} rather than throwing.
 */
export function scriptOf(codePoint: number): ScriptId {
  return scriptIdAt(SCRIPT_TABLE, codePoint);
}

${JOINING_TABLES.map(
  (t) =>
    `/** ${t.label}: ${String(t.rangeCount)} ranges, ${String(t.byteLength)} bytes encoded. */\nconst ${t.constant} = /* @__PURE__ */ decodeTable('${t.base64}');`,
).join('\n\n')}

/** \`Joining_Type\` Dual_Joining or Left_Joining (\`$LJ\` in UTS #39 §3.1.1.1). */
export function isLeftJoining(codePoint: number): boolean {
  return contains(LEFT_JOINING, codePoint);
}

/** \`Joining_Type\` Dual_Joining or Right_Joining (\`$RJ\`). */
export function isRightJoining(codePoint: number): boolean {
  return contains(RIGHT_JOINING, codePoint);
}

/** Explicitly \`Joining_Type=Transparent\` where the \`General_Category\` default would not say so. */
export function isExplicitlyTransparent(codePoint: number): boolean {
  return contains(TRANSPARENT_ADDED, codePoint);
}

/** Explicitly not \`Joining_Type=Transparent\` where the \`General_Category\` default would say so. */
export function isExplicitlyNotTransparent(codePoint: number): boolean {
  return contains(TRANSPARENT_REMOVED, codePoint);
}

/** \`Canonical_Combining_Class=9\`, Virama (\`$V\`). */
export function isVirama(codePoint: number): boolean {
  return contains(VIRAMA, codePoint);
}

/** \`Canonical_Combining_Class\` other than 0 (\`$M₁\`). */
export function isNonzeroCombiningClass(codePoint: number): boolean {
  return contains(NONZERO_COMBINING, codePoint);
}

/** \`Indic_Syllabic_Category=Vowel_Dependent\` (\`$D\`). */
export function isVowelDependent(codePoint: number): boolean {
  return contains(VOWEL_DEPENDENT, codePoint);
}

${GC_TABLES.map(
  (t) =>
    `/** ${t.label}: ${String(t.rangeCount)} ranges, ${String(t.byteLength)} bytes encoded. */\nconst ${t.constant} = /* @__PURE__ */ decodeTable('${t.base64}');`,
).join('\n\n')}

/** General category \`Mn\`, non-spacing mark. */
export function isNonSpacingMark(codePoint: number): boolean {
  return contains(GC_MN, codePoint);
}

/** General category \`Me\`, enclosing mark. */
export function isEnclosingMark(codePoint: number): boolean {
  return contains(GC_ME, codePoint);
}

/** General category \`Cf\`, format. */
export function isFormatControl(codePoint: number): boolean {
  return contains(GC_CF, codePoint);
}

/** General category \`L\` (\`Lu\`/\`Ll\`/\`Lt\`/\`Lm\`/\`Lo\`), letter. */
export function isLetter(codePoint: number): boolean {
  return contains(GC_LETTER, codePoint);
}
`;

  return {
    source,
    allowedRangeCount: allowedRanges.length,
    allowedByteLength: allowed.byteLength,
    scriptCount: scriptNames.length,
    scriptRangeCount: taggedRanges.length,
    scriptByteLength: scripts.byteLength,
    joiningTables: JOINING_TABLES,
    gcTables: GC_TABLES,
  };
}

/* ------------------------------------------------------------------------ confusables.ts ------ */

function buildConfusables() {
  const source = readJavaSource('Confusables.java');
  const table = extractConfusablesTable(source);
  const entries = [...table.entries()].sort((a, b) => a[0] - b[0]);
  const encoded = encodeConfusablesVerified(entries);

  const output = `/**
 * UTS #39 §4's confusables map, generated from Unicode ${unicodeVersion} — ${String(entries.length)} mappings,
 * extracted verbatim from the pinned Java reference implementation's \`Confusables.TABLE\`
 * (\`confusables.txt\`, which has no ECMAScript property-escape equivalent).
 *
 * GENERATED FILE — do not edit by hand. Regenerate with \`npm run gen:uts39\`.
 */

${CONFUSABLES_HELPERS}

/** ${String(entries.length)} mappings, ${String(encoded.byteLength)} bytes encoded. */
const MAPPING = /* @__PURE__ */ decodeConfusables('${encoded.base64}');

/**
 * The UTS #39 §4 confusable replacement for \`codePoint\`, or \`undefined\` when the code point maps
 * to itself. {@link "./skeleton.js"} is the only intended caller.
 */
export function confusableReplacement(codePoint: number): string | undefined {
  return MAPPING.get(codePoint);
}
`;

  return { source: output, entryCount: entries.length, byteLength: encoded.byteLength };
}

/* ------------------------------------------------------------------------------ main ------ */

const started = Date.now();

/**
 * @param {string} path
 * @param {string} source
 */
async function write(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  const formatted = await prettier.format(source, {
    ...(await prettier.resolveConfig(path)),
    filepath: path,
  });
  writeFileSync(path, formatted);
}

const uts39 = buildUts39();
await write(UTS39_PATH, uts39.source);

const confusables = buildConfusables();
await write(CONFUSABLES_PATH, confusables.source);

console.log('unicode/uts39.ts');
console.log(
  `  Identifier_Status=Allowed  ${String(uts39.allowedRangeCount).padStart(4)} ranges  ${String(uts39.allowedByteLength).padStart(6)} bytes`,
);
console.log(
  `  Script partition           ${String(uts39.scriptCount).padStart(4)} scripts  ${String(uts39.scriptRangeCount)} ranges  ${String(uts39.scriptByteLength)} bytes`,
);
for (const t of uts39.joiningTables) {
  console.log(
    `  ${t.label.padEnd(60)} ${String(t.rangeCount).padStart(4)} ranges  ${String(t.byteLength).padStart(5)} bytes`,
  );
}
for (const t of uts39.gcTables) {
  console.log(
    `  ${t.label.padEnd(60)} ${String(t.rangeCount).padStart(4)} ranges  ${String(t.byteLength).padStart(5)} bytes`,
  );
}
console.log('unicode/confusables.ts');
console.log(
  `  ${String(confusables.entryCount)} mappings  ${String(confusables.byteLength)} bytes`,
);
console.log(`\nUnicode ${unicodeVersion} (${String(Date.now() - started)} ms)`);
