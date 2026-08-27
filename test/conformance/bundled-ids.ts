/**
 * The three schema documents this suite's reference implementation bundles, and the short,
 * unversioned names a vector's sidecar may use to refer to them (`meta`/`import` fields; see
 * the test-suite README's "Schema-governed vectors").
 *
 * Real identities off `ltr8-io-tson-java`'s `TsonBundledSchemas` (Revision 33): a version
 * bump only ever touches this table, never the vectors that reference `core.tn`.
 */
export const BUNDLED_SCHEMA_IDS = {
  'meta-kernel.tn': 'https://tson.io/2026/33/m/meta-kernel.tn',
  'meta.tn': 'https://tson.io/2026/33/m/meta.tn',
  'core.tn': 'https://tson.io/2026/33/m/core.tn',
} as const satisfies Record<string, string>;

/** A short, unversioned bundled-schema name usable in a sidecar's `meta`/`import` fields. */
export type BundledSchemaShortName = keyof typeof BUNDLED_SCHEMA_IDS;

/**
 * Resolves a sidecar's short schema name (e.g. `"core.tn"`) to its real, versioned identity.
 *
 * @throws {Error} if `shortName` is not one of {@link BUNDLED_SCHEMA_IDS}'s three entries.
 */
export function resolveBundledSchemaId(shortName: string): string {
  if (Object.hasOwn(BUNDLED_SCHEMA_IDS, shortName)) {
    return BUNDLED_SCHEMA_IDS[shortName as BundledSchemaShortName];
  }
  throw new Error(
    `unknown schema short name '${shortName}' -- expected one of ${Object.keys(BUNDLED_SCHEMA_IDS).join(', ')}`,
  );
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
