#!/usr/bin/env node
/**
 * Generates the two checked-in Unicode tables:
 *
 *   packages/tson/src/unicode/xid.ts        identifier tables, for the lexer (§7.5)
 *   packages/tson/src/regex/categories.ts   general categories, for I-Regexp \p{...} (RFC 9485)
 *
 * Both are derived from whichever Unicode version this Node build carries and checked in, rather
 * than consulted from the host at runtime. That is deliberate: a TSON document's identity can be a
 * hash of its bytes, so two runtimes must never disagree about whether a document is well-formed.
 * Node 22 and Node 24 in the same container already ship different Unicode versions; asking the
 * host would make validity a property of the host. Each file records UNICODE_VERSION so a mismatch
 * is visible rather than silent.
 *
 * They are two files, with two copies of the same small decoder, because eslint's first zone makes
 * src/regex/ a leaf that may import nothing outside itself — the I-Regexp engine names no TSON
 * type. Duplicating ~40 generated lines is the price of that isolation, and the generator is what
 * keeps the two copies identical.
 *
 * Encoding: each property is a sorted list of inclusive code-point ranges, delta-varint encoded
 * (gap from the previous range's end, then the range's own width) and base64-wrapped. Deltas are
 * small, so most ranges cost two bytes.
 *
 * Run with `npm run gen:unicode`. Output must be a no-op diff on a matching Unicode version; CI
 * checks exactly that.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import prettier from 'prettier';

const MAX_CODE_POINT = 0x10ffff;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const XID_PATH = join(REPO_ROOT, 'packages/tson/src/unicode/xid.ts');
const CATEGORIES_PATH = join(REPO_ROOT, 'packages/tson/src/regex/categories.ts');

const unicodeVersion = process.versions.unicode;

/* ------------------------------------------------------------------ range collection ------ */

/**
 * Collects the inclusive ranges of code points matching a single property escape.
 *
 * Lone surrogates are skipped throughout: they are not scalar values and cannot appear in
 * well-formed text, so including them would split a run in two over a gap no document can
 * contain anyway.
 *
 * @param {string} escape - the body of a `\p{...}`, e.g. `ID_Start` or `General_Category=Lu`
 * @returns {Array<[number, number]>} sorted, coalesced, inclusive ranges
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

/* --------------------------------------------------------------------------- encoding ------ */

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
 * Round-trips an encoding back to ranges, so the generator never emits a table it has not
 * verified byte for byte.
 *
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
 * Encodes ranges, verifying the round trip.
 *
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

/* ------------------------------------------------------------------------ XID closure ------ */

/**
 * ECMAScript exposes `ID_Start` and `ID_Continue` but not their XID variants, so the XID sets are
 * derived here rather than assumed to coincide with the ID ones.
 *
 * XID_Start and XID_Continue are the NFKC-closed subsets of ID_Start and ID_Continue (UAX #31,
 * D1/D2). The two closure conditions are **not** the same, and using the start rule for both is a
 * silent way to produce a table that is merely a copy of the other:
 *
 * - `XID_Start`: NFKC(x) is non-empty, its first character is `ID_Start`, the rest `ID_Continue`.
 * - `XID_Continue`: NFKC(x) is non-empty and *every* character is `ID_Continue`. The weaker
 *   condition is the point — a digit expands to a digit, which continues an identifier without
 *   being able to start one.
 *
 * @param {string} base - `ID_Start` or `ID_Continue`
 * @returns {number[]} code points in the base property that its XID variant excludes
 */
function xidExclusions(base) {
  const inBase = new RegExp(`^\\p{${base}}$`, 'u');
  const idStart = /^\p{ID_Start}$/u;
  const idContinue = /^\p{ID_Continue}$/u;
  const requiresStart = base === 'ID_Start';
  /** @type {number[]} */
  const excluded = [];

  for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (!inBase.test(ch)) continue;

    const points = [...ch.normalize('NFKC')];
    const closed =
      points.length > 0 &&
      (requiresStart
        ? idStart.test(/** @type {string} */ (points[0])) &&
          points.slice(1).every((c) => idContinue.test(c))
        : points.every((c) => idContinue.test(c)));
    if (!closed) excluded.push(cp);
  }
  return excluded;
}

