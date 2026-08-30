#!/usr/bin/env node
/**
 * Checks that every peer dependency the lockfile declares resolves to an entry the lockfile
 * actually contains, at a location the declaring package can see.
 *
 * This is the one integrity property `npm ci` enforces that no other check in this repo reaches.
 * `npm ci` refuses a lockfile whose tree does not cover a dependency some locked package declares
 * — "Missing: @emnapi/core@1.11.3 from lock file" — but it only refuses on a machine that installs
 * the package in question. The chain that broke here is `unrs-resolver`'s wasm fallback binding,
 * installed only where no native binding exists: on linux-x64 the native binding wins, the wasm
 * one is never installed, its peers are never resolved, and `npm ci` passes over a lockfile that
 * fails everywhere else. A green CI runner proved nothing.
 *
 * The check reads the lockfile alone: no network, no install, no node_modules, and the same
 * verdict on every platform. Run it with `npm run check:lockfile`.
 *
 * What it does not check is version satisfaction against the declared range — that would need a
 * semver implementation this repo has no dependency for, and the failure mode it would catch is
 * not the one that has bitten. Presence at a visible location is the property `npm ci` names.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(REPO_ROOT, 'package-lock.json');

/**
 * The locations `path` can resolve `name` from, nearest first — Node's own resolution order:
 * a package looks in its own `node_modules`, then in each ancestor's, out to the root.
 *
 * @param {string} path - a lockfile `packages` key, e.g. `node_modules/a/node_modules/b`
 * @param {string} name - the dependency being resolved
 * @returns {string[]} candidate lockfile keys, nearest first
 */
function resolutionCandidates(path, name) {
  const candidates = [];
  const segments = path === '' ? [] : path.split('/');
  for (let end = segments.length; end >= 0; end--) {
    const prefix = segments.slice(0, end).join('/');
    candidates.push(prefix === '' ? `node_modules/${name}` : `${prefix}/node_modules/${name}`);
  }
  return candidates;
}

const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
const packages = lock.packages ?? {};

/** @type {Array<{ from: string, peer: string, range: string }>} */
const unresolved = [];
let checked = 0;

for (const [path, entry] of Object.entries(packages)) {
  const peers = entry.peerDependencies;
  if (peers === undefined) continue;
  const meta = entry.peerDependenciesMeta ?? {};
  for (const [peer, range] of Object.entries(peers)) {
    if (meta[peer]?.optional === true) continue;
    checked++;
    if (!resolutionCandidates(path, peer).some((candidate) => candidate in packages)) {
      unresolved.push({ from: path === '' ? '(root)' : path, peer, range });
    }
  }
}

if (unresolved.length > 0) {
  console.error(
    `package-lock.json: ${unresolved.length} peer dependency(ies) resolve to nothing\n`,
  );
  for (const { from, peer, range } of unresolved) {
    console.error(`  ${from}`);
    console.error(`    needs ${peer}@${range}, which the lockfile places nowhere it can see\n`);
  }
  console.error(
    'npm cannot reach a correct tree by repairing this in place. Regenerate the lockfile:\n' +
      '  rm -rf node_modules package-lock.json && npm install\n',
  );
  process.exit(1);
}

console.log(`package-lock.json: ${checked} peer dependencies all resolve.`);
