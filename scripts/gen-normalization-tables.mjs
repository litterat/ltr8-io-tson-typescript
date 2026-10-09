#!/usr/bin/env node
/**
 * Generates the checked-in compatibility-normalization tables:
 *
 *   packages/tson/src/unicode/normalization-tables.ts
 *       the compatibility decomposition of every code point whose NFKD differs from its NFD, and the
 *       `NFKC_Casefold` value of every code point whose value is not itself
 *
 * They are the data behind two of the five `normalization` forms ([TSON-SCHEMA] §5.5): `NFKC` is
 * NFC of the text with each code point put through the first table, and `NFKC_CASEFOLD` -- UAX #31
 * §5's form for identifiers compared without case, `toNFKC_Casefold` (The Unicode Standard §3.13,
 * `DerivedNormalizationProps.txt`'s `NFKC_CF`) -- is NFC of the text with each code point put through
 * the second. Which spellings of a name are one value depends on them, and the Unicode Standard
 * revises both with each release, which is why they are checked in rather than asked of the host at
 * runtime: two runtimes on different Unicode versions must not disagree about whether two names are
 * the same key (`CLAUDE.md`, "Spec feedback"). NFC itself is the sanctioned exception, because
 * canonical decompositions are frozen.
 *
 * **How the table is derived.** ECMAScript exposes no `NFKC_Casefold` property escape, so this
 * script applies the definition to this host's own character data, exactly as the pinned Java
 * reference does (`NfkcCasefold.java`, which states its derivation was verified against
 * `DerivedNormalizationProps.txt` for Unicode 16.0): NFKD, then a full case fold, then the
 * `Default_Ignorable_Code_Point` characters removed, then NFKC, repeated until the text stops
 * changing. The full case fold is `toUpperCase` then `toLowerCase`, which differs from
 * `CaseFolding.txt`'s C and F mappings in exactly three places, each handled here as the reference
 * handles it: dotless `ı` folds to itself, the Cherokee letters fold to their uppercase forms, and
 * U+13F8..13FD fold onto U+13F0..13F5. `Default_Ignorable_Code_Point` is the host's own escape.
 *
 * `UNICODE_VERSION` (this Node build's `process.versions.unicode`) is recorded in the output. As
 * with `scripts/gen-unicode-tables.mjs`, a host carrying another Unicode version cannot verify the
 * table, and regenerating there is a behavioural change that belongs in its own commit.
 *
 * Encoding: entries sorted by code point, each a varint gap from the previous code point, a varint
 * count of replacement code points, then that many absolute varints; base64-wrapped.
 *
 * Run with `npm run gen:normalization`. Output must be a no-op diff on a matching Unicode version.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import prettier from 'prettier';

const MAX_CODE_POINT = 0x10ffff;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_PATH = join(REPO_ROOT, 'packages/tson/src/unicode/normalization-tables.ts');

const unicodeVersion = process.versions.unicode;

const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;

/** @param {string} text */
function withoutIgnorables(text) {
  return [...text].filter((c) => !DEFAULT_IGNORABLE.test(c)).join('');
}

/** @param {string} text */
function fold(text) {
  let out = '';
  for (const c of text) {
    const cp = /** @type {number} */ (c.codePointAt(0));
    if (cp === 0x0131 || (cp >= 0x13a0 && cp <= 0x13f5)) {
      out += c;
    } else if (cp >= 0x13f8 && cp <= 0x13fd) {
      out += String.fromCodePoint(cp - 8);
    } else if (cp >= 0xab70 && cp <= 0xabbf) {
      out += String.fromCodePoint(cp - 0xab70 + 0x13a0);
    } else {
      out += c.toUpperCase().toLowerCase();
    }
  }
  return out;
}

/**
 * One code point's `NFKC_Casefold` value.
 *
 * @param {number} cp
 * @returns {string}
 */
function mapCodePoint(cp) {
  let s = String.fromCodePoint(cp);
  for (let pass = 0; pass < 8; pass++) {
    const next = withoutIgnorables(fold(s.normalize('NFKD'))).normalize('NFKC');
    if (next === s) return s;
    s = next;
  }
  throw new Error(`U+${cp.toString(16).toUpperCase()}: NFKC_Casefold did not settle`);
}

/** @param {number[]} out @param {number} value */
function pushVarint(out, value) {
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

/**
 * @param {Array<[number, number[]]>} entries
 * @returns {Uint8Array}
 */
function encode(entries) {
  /** @type {number[]} */
  const out = [];
  let previous = -1;
  for (const [cp, replacement] of entries) {
    pushVarint(out, cp - previous - 1);
    pushVarint(out, replacement.length);
    for (const r of replacement) pushVarint(out, r);
    previous = cp;
  }
  return Uint8Array.from(out);
}

/**
 * Round-trips an encoding back to entries, so the generator never emits a table it has not
 * verified.
 *
 * @param {Uint8Array} bytes
 * @returns {Array<[number, number[]]>}
 */
function decode(bytes) {
  /** @type {Array<[number, number[]]>} */
  const entries = [];
  let i = 0;
  let previous = -1;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = /** @type {number} */ (bytes[i++]);
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  };
  while (i < bytes.length) {
    const cp = previous + 1 + readVarint();
    const count = readVarint();
    /** @type {number[]} */
    const replacement = [];
    for (let k = 0; k < count; k++) replacement.push(readVarint());
    entries.push([cp, replacement]);
    previous = cp;
  }
  return entries;
}

