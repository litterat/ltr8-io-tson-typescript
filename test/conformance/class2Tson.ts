import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Tson } from '../../packages/tson/src/config.js';
import { standardLibrary } from '../../packages/tson/src/stdlib/index.js';

/**
 * A fresh Class 2 {@link Tson}: the standard library (meta-kernel, meta.tn, core.tn) plus every
 * corpus fixture schema under `schemas/fixtures/` already registered.
 *
 * **A fresh instance per vector, always** (`newClass2Tson()` builds one, never a shared
 * singleton) -- the reference implementation's own `Class2ConformanceSuiteTest.newTson()` note
 * applies here too: "each holds its own schema registry, and a vector registering a schema must
 * not be able to satisfy the next one's reference to it".
 *
 * **No {@link SchemaSource} is wired up for the corpus's fixtures, deliberately.**
 * `config.ts`'s own top note is explicit that `Tson.resolveSchema` "resolves only against what is
 * already registered... never fetches", so a `SchemaSource` would still need every fixture
 * preloaded before a subject naming one could resolve -- wiring one up would add an async
 * `preload()` step and a fetch indirection for no behavioural gain. Registering the four (tiny,
 * already on local disk) fixture files directly is `config.ts`'s own "simpler" alternative, and
 * needs no source object at all.
 *
 * Fixtures import each other (`link-billing.tn`/`link-shipping.tn` both `!!import`
 * `link-money.tn`), so this resolves in dependency order by retrying: each pass registers
 * whatever now has every `!!import` already registered, until nothing is left. A future fixture
 * needs no change here, whatever it imports -- this is the same "rule, not a table" property
 * `bundled-ids.ts`'s own short-name resolution has.
 */
export function newClass2Tson(): Tson {
  const tson = standardLibrary();
  if (!existsSync(FIXTURES_ROOT)) {
    return tson;
  }
  const pending = new Map<string, Uint8Array>(
    readdirSync(FIXTURES_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tn'))
      .map((entry) => {
        const path = `${FIXTURES_ROOT}/${entry.name}`;
        return [path, readFileSync(path)] as const;
      }),
  );
  while (pending.size > 0) {
    let progressed = false;
    for (const [path, bytes] of pending) {
      try {
        tson.resolveSchema(bytes);
      } catch {
        continue; // not yet resolvable -- an !!import this pass hasn't registered yet
      }
      pending.delete(path);
      progressed = true;
    }
    if (!progressed) {
      throw new Error(
        'class2 fixture schemas did not converge -- these never resolved (a real error in one ' +
          `of them, not just ordering): ${[...pending.keys()].join(', ')}`,
      );
    }
  }
  return tson;
}

const FIXTURES_ROOT = fileURLToPath(
  new URL('../../.references/ltr8-io-tson-test-suite/schemas/fixtures', import.meta.url),
);