/**
 * @param {Array<[number, number]>} ranges
 * @param {number[]} exclusions
 * @returns {Array<[number, number]>}
 */
function subtract(ranges, exclusions) {
  if (exclusions.length === 0) return ranges;
  const drop = new Set(exclusions);
  /** @type {Array<[number, number]>} */
  const out = [];
  for (const [start, end] of ranges) {
    let runStart = -1;
    for (let cp = start; cp <= end; cp++) {
      if (drop.has(cp)) {
        if (runStart >= 0) {
          out.push([runStart, cp - 1]);
          runStart = -1;
        }
      } else if (runStart < 0) {
        runStart = cp;
      }
    }
    if (runStart >= 0) out.push([runStart, end]);
  }
  return out;
}

/* ------------------------------------------------------------------- emitted runtime ------ */

/**
 * The decoder every generated table file carries. Emitted into each rather than shared, because
 * src/regex/ may import nothing outside itself.
 */
const RUNTIME_HELPERS = `const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

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

/** Expands a delta-varint encoded table into a flat array of inclusive \`[start, end]\` pairs. */
function decodeTable(encoded: string): Uint32Array {
  const bytes = fromBase64(encoded);
  const bounds: number[] = [];
  let i = 0;
  let previousEnd = -1;

  // Running off the end of a well-formed table is impossible; treating it as a terminator rather
  // than asserting keeps the decode total, so a truncated table yields a short table instead of a
  // crash at module load.
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
    // Both indices are in bounds for any table this module decodes; the guard is what lets the
    // reads stay unasserted, and a missing bound can only mean "not in the table".
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
}`;

/**
 * @param {{constant: string, label: string, ranges: Array<[number, number]>, base64: string, byteLength: number}} table
 */
function emitTable(table) {
  return `/** ${table.label}: ${String(table.ranges.length)} ranges, ${String(table.byteLength)} bytes encoded. */
const ${table.constant} = /* @__PURE__ */ decodeTable(
  '${table.base64}',
);`;
}

/* ------------------------------------------------------------------------ xid.ts ---------- */

const XID_PROPERTIES = [
  { escape: 'ID_Start', constant: 'XID_START', label: 'XID_Start', closure: 'ID_Start' },
  {
    escape: 'ID_Continue',
    constant: 'XID_CONTINUE',
    label: 'XID_Continue',
    closure: 'ID_Continue',
  },
  { escape: 'Nd', constant: 'DECIMAL_DIGIT', label: 'Nd', closure: null },
];

