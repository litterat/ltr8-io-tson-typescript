#!/usr/bin/env node
/**
 * Generates `packages/tson/src/unicode/xid.ts`.
 *
 * The lexer decides identifier boundaries from real `XID_Start` / `XID_Continue` tables rather
 * than from the host's `\p{...}` regex support. That is deliberate: a TSON document's identity
 * can be a hash of its bytes, so two runtimes must never disagree about whether a document is
 * well-formed. Node 22 and Node 24 in the same container already ship different Unicode
 * versions; asking the host at runtime would make validity a property of the host.
 *
 * The tables are therefore derived once, here, from whichever Unicode version this Node build
 * carries, and checked in. `UNICODE_VERSION` in the output records which one, so a mismatch is
 * visible rather than silent.
 *
 * Encoding: each property is a sorted list of inclusive code-point ranges, delta-varint encoded
 * (gap from the previous range's end, then the range's own width) and base64-wrapped. Deltas are
 * small, so most ranges cost two bytes.
 *
 * Run with `npm run gen:unicode`. Output must be a no-op diff on a matching Unicode version.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import prettier from 'prettier';

const MAX_CODE_POINT = 0x10ffff;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = join(REPO_ROOT, 'packages/tson/src/unicode/xid.ts');

/**
 * Collects the inclusive ranges of code points matching a single Unicode property escape.
 *
 * @param {string} property - a property name valid inside `\p{...}`
 * @returns {Array<[number, number]>} sorted, coalesced, inclusive ranges
 */
