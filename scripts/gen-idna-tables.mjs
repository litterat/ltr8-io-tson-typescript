#!/usr/bin/env node
/**
 * Generates the checked-in IDNA2008 table:
 *
 *   packages/tson/src/unicode/idna-tables.ts   RFC 5892's derived property, per code point, and the
 *                                               three general-category classes IDNA's own label
 *                                               checks ask about
 *
 * RFC 5892 §3 defines the derived property (PVALID, CONTEXTJ, CONTEXTO, DISALLOWED, UNASSIGNED) as
 * an algorithm over Unicode properties, not a table, and IANA stopped publishing the table after
 * Unicode 12.0. A host name is part of a document's identity (§2.2.1) and an identity is a hash
 * input, so two runtimes must never disagree about whether a U-label is valid: the algorithm is
 * therefore run here, once, over this Node build's character data, and its result is checked in.
 * The host is never consulted at runtime. The file records `IDNA_UNICODE_VERSION`.
 *
 * **Derivation, in RFC 5892 §3's own order** (the first category a code point falls in decides):
 * Exceptions (§2.6) -> Unassigned (§2.8: `Cn` and not a noncharacter) -> the join controls ->
 * Unstable (§2.2), IgnorableProperties (§2.3), IgnorableBlocks (§2.4), OldHangulJamo (§2.9) ->
 * LetterDigits (§2.1: `Ll Lu Lo Nd Lm Mn Mc`) -> otherwise DISALLOWED. ASCII is LDH alone (§2.5).
 * `Unstable` is NFKC, then a full case fold, then NFKC again, differing from the code point itself;
 * the fold is `scripts/gen-normalization-tables.mjs`'s, which states and checks it against
 * `DerivedNormalizationProps.txt`.
 *
 * **Checked against IANA's last table.** When the pinned reference checkout is present
 * (`.references/ltr8-io-tson-java`), the result is compared with Unicode 12.0's published
 * `idna-tables-properties.csv`, which the Java suite carries: every code point 12.0 assigns must
 * derive to 12.0's value, because the property is built never to move for an assigned code point.
 * A difference stops the script.
 *
 * **The name classes.** `Bidi_Class` is a separate file (`gen-bidi-tables.mjs`), since ECMAScript
 * has no escape for it. This file also carries three general-category classes that RFC 5891 §4.2.3
 * and §5.4's label checks and the host-name grammar ask about and `uts39.ts` does not carry: a
 * combining mark (`Mn`, `Mc`, `Me`), a decimal digit (`Nd`) and an uppercase letter (`Uppercase`,
 * for a refusal's message).
 *
 * Encoding: a list of `(gap, width, value)` varint triples over inclusive code-point ranges, gap
 * measured from the previous range's end, base64-wrapped. Value 0 is the default and is not
 * stored. Run with `npm run gen:idna`. Output must be a no-op diff on a matching Unicode version.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import prettier from 'prettier';
import { EMITTED_RUNTIME, emitTable } from './valued-ranges.mjs';

const MAX_CODE_POINT = 0x10ffff;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_PATH = join(REPO_ROOT, 'packages/tson/src/unicode/idna-tables.ts');
const IANA_CSV = join(
  REPO_ROOT,
  '.references/ltr8-io-tson-java/ltr8-unicode/src/test/resources/io/ltr8/unicode/idna-tables-12.0.0-properties.csv',
);

const unicodeVersion = process.versions.unicode;

/** The derived property's values; 0 (DISALLOWED) is the default and never stored. */
const PVALID = 1;
const CONTEXTJ = 2;
const CONTEXTO = 3;
const UNASSIGNED = 4;
const PROPERTY_NAMES = ['DISALLOWED', 'PVALID', 'CONTEXTJ', 'CONTEXTO', 'UNASSIGNED'];

/** The name classes' values; 0 is "none of them". */
const CLASS_MARK = 1;
const CLASS_DIGIT = 2;
const CLASS_UPPERCASE = 3;

const NONCHARACTER = /^\p{Noncharacter_Code_Point}$/u;
const UNASSIGNED_CATEGORY = /^\p{General_Category=Unassigned}$/u;
const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
const WHITE_SPACE = /^\p{White_Space}$/u;
const LETTER_DIGIT = /^[\p{Ll}\p{Lu}\p{Lo}\p{Nd}\p{Lm}\p{Mn}\p{Mc}]$/u;
const MARK = /^[\p{Mn}\p{Mc}\p{Me}]$/u;
const DECIMAL_DIGIT = /^\p{Nd}$/u;
const UPPERCASE = /^\p{Uppercase}$/u;

/* ------------------------------------------------------------------ the derivation ------ */

/**
 * `CaseFolding.txt`'s full fold (statuses C and F), as `gen-normalization-tables.mjs` computes it:
 * `toUpperCase` then `toLowerCase`, with the three places that differs from the file handled.
 *
 * @param {string} text
 */
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