function buildXid() {
  const tables = XID_PROPERTIES.map(({ escape, constant, label, closure }) => {
    let ranges = collectRanges(escape);
    let excludedCount = 0;
    if (closure !== null) {
      const exclusions = xidExclusions(closure);
      excludedCount = exclusions.length;
      ranges = subtract(ranges, exclusions);
    }
    const { base64, byteLength } = encodeVerified(label, ranges);
    return { constant, label, ranges, base64, byteLength, excludedCount };
  });

  const source = `/**
 * Unicode identifier tables, generated from Unicode ${unicodeVersion}.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with \`npm run gen:unicode\`.
 *
 * These exist so identifier validity is a property of the document, not of the host. A TSON
 * document's identity can be a hash of its bytes, so two runtimes disagreeing about whether an
 * identifier is well-formed would make the same bytes valid in one place and invalid in another.
 * Consulting the host's \`\\p{XID_Start}\` at runtime would do exactly that.
 *
 * {@link UNICODE_VERSION} records the version these tables were derived from. A build whose host
 * disagrees is still correct — the tables, not the host, are authoritative — but the difference is
 * worth knowing about, which is why the constant is exported rather than hidden.
 */

/** The Unicode version {@link isXidStart}, {@link isXidContinue} and {@link isNd} describe. */
export const UNICODE_VERSION = '${unicodeVersion}';

${RUNTIME_HELPERS}

${tables.map(emitTable).join('\n\n')}

const ASCII_LIMIT = 0x80;
const ASCII_XID_START = 1;
const ASCII_XID_CONTINUE = 2;
const ASCII_ND = 4;

/**
 * Membership for the ASCII range as a bitmask per code point.
 *
 * Almost every identifier in almost every document is ASCII, and this is the lexer's hottest loop.
 * Built from the tables above rather than written out, so it cannot drift from them.
 */
const ASCII = /* @__PURE__ */ (() => {
  const flags = new Uint8Array(ASCII_LIMIT);
  for (let cp = 0; cp < ASCII_LIMIT; cp++) {
    let mask = 0;
    if (contains(XID_START, cp)) mask |= ASCII_XID_START;
    if (contains(XID_CONTINUE, cp)) mask |= ASCII_XID_CONTINUE;
    if (contains(DECIMAL_DIGIT, cp)) mask |= ASCII_ND;
    flags[cp] = mask;
  }
  return flags;
})();

function asciiHas(codePoint: number, flag: number): boolean {
  return ((ASCII[codePoint] ?? 0) & flag) !== 0;
}

/** Whether \`codePoint\` may start an identifier (UAX #31 \`XID_Start\`). */
export function isXidStart(codePoint: number): boolean {
  return codePoint < ASCII_LIMIT
    ? asciiHas(codePoint, ASCII_XID_START)
    : contains(XID_START, codePoint);
}

/** Whether \`codePoint\` may continue an identifier (UAX #31 \`XID_Continue\`). */
export function isXidContinue(codePoint: number): boolean {
  return codePoint < ASCII_LIMIT
    ? asciiHas(codePoint, ASCII_XID_CONTINUE)
    : contains(XID_CONTINUE, codePoint);
}

/**
 * Whether \`codePoint\` is in general category \`Nd\`, decimal number.
 *
 * This is the Unicode category, not the ASCII digits: §7.5's unquoted-token profile admits any
 * \`Nd\` as an identifier start. The number grammar's digits are ASCII-only and are matched there
 * by code, not by this table.
 */
export function isNd(codePoint: number): boolean {
  return codePoint < ASCII_LIMIT ? asciiHas(codePoint, ASCII_ND) : contains(DECIMAL_DIGIT, codePoint);
}
`;

  return { source, tables };
}

/* --------------------------------------------------------------- regex/categories.ts ------ */

// The 36 general categories an I-Regexp \p{...} escape admits, per RFC 9485 and the reference
// implementation's RegexCategory. Only the 29 two-letter categories are stored: each one-letter
// category is exactly the union of its members, verified against the host before emitting, so
// deriving them costs one extra lookup and removes 2,320 ranges that could otherwise disagree
// with the parts they are made of.
const CATEGORY_GROUPS = {
  L: ['Lu', 'Ll', 'Lt', 'Lm', 'Lo'],
  M: ['Mn', 'Mc', 'Me'],
  N: ['Nd', 'Nl', 'No'],
  P: ['Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po'],
  Z: ['Zs', 'Zl', 'Zp'],
  S: ['Sm', 'Sc', 'Sk', 'So'],
  C: ['Cc', 'Cf', 'Cn', 'Co'],
};

