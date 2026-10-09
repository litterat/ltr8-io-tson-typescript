import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Tson } from '../../packages/tson/src/config.js';
import { standardLibrary } from '../../packages/tson/src/stdlib/index.js';

/**
 * A fresh Class 2 {@link Tson} for one vector: the standard library (meta-kernel, meta.tn,
 * core.tn) plus the corpus fixture schemas that vector's `subject` reaches, transitively.
 *
 * **A fresh instance per vector, always** (`newClass2Tson()` builds one, never a shared
 * singleton) -- the reference implementation's own `Class2ConformanceSuiteTest.newTson()` note
 * applies here too: "each holds its own schema registry, and a vector registering a schema must
 * not be able to satisfy the next one's reference to it".
 *
 * **Fixtures are resolved on demand, per vector** (RUNNER.md, "Schema-governed vectors": a runner
 * serves a fixture from its checkout and "each one resolves on its own"). The reference serves
 * `https://tson.io/test-suite/schemas/...` lazily through its schema access, so a fixture that
 * fails to resolve fails exactly the vectors that import it. Here the reach is read off the
 * subject -- the spliced `!!schema`/`!!import` directives name a fixture by its full identity --
 * and off each reached fixture's own `!!import`/`!!schema` headers, so the topology stays a rule
 * about which files exist rather than a table.
 *
 * **No {@link SchemaSource} is wired up for the corpus's fixtures, deliberately.**
 * `config.ts`'s own top note is explicit that `Tson.resolveSchema` "resolves only against what is
 * already registered... never fetches", so a `SchemaSource` would still need every reached fixture
 * preloaded before a subject naming one could resolve. Registering the reached files directly,
 * dependencies first, is `config.ts`'s own "simpler" alternative. A reached fixture that never
 * resolves throws here with its real error, which is what fails the vectors that need it.
 */
export function newClass2Tson(subject: Uint8Array): Tson {
  const tson = standardLibrary();
  if (!existsSync(FIXTURES_ROOT)) {
    return tson;
  }
  const available = readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tn'))
    .map((entry) => entry.name);

  const reached = new Map<string, Uint8Array>();
  const queue: string[] = [new TextDecoder().decode(subject)];
  for (let text = queue.pop(); text !== undefined; text = queue.pop()) {
    for (const name of available) {
      if (reached.has(name) || !text.includes(`${FIXTURE_IDENTITY_PREFIX}${name}`)) continue;
      const bytes = readFileSync(`${FIXTURES_ROOT}/${name}`);
      reached.set(name, bytes);
      queue.push(new TextDecoder().decode(bytes));
    }
  }

  const pending = new Map(reached);
  const failures = new Map<string, unknown>();
  while (pending.size > 0) {
    let progressed = false;
    for (const [name, bytes] of pending) {
      try {
        tson.resolveSchema(bytes);
      } catch (error) {
        failures.set(name, error); // an !!import this pass hasn't registered yet, or a real error
        continue;
      }
      pending.delete(name);
      failures.delete(name);
      progressed = true;
    }
    if (!progressed) {
      const causes = [...failures].map(
        ([name, error]) => `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new Error(
        `a fixture schema this vector imports does not resolve -- ${causes.join('; ')}`,
      );
    }
  }
  return tson;
}

const FIXTURE_IDENTITY_PREFIX = 'https://tson.io/test-suite/schemas/fixtures/';

const FIXTURES_ROOT = fileURLToPath(
  new URL('../../.references/ltr8-io-tson-test-suite/schemas/fixtures', import.meta.url),
);