/** RFC 5892 §2.6: the Exceptions, which override every derived category. */
function exception(cp) {
  switch (cp) {
    case 0x00df:
    case 0x03c2:
    case 0x06fd:
    case 0x06fe:
    case 0x0f0b:
    case 0x3007:
      return PVALID;
    case 0x00b7:
    case 0x0375:
    case 0x05f3:
    case 0x05f4:
    case 0x30fb:
      return CONTEXTO;
    case 0x0640:
    case 0x07fa:
    case 0x302e:
    case 0x302f:
    case 0x3031:
    case 0x3032:
    case 0x3033:
    case 0x3034:
    case 0x3035:
    case 0x303b:
      return 0;
    default:
      return (cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06f0 && cp <= 0x06f9)
        ? CONTEXTO
        : undefined;
  }
}

/** @param {number} cp */
function isOldHangulJamo(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0xa960 && cp <= 0xa97c) ||
    (cp >= 0xd7b0 && cp <= 0xd7c6) ||
    (cp >= 0xd7cb && cp <= 0xd7fb)
  );
}

/** @param {number} cp */
function isIgnorableBlock(cp) {
  return (
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0x1d100 && cp <= 0x1d1ff) ||
    (cp >= 0x1d200 && cp <= 0x1d24f)
  );
}

/**
 * RFC 5892 §3 for one code point.
 *
 * @param {number} cp
 */
function derive(cp) {
  if (cp < 0x80) {
    const ldh = (cp >= 0x61 && cp <= 0x7a) || (cp >= 0x30 && cp <= 0x39) || cp === 0x2d;
    return ldh ? PVALID : 0;
  }
  const exceptional = exception(cp);
  if (exceptional !== undefined) return exceptional;
  const ch = String.fromCodePoint(cp);
  const noncharacter = NONCHARACTER.test(ch);
  if (UNASSIGNED_CATEGORY.test(ch) && !noncharacter) return UNASSIGNED;
  if (cp === 0x200c || cp === 0x200d) return CONTEXTJ;
  const nfkc = ch.normalize('NFKC');
  const unstable = fold(nfkc).normalize('NFKC') !== ch;
  if (
    unstable ||
    DEFAULT_IGNORABLE.test(ch) ||
    WHITE_SPACE.test(ch) ||
    noncharacter ||
    isIgnorableBlock(cp) ||
    isOldHangulJamo(cp)
  ) {
    return 0;
  }
  return LETTER_DIGIT.test(ch) ? PVALID : 0;
}

/** @param {number} cp */
function nameClass(cp) {
  const ch = String.fromCodePoint(cp);
  if (MARK.test(ch)) return CLASS_MARK;
  if (DECIMAL_DIGIT.test(ch)) return CLASS_DIGIT;
  if (UPPERCASE.test(ch)) return CLASS_UPPERCASE;
  return 0;
}

/**
 * Runs `valueAt` over every scalar value and collects maximal runs of one non-zero value.
 *
 * @param {(cp: number) => number} valueAt
 * @returns {Array<[number, number, number]>}
 */
function collect(valueAt) {
  /** @type {Array<[number, number, number]>} */
  const runs = [];
  let start = -1;
  let current = 0;
  for (let cp = 0; cp <= MAX_CODE_POINT + 1; cp++) {
    const value = cp > MAX_CODE_POINT || (cp >= 0xd800 && cp <= 0xdfff) ? 0 : valueAt(cp);
    if (value !== current) {
      if (current !== 0) runs.push([start, cp - 1, current]);
      start = cp;
      current = value;
    }
  }
  return runs;
}

/* ------------------------------------------------------------------------ IANA check ------ */

/**
 * Compares the derivation with IANA's Unicode 12.0 table. Skipped, with a notice, when the pinned
 * reference checkout is absent.
 *
 * @param {(cp: number) => number} valueAt
 */
function checkAgainstIana(valueAt) {
  if (!existsSync(IANA_CSV)) {
    console.warn(
      `${IANA_CSV} is absent; the derivation was not checked against IANA's Unicode 12.0 table. ` +
        'Run ./scripts/fetch-references.sh to populate it.',
    );
    return;
  }
  const lines = readFileSync(IANA_CSV, 'utf8').split('\n').slice(1);
  let compared = 0;
  /** @type {string[]} */
  const differences = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    const [codes, name] = line.trim().split(',');
    if (name === 'UNASSIGNED') continue;
    const expected = PROPERTY_NAMES.indexOf(/** @type {string} */ (name));
    if (expected < 0) throw new Error(`unknown IANA property '${name}'`);
    const [from, to] = /** @type {string} */ (codes).split('-').map((h) => Number.parseInt(h, 16));
    for (let cp = /** @type {number} */ (from); cp <= (to ?? from ?? 0); cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      compared++;
      const derived = valueAt(cp);
      if (derived !== expected && differences.length < 20) {
        differences.push(
          `U+${cp.toString(16).toUpperCase().padStart(4, '0')}: 12.0 says ${name}, derived ${PROPERTY_NAMES[derived]}`,
        );
      }
    }
  }
  if (differences.length > 0 || compared < 270_000) {
    console.error(`IANA 12.0 check failed after comparing ${String(compared)} code points:`);
    for (const d of differences) console.error(`  ${d}`);
    process.exit(1);
  }
  console.log(
    `derivation agrees with IANA's Unicode 12.0 table over ${String(compared)} code points`,
  );
}

