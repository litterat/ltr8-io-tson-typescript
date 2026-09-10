/**
 * Types for `scenarios.js`, which ships to the browser as plain JavaScript and carries none of its
 * own. Declared here rather than by turning `allowJs` on across the package: the file the page
 * ships is the file `packages/tson/test/web-demo.test.ts` checks, and a type declaration is the
 * cheapest way to let it import that file instead of re-stating the fixtures.
 */

/** One worked example: a data document, the root type to read it against, and the chip's label. */
export interface Scenario {
  readonly id: string;
  readonly label: string;
  /** The root type name, or `''` to read with no schema at all (Class 1). */
  readonly root: string;
  readonly data: string;
}

/** The demo schema every schema-layer scenario is read against. */
export const SCHEMA: string;

export const SCENARIOS: readonly Scenario[];
