/**
 * The six schema documents this implementation bundles, by their full revision-stamped identity
 * (`https://tson.io/2026/40/m/*.tn`). A subject names one in its own `!!import` header exactly as
 * written here -- RUNNER.md's "Every subject is a complete document" -- so this table is for the
 * harness's own use (naming the kernel, say), never for adding a header a subject lacks. A revision
 * bump only ever touches this table, never a vector.
 */
export const BUNDLED_SCHEMA_IDS = {
  'meta.tn': 'https://tson.io/2026/40/m/meta.tn',
  'numeric.tn': 'https://tson.io/2026/40/m/numeric.tn',
  'temporal.tn': 'https://tson.io/2026/40/m/temporal.tn',
  'net.tn': 'https://tson.io/2026/40/m/net.tn',
  'core.tn': 'https://tson.io/2026/40/m/core.tn',
  'policy.tn': 'https://tson.io/2026/40/m/policy.tn',
} as const satisfies Record<string, string>;

/**
 * The corpus's own schemas (`schemas/` under the suite checkout) are named by their path under
 * this prefix: `fixtures/link-money.tn` is `https://tson.io/test-suite/schemas/fixtures/link-money.tn`.
 * A rule, not a table, so a new corpus fixture needs no change here (RUNNER.md).
 */
export const CORPUS_SCHEMA_PREFIX = 'https://tson.io/test-suite/schemas/';