/* -------------------------------------------------------------------------- emitting ------ */

function buildSource() {
  const propertyCache = new Map();
  /** @param {number} cp */
  const property = (cp) => {
    let value = propertyCache.get(cp);
    if (value === undefined) {
      value = derive(cp);
      propertyCache.set(cp, value);
    }
    return value;
  };
  checkAgainstIana(property);

  const propertyRuns = collect(property);
  const classRuns = collect(nameClass);
  const counts = new Map();
  for (const [start, end, value] of propertyRuns) {
    counts.set(value, (counts.get(value) ?? 0) + (end - start + 1));
  }
  console.log(
    `Unicode ${unicodeVersion}: ` +
      [PVALID, CONTEXTJ, CONTEXTO, UNASSIGNED]
        .map((v) => `${String(counts.get(v) ?? 0)} ${PROPERTY_NAMES[v]}`)
        .join(', '),
  );

  return `/**
 * IDNA2008's derived property (RFC 5892 §3) for every code point, generated from Unicode ${unicodeVersion}.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with \`npm run gen:idna\`.
 *
 * A host name is part of a document's identity (§2.2.1), so whether a U-label is valid must be a
 * property of the document rather than of the runtime. RFC 5892 defines the property as an
 * algorithm over Unicode properties and IANA stopped publishing its values after Unicode 12.0, so
 * the algorithm was run once, at generation, and its result is checked in. The generator checks
 * the result against IANA's Unicode 12.0 table: every code point 12.0 assigns derives to 12.0's
 * value.
 */

/** The Unicode version {@link idnaPropertyCode} and {@link nameClassOf} describe. */
export const IDNA_UNICODE_VERSION = '${unicodeVersion}';

/** {@link idnaPropertyCode}'s result: \`DISALLOWED\` is zero, so a code point in no range. */
export const IDNA_DISALLOWED = 0;
/** {@link idnaPropertyCode}'s result for RFC 5892's \`PVALID\`. */
export const IDNA_PVALID = ${String(PVALID)};
/** {@link idnaPropertyCode}'s result for RFC 5892's \`CONTEXTJ\`. */
export const IDNA_CONTEXTJ = ${String(CONTEXTJ)};
/** {@link idnaPropertyCode}'s result for RFC 5892's \`CONTEXTO\`. */
export const IDNA_CONTEXTO = ${String(CONTEXTO)};
/** {@link idnaPropertyCode}'s result for RFC 5892's \`UNASSIGNED\`. */
export const IDNA_UNASSIGNED = ${String(UNASSIGNED)};

/** {@link nameClassOf}'s result for a combining mark: \`Mn\`, \`Mc\` or \`Me\`. */
export const CLASS_COMBINING_MARK = ${String(CLASS_MARK)};
/** {@link nameClassOf}'s result for a decimal digit: \`Nd\`. */
export const CLASS_DECIMAL_DIGIT = ${String(CLASS_DIGIT)};
/** {@link nameClassOf}'s result for a code point with the \`Uppercase\` property. */
export const CLASS_UPPERCASE = ${String(CLASS_UPPERCASE)};

${EMITTED_RUNTIME}

${emitTable({
  constant: 'IDNA_PROPERTY',
  label:
    'RFC 5892 derived property (PVALID, CONTEXTJ, CONTEXTO, UNASSIGNED; every other code point is DISALLOWED)',
  runs: propertyRuns,
})}
${emitTable({
  constant: 'NAME_CLASS',
  label:
    'Combining marks (Mn, Mc, Me), decimal digits (Nd) and Uppercase code points, as one partition',
  runs: classRuns,
})}
/**
 * RFC 5892's derived property of \`codePoint\`: one of the \`IDNA_*\` constants. Total over every
 * code point; a lone surrogate, which no well-formed text holds, is \`IDNA_DISALLOWED\`.
 */
export function idnaPropertyCode(codePoint: number): number {
  return valueAt(IDNA_PROPERTY, codePoint);
}

/**
 * Which of the three general-category classes IDNA's label checks ask about \`codePoint\` falls in:
 * \`CLASS_COMBINING_MARK\`, \`CLASS_DECIMAL_DIGIT\`, \`CLASS_UPPERCASE\`, or zero for none.
 */
export function nameClassOf(codePoint: number): number {
  return valueAt(NAME_CLASS, codePoint);
}
`;
}

const source = buildSource();
const formatted = await prettier.format(source, {
  ...(await prettier.resolveConfig(OUTPUT_PATH)),
  filepath: OUTPUT_PATH,
});
writeFileSync(OUTPUT_PATH, formatted);
console.log(`wrote ${OUTPUT_PATH}`);