function buildCategories() {
  const leaves = Object.values(CATEGORY_GROUPS).flat();

  /** @type {Map<string, Array<[number, number]>>} */
  const leafRanges = new Map();
  for (const cat of leaves) {
    leafRanges.set(cat, collectRanges(`General_Category=${cat}`));
  }

  // Verify the union property rather than assuming it: if a future Unicode version ever broke it,
  // deriving the one-letter categories would silently return wrong answers.
  for (const [sup, members] of Object.entries(CATEGORY_GROUPS)) {
    const supTest = new RegExp(`^\\p{General_Category=${sup}}$`, 'u');
    const memberTests = members.map((m) => new RegExp(`^\\p{General_Category=${m}}$`, 'u'));
    for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (supTest.test(ch) !== memberTests.some((t) => t.test(ch))) {
        throw new Error(
          `${sup} is not the union of ${members.join('/')} at U+${cp.toString(16).toUpperCase()}`,
        );
      }
    }
  }

  const tables = leaves.map((cat) => {
    const ranges = /** @type {Array<[number, number]>} */ (leafRanges.get(cat));
    const { base64, byteLength } = encodeVerified(cat, ranges);
    return { constant: `GC_${cat.toUpperCase()}`, label: cat, ranges, base64, byteLength };
  });

  const source = `/**
 * Unicode general-category tables for I-Regexp \`\\p{...}\` and \`\\P{...}\`, generated from
 * Unicode ${unicodeVersion}.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with \`npm run gen:unicode\`.
 *
 * This file lives inside \`regex/\` rather than beside the identifier tables in \`unicode/\` because
 * the I-Regexp engine is a leaf: it names no TSON type and imports nothing outside itself, which
 * is what lets it be used and tested on its own. The decoder below is therefore a second copy of
 * the one in \`unicode/xid.ts\`; the generator emits both and is what keeps them identical.
 *
 * Only the 29 two-letter categories are stored. Each one-letter category is exactly the union of
 * its members — verified against the host at generation time, not assumed — so \`\\p{L}\` is
 * answered by asking the five letter categories rather than by a 677-range table that could
 * disagree with the parts it is made of.
 */

/** The Unicode version these tables were derived from. */
export const UNICODE_VERSION = '${unicodeVersion}';

${RUNTIME_HELPERS}

${tables.map(emitTable).join('\n\n')}

/** The two-letter general categories, each backed by its own table. */
const LEAF_TABLES: Readonly<Record<string, Uint32Array>> = {
${leaves.map((c) => `  ${c}: GC_${c.toUpperCase()},`).join('\n')}
};

/** The one-letter categories, each the union of its members. */
const GROUPS: Readonly<Record<string, readonly string[]>> = {
${Object.entries(CATEGORY_GROUPS)
  .map(([sup, members]) => `  ${sup}: [${members.map((m) => `'${m}'`).join(', ')}],`)
  .join('\n')}
};

/**
 * Every category name an I-Regexp \`\\p{...}\` escape may name, in the reference implementation's
 * order. A parser should reject anything outside this set rather than treating it as unmatched.
 */
export const CATEGORY_NAMES: readonly string[] = [
${Object.entries(CATEGORY_GROUPS)
  .map(([sup, members]) => `  '${sup}', ${members.map((m) => `'${m}'`).join(', ')},`)
  .join('\n')}
];

const CATEGORY_NAME_SET = /* @__PURE__ */ new Set(CATEGORY_NAMES);

/** Whether \`name\` is a general category this engine recognises. */
export function isCategoryName(name: string): boolean {
  return CATEGORY_NAME_SET.has(name);
}

/**
 * Whether \`codePoint\` is in general category \`name\`.
 *
 * Returns \`false\` for a name this engine does not recognise; callers that need to reject an
 * unknown category as a syntax error should check {@link isCategoryName} while parsing, where
 * there is a position to report it at.
 */
export function isInCategory(name: string, codePoint: number): boolean {
  const leaf = LEAF_TABLES[name];
  if (leaf !== undefined) return contains(leaf, codePoint);

  const members = GROUPS[name];
  if (members === undefined) return false;

  for (const member of members) {
    const table = LEAF_TABLES[member];
    if (table !== undefined && contains(table, codePoint)) return true;
  }
  return false;
}
`;

  return { source, tables };
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

const xid = buildXid();
await write(XID_PATH, xid.source);

const categories = buildCategories();
await write(CATEGORIES_PATH, categories.source);

console.log('unicode/xid.ts');
for (const t of xid.tables) {
  const note = t.excludedCount > 0 ? `, ${String(t.excludedCount)} excluded by XID` : '';
  console.log(
    `  ${t.label.padEnd(13)} ${String(t.ranges.length).padStart(4)} ranges  ${String(t.byteLength).padStart(5)} bytes${note}`,
  );
}

const categoryRanges = categories.tables.reduce((n, t) => n + t.ranges.length, 0);
const categoryBytes = categories.tables.reduce((n, t) => n + t.byteLength, 0);
console.log(
  `regex/categories.ts\n  ${String(categories.tables.length)} categories  ${String(categoryRanges)} ranges  ${String(categoryBytes)} bytes  (7 one-letter categories derived)`,
);
console.log(`\nUnicode ${unicodeVersion} (${String(Date.now() - started)} ms)`);
