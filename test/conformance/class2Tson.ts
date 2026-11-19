import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Tson } from '../../packages/tson/src/config.js';
import { standardLibrary } from '../../packages/tson/src/stdlib/index.js';

import { CORPUS_SCHEMA_PREFIX } from './bundled-ids.js';

/**
 * A fresh Class 2 {@link Tson} for one vector: the standard library (the six bundled schemas) plus
 * the corpus schemas that vector's `subject` reaches, transitively.
 *
 * **A fresh instance per vector, always** (`newClass2Tson()` builds one, never a shared
 * singleton) -- the reference implementation's own `Class2ConformanceSuiteTest.newTson()` note
 * applies here too: "each holds its own schema registry, and a vector registering a schema must
 * not be able to satisfy the next one's reference to it".
 *
 * **The corpus's schemas are served by path** (RUNNER.md, "Every subject is a complete document"):
 * `https://tson.io/test-suite/schemas/<path>` is the file `schemas/<path>` of the checkout, a rule
 * rather than a table, and any other identity a subject imports is a bundled schema this processor
 * already holds. The reach is read off the subject's own text and off each reached schema's own
 * `!!import` headers, so the topology stays a rule about which files exist. Each reached schema
 * resolves on its own; one that does not fails exactly the vectors that import it.
 *
 * **No {@link SchemaSource} is wired up for the corpus's schemas, deliberately.**
 * `config.ts`'s own top note is explicit that `Tson.resolveSchema` "resolves only against what is
 * already registered... never fetches", so a `SchemaSource` would still need every reached schema
 * preloaded before a subject naming one could resolve. Registering the reached files directly,
 * dependencies first, is `config.ts`'s own "simpler" alternative. A reached schema that never
 * resolves throws here with its real error, which is what fails the vectors that need it.
 */
export function newClass2Tson(subject: Uint8Array): Tson {
  const tson = standardLibrary();
  if (!existsSync(SCHEMAS_ROOT)) {
    return tson;
  }

  const reached = new Map<string, Uint8Array>();
  const queue: string[] = [new TextDecoder().decode(subject)];
  for (let text = queue.pop(); text !== undefined; text = queue.pop()) {
    for (const path of corpusPathsIn(text)) {
      if (reached.has(path)) continue;
      const file = `${SCHEMAS_ROOT}/${path}`;
      if (!existsSync(file)) continue; // not a schema the corpus serves: a bundled identity, or none
      const bytes = readFileSync(file);
      reached.set(path, bytes);
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
        `a corpus schema this vector imports does not resolve -- ${causes.join('; ')}`,
      );
    }
  }
  return tson;
}

/** Every path under the corpus's schema prefix that `text` names, in order of appearance. */
function corpusPathsIn(text: string): string[] {
  const paths: string[] = [];
  for (let at = text.indexOf(CORPUS_SCHEMA_PREFIX); at >= 0;) {
    const start = at + CORPUS_SCHEMA_PREFIX.length;
    const end = text.indexOf('"', start);
    if (end < 0) break;
    paths.push(text.slice(start, end));
    at = text.indexOf(CORPUS_SCHEMA_PREFIX, end);
  }
  return paths;
}

const SCHEMAS_ROOT = fileURLToPath(
  new URL('../../.references/ltr8-io-tson-test-suite/schemas', import.meta.url),
);
