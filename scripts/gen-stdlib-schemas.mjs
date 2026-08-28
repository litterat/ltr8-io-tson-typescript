#!/usr/bin/env node
/**
 * Generates the checked-in copy of the three bundled schemas the standard library ships:
 *
 *   packages/tson/src/stdlib/schemas.generated.ts
 *
 * They are embedded as string constants rather than read from disk at run time, for two reasons
 * that both matter: a published package is not installed next to this repository's `spec/`
 * directory, and reading files is not something a browser build can do at all. Embedding is what
 * makes `@ltr8/tson/stdlib` work identically in Node and in a browser with no I/O of any kind.
 *
 * They live behind their own subpath, never on the package's default entry, so a consumer of
 * `parse`/`readTree` does not pay for a standard library it never asked to load. That property is
 * why this is generated into `stdlib/` rather than into `index.ts`'s import graph.
 *
 * Each `.tn` file's exact bytes are embedded via `JSON.stringify`, which handles every escape a
 * schema document's own text could contain (quotes, backslashes, the triple-quoted `@doc` bodies)
 * correctly regardless of content -- no hand-rolled escaping to get subtly wrong.
 *
 * Run with `npm run gen:stdlib-schemas`. Output must be a no-op diff against a matching `spec/m/`;
 * re-run this whenever `CLAUDE.md`'s vendored-spec pin moves.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import prettier from 'prettier';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_M = join(REPO_ROOT, 'spec/m');
const OUT_PATH = join(REPO_ROOT, 'packages/tson/src/stdlib/schemas.generated.ts');

const SCHEMAS = [
  { file: 'meta-kernel.tn', constant: 'META_KERNEL_TN' },
  { file: 'meta.tn', constant: 'META_TN' },
  { file: 'core.tn', constant: 'CORE_TN' },
];

const parts = SCHEMAS.map(({ file, constant }) => {
  const text = readFileSync(join(SPEC_M, file), 'utf8');
  const idLine = text.split(/\r\n|\r|\n/u)[0] ?? '';
  return { file, constant, text, idLine };
});

const source = `/**
 * The three bundled schemas' exact source text, vendored verbatim from \`spec/m/\` -- generated,
 * do not hand-edit. See \`scripts/gen-cli-bundled-schemas.mjs\` for how and why.
 *
 * Regenerate with \`npm run gen:cli-schemas\` whenever \`spec/m/\` moves to a new pin.
 */

${parts
  .map(
    ({
      constant,
      file,
      text,
      idLine,
    }) => `/** \`spec/m/${file}\`'s own header: \`${idLine.replace(/\*\//gu, '*\\/')}\` */
export const ${constant} = ${JSON.stringify(text)};
`,
  )
  .join('\n')}`;

mkdirSync(dirname(OUT_PATH), { recursive: true });
const formatted = await prettier.format(source, {
  ...(await prettier.resolveConfig(OUT_PATH)),
  filepath: OUT_PATH,
});
writeFileSync(OUT_PATH, formatted);

console.log(`packages/tson/src/stdlib/schemas.generated.ts`);
for (const { file, text } of parts) {
  console.log(`  ${file.padEnd(16)} ${String(text.length).padStart(6)} bytes`);
}
