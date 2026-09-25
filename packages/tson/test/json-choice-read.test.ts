/**
 * A port of the Java reference's `JsonChoiceReadTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/JsonChoiceReadTest.java`) -- [TSON-JSON] §8.2's
 * discrimination predicate and §8.3's class stability.
 *
 * Two routes and no third. Route 1 is a declared discriminator (§8.4) and is unbuilt, so every
 * case here is the untagged route -- `disjoint: true` with class-stable variants, dispatching on
 * the JSON value kind -- or the tagged form, or the refusal that follows when neither recovers the
 * variant.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { compileJsonSchema, type JsonCompiledSchema } from '../src/json/schema/compile.js';
import { validateJson } from '../src/json/facade.js';
import { jsonValueToText } from '../src/json/write.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

/**
 * `scalar_or_list` is disjoint with class-stable variants: one per JSON kind, so the untagged
 * route holds. `shape`'s two record variants share the brace class, so it is not disjoint and the
 * tag is required. `unit_circle` is a proper subtype of `circle`, a variant of `shape` -- and,
 * deliberately, *not itself* reachable by tag there (§5.4 gives a choice its own membership
 * relation, not §7.2's general subsumption; see this file's own cases below). `loose` carries
 * §8.3's first leak -- a `float64` still admitting `.nan` and the infinities has string-class
 * values -- and `tight` is the same choice over a variant that narrowed both facets away.
 */
const SCHEMA_SOURCE = `
!!id:"https://example.test/choice-1.tn"
!!meta:"https://tson.io/2026/36/m/meta.tn"
!!import:"https://tson.io/2026/36/m/core.tn"
{
  scalar_or_list => ( text | int32 | boolean | [text] )
  any_json       => ( text | number | boolean | [any_json?] | {text => any_json?} )

  circle      => { radius: float64 }
  square      => { side: float64 }
  shape       => ( circle | square )
  unit_circle => circle & { fixed: boolean }

  loose  => ( float64 | text )
  strict => !float_type { format: BINARY64  allow_nan: false  allow_infinity: false }
  tight  => ( strict | text )

  holder => { pick: scalar_or_list }
}
`;

const COMPILED: JsonCompiledSchema = compileJsonSchema(resolveUserSchema(SCHEMA_SOURCE));

function problemsOf(typeName: string, json: string): readonly Diagnostic[] {
  return validateJson(json, { schema: COMPILED, root: typeName }).diagnostics;
}

function accepted(typeName: string, json: string): string {
  const result = validateJson(json, { schema: COMPILED, root: typeName });
  expect(result.diagnostics, 'expected a clean read').toEqual([]);
  if (result.value === undefined) throw new Error('accepted a read with no value');
  return jsonValueToText(result.value);
}

function refusal(typeName: string, json: string): Diagnostic {
  const problems = problemsOf(typeName, json);
  expect(problems.length, `expected exactly one problem, got ${JSON.stringify(problems)}`).toBe(1);
  const first = problems[0];
  if (first === undefined) throw new Error('unreachable');
  return first;
}

// ── §8.2 untagged: the kind selects ─────────────────────────────────────────────────────────

describe('§8.2 untagged: the kind selects', () => {
  it('a disjoint choice dispatches on the JSON value kind', () => {
    expect(accepted('scalar_or_list', '"hi"')).toBe('"hi"');
    expect(accepted('scalar_or_list', '42')).toBe('42');
    expect(accepted('scalar_or_list', 'true')).toBe('true');
    expect(accepted('scalar_or_list', '["a"]')).toBe('["a"]');
  });

  it('the selected variant is then validated -- dispatch is not acceptance', () => {
    const problem = refusal('scalar_or_list', '["a", 2]');
    expect(problem.code).toBe('TYPE_MISMATCH');
    expect(problem.path).toBe('/1');
  });

  it('a kind no variant bears is refused, and the message names the kinds that are taken', () => {
    const problem = refusal('scalar_or_list', '{"a": 1}');
    expect(problem.code).toBe('TYPE_MISMATCH');
    // This port's own prose spells the discrimination classes lowercase (`CLASS_LABEL` in
    // `dispatchChoice.ts`), where the Java reference's spells the enum constant uppercase -- a
    // casing choice, not a functional difference.
    expect(problem.message.includes('boolean') || problem.message.includes('string')).toBe(true);
  });

  it('§7: null carries no class at all -- it is the absent sentinel, and a choice admits no absence', () => {
    expect(refusal('scalar_or_list', 'null').code).toBe('FIELD_REQUIRED');
  });

  it('the untagged route works at a nested position', () => {
    expect(accepted('holder', '{"pick": 42}')).toBe('{"pick":42}');
  });
});

// ── §8.2: where neither route holds, the tag is REQUIRED ──────────────────────────────────────

describe('§8.2: where neither route holds, the tag is REQUIRED', () => {
  it('two record variants share the brace class, so the choice is not disjoint and the tag is REQUIRED', () => {
    const problem = refusal('shape', '{"radius": 1.0}');
    // TYPE_MISMATCH, matching the TSON reader for the same document -- §9.4 gives both encodings
    // one vocabulary. A required tag that is absent establishes no type, which is what the code
    // says; UNKNOWN_TYPE_REF would claim a name denoted nothing, and there is no name here at all.
    expect(problem.code).toBe('TYPE_MISMATCH');
    expect(problem.message).toContain('$type');
    expect(problem.message).toContain('circle');
  });

  it('and the predicate is not extended: no member-shape matching among record variants', () => {
    // `{"side": 1.0}` is unambiguous to a human -- only `square` declares `side` -- and §8.2
    // forbids recovering the variant that way.
    expect(refusal('shape', '{"side": 1.0}').code).toBe('TYPE_MISMATCH');
  });
});

