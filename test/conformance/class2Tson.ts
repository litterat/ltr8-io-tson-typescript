import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { LinkedSchema } from '../../packages/tson/src/link/link.js';
import type { SchemaSource, Tson } from '../../packages/tson/src/config.js';
import { TsonSchemaFetchError } from '../../packages/tson/src/core/errors.js';
import { createDataStream } from '../../packages/tson/src/stream/dataStream.js';
import { fromBytes, runSync } from '../../packages/tson/src/io/bytes.js';
import { standardLibrary } from '../../packages/tson/src/stdlib/index.js';

import { CORPUS_SCHEMA_PREFIX } from './bundled-ids.js';

/**
 * A fresh Class 2 {@link Tson} for one vector: the standard library (the six bundled schemas) plus a
 * {@link SchemaSource} serving the corpus's own schemas.
 *
 * **A fresh instance per vector, always** (`newClass2Tson()` builds one, never a shared
 * singleton) -- the reference implementation's own `Class2ConformanceSuiteTest.newTson()` note
 * applies here too: "each holds its own schema registry, and a vector registering a schema must
 * not be able to satisfy the next one's reference to it".
 *
 * **The corpus's schemas are served by path** (RUNNER.md, "Every subject is a complete document"):
 * `https://tson.io/test-suite/schemas/<path>` is the file `schemas/<path>` of the checkout, a rule
 * rather than a table, and any other identity a subject imports is a bundled schema this processor
 * already holds.
 *
 * **Schemas resolve on demand, never up front.** The Java reference reads each `!!import` through its
 * `SchemaAccess` when the subject names it. This is the same: {@link loadImports} preloads exactly what
 * the subject's own header names, each fetched schema bringing the schemas its own header names first
 * (`Tson.preload`), so a schema that does not resolve -- or a document that is no schema at all, which
 * RUNNER.md serves as `fixtures/a-data-document.tn` "to be refused as an import" -- fails the vector that
 * imports it, with the library's own verdict, and no other.
 */
export function newClass2Tson(): Tson {
  return standardLibrary({ schemaSource: corpusSource });
}

/** The `!!import`s `subject`'s own header names. A subject that does not parse names none; the read itself reports why. */
export function importsOf(subject: Uint8Array): readonly string[] {
  try {
    const start = runSync(createDataStream(fromBytes(subject)).next());
    return start.kind === 'document-start' ? start.imports : [];
  } catch {
    return [];
  }
}

/**
 * Obtains every schema `subject`'s header imports, as the processor does for a document it reads
 * (`Tson.preload`): fetched through the corpus source and resolved in dependency order, throwing the
 * library's own error for one that cannot be.
 */
export async function loadImports(tson: Tson, subject: Uint8Array): Promise<void> {
  await tson.preload(importsOf(subject));
}

/**
 * Loads `subject` as a schema document through the front door (`Tson.loadSchema`): everything it names -- its
 * `!!import`s and the schema of each extern it declares ([TSON-SCHEMA] §3.4.1, §5.13) -- is obtained first, with
 * the subject in flight under its own `!!id`, so a reference reaching that identity is the library's reference
 * cycle (§2.2.3) and never a fetch the corpus source would answer `not-found` (RUNNER.md, "Every subject is a
 * complete document").
 */
export async function loadSchema(tson: Tson, subject: Uint8Array): Promise<LinkedSchema> {
  return tson.loadSchema(subject);
}

/** Serves the corpus's own schemas, by the path under `schemas/` an identity ends in. */
const corpusSource: SchemaSource = {
  fetch(reference: string): Promise<Uint8Array> {
    // A `?sha256=` pin is no part of the file, and a scheme-relative spelling is the same identity.
    const query = reference.indexOf('?');
    const bare = query < 0 ? reference : reference.slice(0, query);
    const identity = bare.startsWith('//') ? `https:${bare}` : bare;
    if (identity.startsWith(CORPUS_SCHEMA_PREFIX)) {
      const file = `${SCHEMAS_ROOT}/${identity.slice(CORPUS_SCHEMA_PREFIX.length)}`;
      if (existsSync(file)) return Promise.resolve(readFileSync(file));
    }
    return Promise.reject(
      new TsonSchemaFetchError(reference, 'not-found', `no such corpus schema: ${identity}`),
    );
  },
};

const SCHEMAS_ROOT = fileURLToPath(
  new URL('../../.references/ltr8-io-tson-test-suite/schemas', import.meta.url),
);
