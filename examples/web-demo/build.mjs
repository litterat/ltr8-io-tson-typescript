#!/usr/bin/env node
/**
 * Bundles the demo into `dist/` as three static files — no server, no framework, nothing to
 * configure. Drop the directory anywhere that serves static files.
 *
 * Bundled with `platform: 'browser'`, which is what makes the demo also a *test*: the browser
 * condition cannot resolve `@ltr8/tson/source`, and esbuild refuses a Node built-in rather than
 * shimming one, so a build that succeeds is a build that carries neither.
 */
import { build } from 'esbuild';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [join(here, 'src/demo.js')],
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: join(dist, 'demo.js'),
  // Resolve the library from source when run inside this repository, and from the installed
  // package when the example is copied out of it. Both work; the condition is simply ignored
  // when there is no workspace to resolve it against.
  conditions: ['@ltr8/source'],
});

await cp(join(here, 'src/demo.css'), join(dist, 'demo.css'));

const js = await readFile(join(dist, 'demo.js'));
const css = await readFile(join(dist, 'demo.css'));
const gzipped = gzipSync(Buffer.concat([js, css]), { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

// The page states its own bundle size, so the claim cannot drift from the artifact.
const html = (await readFile(join(here, 'index.html'), 'utf8')).replace(
  '<strong id="size">…</strong>',
  `<strong id="size">${kb(gzipped)}</strong>`,
);
await writeFile(join(dist, 'index.html'), html);

console.log(`  demo.js   ${kb((await stat(join(dist, 'demo.js'))).size)} minified`);
console.log(`  demo.css  ${kb(css.length)}`);
console.log(`  total     ${kb(gzipped)} gzipped`);