/**
 * Every code point `differs` says has a value, with that value, encoded and round-trip verified.
 *
 * @param {string} label
 * @param {(cp: number) => string | undefined} valueOf - `undefined` when the code point has none
 */
function buildTable(label, valueOf) {
  /** @type {Array<[number, number[]]>} */
  const entries = [];
  for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const mapped = valueOf(cp);
    if (mapped === undefined) continue;
    entries.push([cp, [...mapped].map((c) => /** @type {number} */ (c.codePointAt(0)))]);
  }
  const bytes = encode(entries);
  const back = decode(bytes);
  if (
    back.length !== entries.length ||
    !back.every(
      (e, k) =>
        e[0] === entries[k]?.[0] &&
        e[1].length === entries[k][1].length &&
        e[1].every((r, j) => r === entries[k]?.[1][j]),
    )
  ) {
    throw new Error(`${label}: encode/decode round trip disagreed`);
  }
  return { entries, bytes, base64: Buffer.from(bytes).toString('base64') };
}

const compatibility = buildTable('compatibility decomposition', (cp) => {
  const c = String.fromCodePoint(cp);
  const compat = c.normalize('NFKD');
  return compat === c.normalize('NFD') ? undefined : compat;
});

const casefold = buildTable('NFKC_Casefold', (cp) => {
  const mapped = mapCodePoint(cp);
  return mapped === String.fromCodePoint(cp) ? undefined : mapped;
});

const source = `/**
 * Compatibility-normalization data, generated from Unicode ${unicodeVersion}: the compatibility
 * decomposition and the \`NFKC_Casefold\` mapping.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with \`npm run gen:normalization\`.
 *
 * Which spellings of a name are one value under the \`NFKC\` and \`NFKC_CASEFOLD\` normalization forms
 * ([TSON-SCHEMA] §5.5) depends on these tables, and the Unicode Standard revises them with each
 * release. They are checked in so that two runtimes on different Unicode versions cannot disagree
 * about whether two names are the same key; the host's own character data is never consulted for
 * them. \`scripts/gen-normalization-tables.mjs\` states how they are derived.
 *
 * {@link NORMALIZATION_UNICODE_VERSION} records the version they were derived from.
 */

/** The Unicode version these tables describe. */
export const NORMALIZATION_UNICODE_VERSION = '${unicodeVersion}';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** ${String(compatibility.entries.length)} code points whose compatibility decomposition is not their canonical one, ${String(compatibility.bytes.length)} bytes encoded. */
const COMPATIBILITY_ENCODED =
  '${compatibility.base64}';

/** ${String(casefold.entries.length)} code points whose \`NFKC_Casefold\` value is not themselves, ${String(casefold.bytes.length)} bytes encoded. */
const CASEFOLD_ENCODED =
  '${casefold.base64}';

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

function decode(encoded: string): ReadonlyMap<number, string> {
  const bytes = fromBase64(encoded);
  const table = new Map<number, string>();
  let i = 0;
  let previous = -1;

  // Running off the end of a well-formed table is impossible; treating it as a terminator keeps the
  // decode total, so a truncated table yields a short one instead of a crash.
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
    const codePoint = previous + 1 + readVarint();
    const count = readVarint();
    let replacement = '';
    for (let k = 0; k < count; k++) replacement += String.fromCodePoint(readVarint());
    table.set(codePoint, replacement);
    previous = codePoint;
  }
  return table;
}

let compatibility: ReadonlyMap<number, string> | undefined;
let casefold: ReadonlyMap<number, string> | undefined;

/**
 * \`codePoint\`'s full compatibility decomposition (UAX #15's NFKD of the one code point), or
 * \`undefined\` when it is the same as its canonical decomposition -- the code point then needs no
 * compatibility mapping, and NFC puts it in order.
 */
export function compatibilityDecompositionOf(codePoint: number): string | undefined {
  compatibility ??= decode(COMPATIBILITY_ENCODED);
  return compatibility.get(codePoint);
}

/**
 * \`codePoint\`'s \`NFKC_Casefold\` value, or \`undefined\` when it is its own value. The empty string
 * is a real answer: a default-ignorable code point maps to nothing.
 */
export function nfkcCasefoldOf(codePoint: number): string | undefined {
  casefold ??= decode(CASEFOLD_ENCODED);
  return casefold.get(codePoint);
}
`;

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
const formatted = await prettier.format(source, {
  ...(await prettier.resolveConfig(OUTPUT_PATH)),
  filepath: OUTPUT_PATH,
});
writeFileSync(OUTPUT_PATH, formatted);

console.log(
  `unicode/normalization-tables.ts\n` +
    `  compatibility decomposition  ${String(compatibility.entries.length)} entries  ${String(compatibility.bytes.length)} bytes\n` +
    `  NFKC_Casefold                ${String(casefold.entries.length)} entries  ${String(casefold.bytes.length)} bytes\n` +
    `  Unicode ${unicodeVersion}`,
);
