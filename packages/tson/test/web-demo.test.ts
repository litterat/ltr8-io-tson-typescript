/**
 * The demo under `examples/web-demo/` is built by `npm run demo:web`, and a build that succeeds
 * proves only that the bundle carries no Node built-in -- it never runs a scenario. So the demo
 * schema's `!!meta`/`!!import` identities can name a spec revision the bundled schemas no longer
 * carry, every schema-layer scenario silently stops resolving, and CI stays green with the page
 * blank. That is exactly what the 2026 Revision 34 to Revision 35 move did to it.
 *
 * This runs each scenario the way the page does and pins what it reports. The counts are the
 * demo's own claim -- its "ten planted errors" chip is a promise about `validate()`'s collecting
 * mode -- so a scenario that stops producing them has stopped demonstrating the thing.
 */
import { describe, expect, it } from 'vitest';
import { validate } from '../src/index.js';
import { standardLibrary } from '../src/stdlib/index.js';
import { SCENARIOS, SCHEMA, type Scenario } from '../../../examples/web-demo/src/scenarios.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** One `standardLibrary()` per compile, as `demo.js` does: `resolveSchema` registers under the schema's own `!!id`, so the same registry cannot take it twice. */
function compileDemoSchema() {
  const tson = standardLibrary();
  return tson.compile(tson.resolveSchema(SCHEMA));
}

function scenario(id: string): Scenario {
  const found = SCENARIOS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`the demo declares no scenario '${id}'`);
  return found;
}

describe('the web demo (examples/web-demo)', () => {
  it('compiles its schema against the bundled standard library', () => {
    expect(() => compileDemoSchema()).not.toThrow();
  });

  // Each scenario's own promise, as the page's chip states it. A schema-layer scenario reads
  // against the compiled schema; the schemaless one reads with none at all (Class 1).
  it.each([
    ['valid', 0],
    ['planted', 10],
    ['missing', 4],
    ['syntax', 1],
    ['schemaless', 1],
  ])('scenario %s reports %i diagnostic(s)', (id, expected) => {
    const s = scenario(id);
    const result =
      s.root === ''
        ? validate(bytes(s.data))
        : validate(bytes(s.data), { schema: compileDemoSchema(), root: s.root });
    expect(result.diagnostics).toHaveLength(expected);
  });

  // The schemaless scenario exists to show the built-in vocabulary and what falls outside it, so
  // its one diagnostic must be the unknown type annotation and nothing else. It read as a lexer
  // error instead, because it wrote a bare `2026-08-28T05:14:00Z`: §7.1 excludes the temporal
  // kinds carrying a clock time from the token profile entirely -- "a calendar date lies wholly
  // inside the profile and is spellable bare; a time never is, the colon being the one character
  // that ends it".
  it('reads the schemaless scenario cleanly apart from its one unknown type', () => {
    const { diagnostics } = validate(bytes(scenario('schemaless').data));
    expect(diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
  });
});
