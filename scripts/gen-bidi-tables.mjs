#!/usr/bin/env node
/**
 * Generates the checked-in Bidi_Class table:
 *
 *   packages/tson/src/unicode/bidi-tables.ts   the eleven Bidi_Class values RFC 5893's Bidi rule
 *                                               distinguishes, per code point
 *
 * RFC 5893 §2's six conditions are stated over the Unicode `Bidi_Class` property, and ECMAScript
 * has no property escape for it, so unlike `gen-idna-tables.mjs` this generator cannot probe the
 * host. It reads the Unicode 16.0.0 data published as the `@unicode/unicode-16.0.0` package, a
 * mechanical extraction of the UCD's `DerivedBidiClass.txt` (defaults for unassigned code points
 * included). The package is not a dependency of this repository and is installed without
 * recording it:
 *
 *     npm install --no-save @unicode/unicode-16.0.0@2.1.0
 *     npm run gen:bidi
 *
 * Only the classes the Bidi rule names are stored (L, R, AL, AN, EN, ES, CS, ET, ON, BN, NSM);
 * every other class (white space, separators, embeddings, isolates, ...) is "none of them" and is
 * zero. A label's code points are all assigned by the time the rule runs, since RFC 5891 §5.4's
 * validity check precedes it, so an unassigned code point's default class is never consulted.
 *
 * The table is not host-derived, so `npm run check:unicode` does not regenerate it; it does require
 * the recorded `BIDI_UNICODE_VERSION` to agree with the other generated tables.
 *
 * Encoding: `valued-ranges.mjs`'s. Output must be a no-op diff.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import prettier from 'prettier';
import { EMITTED_RUNTIME, emitTable } from './valued-ranges.mjs';

const MAX_CODE_POINT = 0x10ffff;
const UCD_VERSION = '16.0';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_PATH = join(REPO_ROOT, 'packages/tson/src/unicode/bidi-tables.ts');

/** The classes stored, by short alias and the long name the data package uses; codes are 1-based. */
const CLASSES = [
  ['L', 'Left_To_Right'],
  ['R', 'Right_To_Left'],
  ['AL', 'Arabic_Letter'],
  ['AN', 'Arabic_Number'],
  ['EN', 'European_Number'],
  ['ES', 'European_Separator'],
  ['CS', 'Common_Separator'],
  ['ET', 'European_Terminator'],
  ['ON', 'Other_Neutral'],
  ['BN', 'Boundary_Neutral'],
  ['NSM', 'Nonspacing_Mark'],
];

/** @returns {Promise<Map<number, string>>} */
async function loadBidiClasses() {
  try {
    const module = await import('@unicode/unicode-16.0.0/Bidi_Class/index.mjs');
    return module.default;
  } catch {
    console.error(
      '@unicode/unicode-16.0.0 is not installed. Install it without recording it:\n' +
        '  npm install --no-save @unicode/unicode-16.0.0@2.1.0',
    );
    process.exit(1);
  }
}

/**
 * @param {Map<number, string>} classes
 * @returns {Array<[number, number, number]>}
 */
function collect(classes) {
  const codes = new Map(CLASSES.map(([, name], i) => [name, i + 1]));
  /** @type {Array<[number, number, number]>} */
  const runs = [];
  let start = -1;
  let current = 0;
  for (let cp = 0; cp <= MAX_CODE_POINT + 1; cp++) {
    let value = 0;
    if (cp <= MAX_CODE_POINT) {
      const name = classes.get(cp);
      if (name === undefined) throw new Error(`no Bidi_Class for U+${cp.toString(16)}`);
      value = codes.get(name) ?? 0;
    }
    if (value !== current) {
      if (current !== 0) runs.push([start, cp - 1, current]);
      start = cp;
      current = value;
    }
  }
  return runs;
}

/** @param {Array<[number, number, number]>} runs */
function buildSource(runs) {
  const constants = CLASSES.map(
    ([short, long], i) =>
      `/** {@link bidiClassCode}'s result for \`${short}\` (${long.replaceAll('_', ' ')}). */\nexport const BIDI_${short} = ${String(i + 1)};`,
  ).join('\n');
  return `/**
 * Bidi_Class (UAX #9) for RFC 5893's Bidi rule, generated from Unicode ${UCD_VERSION}.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with \`npm run gen:bidi\`.
 *
 * Only the eleven classes RFC 5893 §2 names are stored; any other class is zero.
 */

/** The Unicode version {@link bidiClassCode} describes. */
export const BIDI_UNICODE_VERSION = '${UCD_VERSION}';

${constants}

${EMITTED_RUNTIME}

${emitTable({ constant: 'BIDI_CLASS', label: 'Bidi_Class, for the classes RFC 5893 names', runs })}
/**
 * \`codePoint\`'s Bidi_Class as one of the \`BIDI_*\` constants, or zero when it is a class the Bidi
 * rule does not name.
 */
export function bidiClassCode(codePoint: number): number {
  return valueAt(BIDI_CLASS, codePoint);
}
`;
}

const runs = collect(await loadBidiClasses());
console.log(`Unicode ${UCD_VERSION}: ${String(runs.length)} Bidi_Class ranges`);
const formatted = await prettier.format(buildSource(runs), {
  ...(await prettier.resolveConfig(OUTPUT_PATH)),
  filepath: OUTPUT_PATH,
});
writeFileSync(OUTPUT_PATH, formatted);
console.log(`wrote ${OUTPUT_PATH}`);