// ── §8.1: the tagged form, admitted at every choice position ──────────────────────────────────

describe('§8.1: the tagged form, admitted at every choice position', () => {
  it('a tag selects the variant where no route could', () => {
    expect(accepted('shape', '{"$type": "circle", "radius": 1.0}')).toBe('{"radius":1.0}');
  });

  it('"a tag is never wrong": it is accepted where the untagged route would have selected the same variant anyway', () => {
    expect(accepted('shape', '{"$type": "circle", "radius": 1.0}')).toBe('{"radius":1.0}');
    expect(accepted('scalar_or_list', '{"$type": "int32", "$value": 42}')).toBe('42');
  });

  it('§8.3.1: the tagged form is recognised from the first member alone, so a reserved name among a map variant’s later keys is a key', () => {
    expect(accepted('any_json', '{"a": 1, "$type": "x"}')).toBe('{"a":1,"$type":"x"}');
  });

  it('the same name leading the object is the tag, and names no variant here', () => {
    // UNKNOWN_TYPE_REF, not the Java reference's unconditional TYPE_MISMATCH: 'x' is not a
    // declared entry of this schema at all, and `dispatchChoice.ts`/`subsumption.ts` both read
    // §7.2's two-step rule -- a name resolving nowhere is UNKNOWN_TYPE_REF, one resolving to a
    // real entry that is merely not a variant here is TYPE_MISMATCH (`subsumption.ts`'s own top
    // note has the full citation for this deliberate divergence from the reference).
    const problem = refusal('any_json', '{"$type": "x", "a": 1}');
    expect(problem.code).toBe('UNKNOWN_TYPE_REF');
  });

  /**
   * A choice position discriminates by variant type name alone ([TSON-SCHEMA] §5.4's own
   * "Resolution" paragraph), not by [TSON-SCHEMA] §7.2's general subsumption rule that admits a
   * proper subtype: [TSON-JSON] §3.3 restricts the admissible `$type` at a choice position to "a
   * variant of it", and carves choice positions out of the rule that "governs every other typed
   * position", giving them their own membership relation instead (§8.4's own reasoning: a choice
   * has no expected supertype for a tag to be admitted *into*, only a closed variant list a name
   * either names or does not). `unit_circle` composes `circle` and so resolves to a real,
   * declared entry -- `TYPE_MISMATCH`, not `UNKNOWN_TYPE_REF` -- but it is not itself a variant of
   * `shape`, so a tag naming it is refused exactly like any other non-variant name. This port's
   * text-encoding choice reader (`compiler/choiceReader.ts`) reads the same way; `dispatchChoice.ts`'s
   * own top note has the fuller rationale. The reference's own `DispatchChoiceReader` reads this
   * differently (its own Javadoc: "a variant, an alias of one or a subtype of one by its tag"),
   * which this port does not follow here -- reported as a Part 3/reference divergence.
   */
  it('§5.4: a choice discriminates by variant name alone, so a proper subtype of a variant is not the variant', () => {
    const problem = refusal('shape', '{"$type": "unit_circle", "radius": 1.0, "fixed": true}');
    expect(problem.code).toBe('TYPE_MISMATCH');
    expect(problem.path).toBe('/$type');
  });

  it('the wrapper form discriminates the same way: a subtype named at $type is still refused', () => {
    const problem = refusal(
      'shape',
      '{"$type": "unit_circle", "$value": {"radius": 1.0, "fixed": true}}',
    );
    expect(problem.code).toBe('TYPE_MISMATCH');
    expect(problem.path).toBe('/$type');
  });

  it('a tag naming something that is no variant is refused', () => {
    const problem = refusal('shape', '{"$type": "holder", "pick": 1}');
    expect(problem.code).toBe('TYPE_MISMATCH');
    expect(problem.expected).toContain('circle');
  });

  it('§8.5 admits $schema at a scoped position; a choice is the closed sum, so it is refused here', () => {
    expect(
      refusal(
        'shape',
        '{"$schema": "https://example.test/other.tn", "$type": "circle", "radius": 1.0}',
      ).code,
    ).toBe('UNKNOWN_TYPE_REF');
  });
});

// ── §8.3 class stability ────────────────────────────────────────────────────────────────────

describe('§8.3 class stability', () => {
  it('§8.3’s first leak: a float64 admitting .nan and the infinities has string-class values and is not class-stable', () => {
    const problem = refusal('loose', '1.5');
    expect(problem.code).toBe('TYPE_MISMATCH');
    expect(problem.message).toContain('$type');
  });

  it('narrowing both facets to false confines the family to JSON numbers and restores stability', () => {
    expect(accepted('tight', '1.5')).toBe('1.5');
    expect(accepted('tight', '"hi"')).toBe('"hi"');
  });

  it('a tag still reads at an unstable choice: stability gates the untagged route, never the tagged form', () => {
    expect(accepted('loose', '{"$type": "float64", "$value": 1.5}')).toBe('1.5');
  });
});
