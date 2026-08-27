#!/usr/bin/env node
/**
 * Checks the checked-in Unicode tables without letting the host decide what they should contain.
 *
 * The tables exist so identifier validity is a property of the document rather than of the
 * runtime. A check that regenerated them and demanded a clean diff against whatever Unicode
 * version the CI runner happens to carry would reintroduce exactly that host dependence — and it
 * would fail for a reason that is not a defect. This is not hypothetical: GitHub's Node 24
 * runners carry Unicode 17.0 while other Node 24 builds carry 16.0, so `node-version: 24` pins
 * the runtime but not the character data.
 *
 * So the check is conditional on the host agreeing with the tables:
 *
 * - Host Unicode == the version recorded in the tables → regenerate and require a no-op diff.
 *   This catches a hand-edited table and a table left stale after the generator changed.
 * - Host Unicode != that version → report both and pass. The committed table is authoritative;
 *   the host merely cannot verify it.
 *
 * Either way the two generated files must agree with each other about which version they describe,
 * because a build carrying identifier tables from one Unicode version and category tables from
 * another would be incoherent in a way nothing else would catch.
 *
 * Exits non-zero only on a real problem.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const GENERATED = ['packages/tson/src/unicode/xid.ts', 'packages/tson/src/regex/categories.ts'];

/** @param {string} relative */
function recordedVersion(relative) {
  const source = readFileSync(join(REPO_ROOT, relative), 'utf8');
  const match = /export const UNICODE_VERSION = '([^']+)'/.exec(source);
  if (match === null) {
    throw new Error(`${relative}: no UNICODE_VERSION found — is the file generated?`);
  }
  return match[1];
}

const versions = GENERATED.map((f) => ({ file: f, version: recordedVersion(f) }));
const distinct = [...new Set(versions.map((v) => v.version))];

if (distinct.length !== 1) {
  console.error('The generated tables disagree about their Unicode version:');
  for (const v of versions) console.error(`  ${v.file}  ${v.version}`);
  console.error('\nRegenerate both together with `npm run gen:unicode`.');
  process.exit(1);
}

const tableVersion = distinct[0];
const hostVersion = process.versions.unicode;

console.log(`tables:  Unicode ${tableVersion}`);
console.log(
  `host:    Unicode ${hostVersion} (Node ${process.versions.node}, ICU ${process.versions.icu})`,
);

if (hostVersion !== tableVersion) {
  console.log(
    `\nHost and tables differ, so this host cannot verify them. That is not a failure: the
committed tables are authoritative and are what every runtime uses, which is the whole reason
they are checked in rather than computed at import.

To move the port to Unicode ${hostVersion}, regenerate on a host carrying it and commit the result
as a deliberate change — the tables decide which documents are well-formed, so that is a
behavioural change and belongs in its own commit.`,
  );
  process.exit(0);
}

console.log('\nHost matches; regenerating to confirm the tables are current.');

// Compare the generator's output against the files as they are on disk, not against git HEAD.
// A tree with unrelated uncommitted work is normal during a wave, and comparing to HEAD would
// report it as a stale table — which trains everyone to ignore this check.
const before = new Map(GENERATED.map((f) => [f, readFileSync(join(REPO_ROOT, f), 'utf8')]));

execFileSync('node', [join(REPO_ROOT, 'scripts/gen-unicode-tables.mjs')], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});

const stale = GENERATED.filter((f) => readFileSync(join(REPO_ROOT, f), 'utf8') !== before.get(f));

if (stale.length > 0) {
  console.error(`\nThese tables are not what the generator produces on this host:`);
  for (const f of stale) console.error(`  ${f}`);
  console.error('\nThe regenerated files are now on disk. Review the diff and commit them.');
  process.exit(1);
}

console.log('\nTables are current.');