function collectRanges(property) {
  const test = new RegExp(`^\\p{${property}}$`, 'u');
  /** @type {Array<[number, number]>} */
  const ranges = [];
  let start = -1;

  for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
    // Lone surrogates are not scalar values and cannot appear in well-formed text. Skipping
    // them keeps a run from being split in two by a gap no document can contain anyway.
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

/**
 * Appends an unsigned LEB128 varint.
 *
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
 * Delta-varint encodes ranges into bytes.
 *
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
 * @param {Array<[number, number]>} a
 * @param {Array<[number, number]>} b
 * @returns {boolean}
 */
function rangesEqual(a, b) {
  return a.length === b.length && a.every((r, i) => r[0] === b[i][0] && r[1] === b[i][1]);
}

const PROPERTIES = [
  {
    property: 'ID_Start',
    constant: 'XID_START',
    // `\p{XID_Start}` is not a valid property escape in ECMAScript; `ID_Start` is. They differ
    // only in code points excluded from XID because NFKC-normalising them breaks identifier
    // stability. The exclusion set is empty for ID_Start in current Unicode, but assert rather
    // than assume — see verifyXidDelta below.
    xid: 'XID_Start',
  },
  { property: 'ID_Continue', constant: 'XID_CONTINUE', xid: 'XID_Continue' },
  { property: 'Nd', constant: 'DECIMAL_DIGIT', xid: null },
];

/**
 * ECMAScript exposes `ID_Start` and `ID_Continue` but not their XID variants, so the XID sets
 * are derived here rather than assumed to coincide with the ID ones.
 *
 * XID_Start and XID_Continue are the NFKC-closed subsets of ID_Start and ID_Continue (UAX #31,
 * D1/D2). The two closure conditions are **not** the same, and using the start rule for both is
 * a silent way to produce a table that is merely a copy of the other:
 *
 * - `XID_Start`: NFKC(x) is non-empty, its first character is `ID_Start`, and the rest are
 *   `ID_Continue`.
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

const started = Date.now();

const tables = PROPERTIES.map(({ property, constant, xid }) => {
  let ranges = collectRanges(property);
  let excludedCount = 0;

  if (xid !== null) {
    const exclusions = xidExclusions(property);
    excludedCount = exclusions.length;
    ranges = subtract(ranges, exclusions);
  }

  const bytes = encodeRanges(ranges);
  if (!rangesEqual(decodeRanges(bytes), ranges)) {
    throw new Error(`${constant}: encode/decode round trip disagreed`);
  }

  return {
    constant,
    label: xid ?? property,
    ranges,
    excludedCount,
    base64: Buffer.from(bytes).toString('base64'),
    byteLength: bytes.length,
  };
});

const unicodeVersion = process.versions.unicode;

const source = `/**
 * Unicode character property tables, generated from Unicode ${unicodeVersion}.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with \`npm run gen:unicode\`.
 *
 * These tables exist so identifier validity is a property of the document, not of the host.
 * A TSON document's identity can be a hash of its bytes (§8.3), so two runtimes disagreeing
 * about whether an identifier is well-formed would make the same bytes valid in one place and
 * invalid in another. Consulting the host's \`\\p{XID_Start}\` at runtime would do exactly that:
 * Node builds of the same age already ship different Unicode versions.
 *
 * {@link UNICODE_VERSION} records the version these tables were derived from. A build whose host
 * disagrees is still correct — the tables, not the host, are authoritative — but the difference
 * is worth knowing about, which is why the constant is exported rather than hidden.
 *
 * Each table is a sorted list of inclusive code-point ranges, delta-varint encoded and
 * base64-wrapped, decoded once at module load into a flat \`Uint32Array\` of \`[start, end]\`
 * pairs. Lookup is a binary search over that array.
 */

/** The Unicode version {@link isXidStart}, {@link isXidContinue} and {@link isDecimalDigit} describe. */
export const UNICODE_VERSION = '${unicodeVersion}';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decodes a base64 string to bytes without \`atob\` or \`Buffer\`.
 *
 * The package declares no ambient host globals beyond \`TextEncoder\`, and this runs in both Node
 * and browsers, so the decode is spelled out rather than delegated.
 */
function fromBase64(text: string): Uint8Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    lookup[BASE64_ALPHABET.charCodeAt(i)] = i;
  }

  let padding = 0;
  while (padding < 2 && text.charCodeAt(text.length - 1 - padding) === 0x3d /* '=' */) padding++;

  // A character outside the alphabet reads as -1, which is also what an out-of-range index
  // yields here. Padding is the only such character these tables contain.
  const sextet = (index: number): number => lookup[text.charCodeAt(index)] ?? -1;

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
 * Expands a delta-varint encoded table into a flat array of inclusive \`[start, end]\` pairs.
 */
function decodeTable(encoded: string): Uint32Array {
  const bytes = fromBase64(encoded);
  const bounds: number[] = [];
  let i = 0;
  let previousEnd = -1;

  // Reads one unsigned LEB128 varint, advancing \`i\`. Running off the end of a well-formed
  // table is impossible; treating it as a terminator rather than asserting keeps the decode
  // total, so a truncated table yields a short table instead of a crash at module load.
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

    const start = previousEnd + 1 + (gap >>> 0);
    const end = start + (width >>> 0);
    bounds.push(start, end);
    previousEnd = end;
  }

  return Uint32Array.from(bounds);
}

/**
 * Binary search over a flat \`[start, end, start, end, ...]\` array of inclusive ranges.
 */
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
}

${tables
  .map(
    (
      t,
    ) => `/** ${t.label}: ${String(t.ranges.length)} ranges, ${String(t.byteLength)} bytes encoded. */
const ${t.constant} = /* @__PURE__ */ decodeTable(
  '${t.base64}',
);`,
  )
  .join('\n\n')}

const ASCII_LIMIT = 0x80;
const ASCII_XID_START = 1;
const ASCII_XID_CONTINUE = 2;
const ASCII_ND = 4;

/**
 * Membership for the ASCII range as a bitmask per code point.
 *
 * Almost every identifier in almost every document is ASCII, and this is the lexer's hottest
 * loop. Built from the tables above rather than written out, so it cannot drift from them.
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

const formatted = await prettier.format(source, {
  ...(await prettier.resolveConfig(OUT_PATH)),
  filepath: OUT_PATH,
});

writeFileSync(OUT_PATH, formatted);

const elapsed = Date.now() - started;
for (const t of tables) {
  const note = t.excludedCount > 0 ? `, ${String(t.excludedCount)} excluded by XID` : '';
  console.log(
    `${t.label.padEnd(13)} ${String(t.ranges.length).padStart(4)} ranges  ${String(t.byteLength).padStart(5)} bytes${note}`,
  );
}
console.log(`\nUnicode ${unicodeVersion} -> ${OUT_PATH} (${String(elapsed)} ms)`);
