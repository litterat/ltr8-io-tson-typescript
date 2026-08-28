#!/usr/bin/env node
/**
 * Generates the checked-in copy of the three bundled schemas the CLI bootstraps at startup:
 *
 *   packages/cli/src/bundledSchemas.generated.ts
 *
 * `@ltr8/tson` itself embeds no standard library (`STATUS.md`'s "known gaps" -- deliberately out
 * of scope for the front-door package, since a browser consumer of `parse`/`readTree` should not
 * pay for meta-kernel/meta.tn/core.tn it never asked to load). The CLI is Node-only and *always*
 * wants the standard library available offline (`tson validate --schema ...` has to work with no
 * network access), so it carries its own copy the same way `spec/` itself is vendored: read once
 * from the pinned reference commit's `spec/m/*.tn` and embedded as string constants, rather than
 * read from disk at run time (a published `@ltr8/tson-cli` package is not installed next to this
 * repository's `spec/` directory).
 *
 * Each `.tn` file's exact bytes are embedded via `JSON.stringify`, which handles every escape a
 * schema document's own text could contain (quotes, backslashes, the triple-quoted `@doc` bodies)
 * correctly regardless of content -- no hand-rolled escaping to get subtly wrong.
 *
 * Run with `npm run gen:cli-schemas`. Output must be a no-op diff against a matching `spec/m/`;
 * re-run this whenever `CLAUDE.md`'s vendored-spec pin moves.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import prettier from 'prettier';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_M = join(REPO_ROOT, 'spec/m');
const OUT_PATH = join(REPO_ROOT, 'packages/cli/src/bundledSchemas.generated.ts');

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

console.log(`packages/cli/src/bundledSchemas.generated.ts`);
for (const { file, text } of parts) {
  console.log(`  ${file.padEnd(16)} ${String(text.length).padStart(6)} bytes`);
}
