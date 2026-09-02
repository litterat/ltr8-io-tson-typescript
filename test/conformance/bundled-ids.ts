/**
 * The three schema documents this suite's reference implementation bundles, and the short,
 * unversioned names a vector's sidecar may use to refer to them (`meta`/`import` fields; see
 * the test-suite README's "Schema-governed vectors").
 *
 * Real identities off the test-suite's own README ("Schema-governed vectors" table, Revision 34)
 * and `ltr8-io-tson-java`'s `TsonBundledSchemas`: a version bump only ever touches this table,
 * never the vectors that reference `core.tn`.
 */
export const BUNDLED_SCHEMA_IDS = {
  'meta-kernel.tn': 'https://tson.io/2026/34/m/meta-kernel.tn',
  'meta.tn': 'https://tson.io/2026/34/m/meta.tn',
  'core.tn': 'https://tson.io/2026/34/m/core.tn',
} as const satisfies Record<string, string>;

/** A short, unversioned bundled-schema name usable in a sidecar's `meta`/`import` fields. */
export type BundledSchemaShortName = keyof typeof BUNDLED_SCHEMA_IDS;

/**
 * The corpus's own schemas (`schemas/` under the suite checkout) are named by path under this
 * prefix — RUNNER.md's "Schema-governed vectors": "a short name that is not one of those three is
 * the corpus's own schema, named by its path under `schemas/`".
 */
const CORPUS_SCHEMA_PREFIX = 'https://tson.io/test-suite/schemas/';

/**
 * Resolves a sidecar's short schema name to its real identity: one of {@link BUNDLED_SCHEMA_IDS}'s
 * three revision-stamped entries, or — for any other short name — the corpus's own schema at that
 * path under `schemas/` (`fixtures/link-money.tn` resolves to
 * `https://tson.io/test-suite/schemas/fixtures/link-money.tn`).
 *
 * **A rule, not a table.** The three bundled names are listed because their identity carries the
 * spec revision and nothing in the short name says so; every other short name's identity is
 * derived, so a new corpus fixture (`schemas/fixtures/*.tn`, the `class2/link/` import-closure
 * vectors' own topology) never needs a change here.
 */
export function resolveBundledSchemaId(shortName: string): string {
  if (Object.hasOwn(BUNDLED_SCHEMA_IDS, shortName)) {
    return BUNDLED_SCHEMA_IDS[shortName as BundledSchemaShortName];
  }
  return `${CORPUS_SCHEMA_PREFIX}${shortName}`;
}

/**
 * Splices real `!!meta`/`!!import` directives into a subject's raw header, resolving each
 * short name via {@link resolveBundledSchemaId}.
 *
 * Mirrors `ConformanceSuiteTest.resolvedRaw`: a schema-governed vector's own `.tn` writes its
 * `!!id` (if any) but omits `!!meta`/`!!import` entirely, naming its intended targets by
 * short name in the sidecar instead, so no vector ever hardcodes a versioned spec identity.
 * This function performs the splice a runner applies before parsing such a subject.
 *
 * Can't be a blind prepend: a schema document's header grammar is a fixed sequence — an
 * optional `!!id`, then exactly one `!!meta` ("immediately after `!!id` if present"), then
 * zero or more `!!import` — so the resolved directive block is inserted right after the
 * subject's own `!!id` line, or at the very start if the subject has none.
 */
export function spliceSchemaDirectives(
  raw: string,
  meta: string,
  importNames: readonly string[] = [],
): string {
  let directives = `!!meta:"${resolveBundledSchemaId(meta)}"\n`;
  for (const importName of importNames) {
    directives += `!!import:"${resolveBundledSchemaId(importName)}"\n`;
  }

  let insertAt = 0;
  if (raw.startsWith('!!id:')) {
    const newline = raw.indexOf('\n');
    insertAt = newline === -1 ? raw.length : newline + 1;
  }
  return raw.slice(0, insertAt) + directives + raw.slice(insertAt);
}

/**
 * The data-document counterpart of {@link spliceSchemaDirectives}: splices a single real
 * `!!schema` directive in, for a `class2/validate/` subject. A data document's header is `!!id?
 * !!schema?` (`ast/value.ts`'s own `Document`), not the schema-document sequence `!!id? !!meta
 * !!import*`, so this is a distinct function rather than a call to the other with an empty import
 * list -- the two headers are different grammars, not one generalising the other.
 */
export function spliceSchemaDirective(raw: string, schema: string): string {
  const directive = `!!schema:"${resolveBundledSchemaId(schema)}"\n`;
  let insertAt = 0;
  if (raw.startsWith('!!id:')) {
    const newline = raw.indexOf('\n');
    insertAt = newline === -1 ? raw.length : newline + 1;
  }
  return raw.slice(0, insertAt) + directive + raw.slice(insertAt);
}
