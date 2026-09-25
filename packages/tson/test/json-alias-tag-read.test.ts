/**
 * A port of the Java reference's `JsonAliasTagReadTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/JsonAliasTagReadTest.java`) -- a `$type` spelling an
 * **alias**. [TSON-SCHEMA] §7.2 compares "after reference flattening of both", so an alias and its
 * target are one type at either end -- and §9.4 makes that one rule across the encodings rather
 * than two that happen to agree, so what `!s_of` does in TSON text `"$type": "s_of"` does here.
 *
 * Every position that matches a written name against a set is covered: a plain record, an abstract
 * base, and a sealed base's deeper tag all follow [TSON-SCHEMA] §7.2's general subsumption rule,
 * which flattens both chains before comparing -- the alias is admitted rather than rewritten to
 * its target, so the reader that runs is the one named for the entry the author wrote. A choice's
 * variants are the deliberate exception: §5.4 gives choice positions their own membership relation
 * rather than §7.2's, so an alias of a variant is not itself admitted there (see this file's own
 * choice-position cases, below).
 */
import { expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { compileJsonSchema, type JsonCompiledSchema } from '../src/json/schema/compile.js';
import { validateJson } from '../src/json/facade.js';
import { jsonValueToText } from '../src/json/write.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const SCHEMA_SOURCE = `
!!id:"https://example.test/alias-tag.tn"
!!meta:"https://tson.io/2026/36/m/meta.tn"
!!import:"https://tson.io/2026/36/m/core.tn"
{
  base   => { tag: text }
  sub    => base & { extra: text }
  s_of   => sub
  b_of   => base

  shape  => abstract { area: int32 }
  square => shape & { side: int32 }
  sq_of  => square

  pet    => abstract { pet_type: text =? }
  dog    => pet & { pet_type?: = "dog"  bark: text }
  dog_of => dog

  note   => { body: text }
  count  => { n: int32 }
  n_of   => note
  either => ( note | count )
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

it('an alias of a subtype selects it', () => {
  expect(accepted('base', '{"$type":"s_of","tag":"x","extra":"y"}')).toBe(
    '{"tag":"x","extra":"y"}',
  );
});

it('the alias reaches the subtype’s own reader, so the subtype’s field set is what is checked', () => {
  const problem = refusal('base', '{"$type":"s_of","tag":"x"}');
  expect(problem.code).toBe('FIELD_REQUIRED');
  expect(problem.message).toContain('extra');
});

it('§8.1’s redundant tag, spelled as an alias of the position’s own type', () => {
  accepted('base', '{"$type":"b_of","tag":"x"}');
});

it('an abstract base requires a tag, and an alias of a subtype is one', () => {
  accepted('shape', '{"$type":"sq_of","area":4,"side":2}');
});

it('a sealed position places the value by its discriminator, then checks any tag against the member it selected -- an alias of that member agrees', () => {
  accepted('pet', '{"$type":"dog_of","pet_type":"dog","bark":"woof"}');
});

/**
 * A choice position discriminates by variant type name alone ([TSON-SCHEMA] §5.4's "Resolution"
 * paragraph), not by [TSON-SCHEMA] §7.2's general subsumption rule: [TSON-JSON] §3.3 says a
 * choice's admissible `$type` set is "a variant of it", and its own §1.5 companion text carves
 * choice positions out of the rule that governs "every other typed position", giving them their
 * own membership relation instead. §7.2's reference-chain flattening is what the *general* rule
 * follows both chains through; a choice's own relation never invokes it, so an alias of a variant
 * is a name this choice does not itself declare, same as any other non-variant name. This port's
 * text-encoding choice reader (`compiler/choiceReader.ts`) reads the same way -- an exact match
 * against the declared variant list, checked once at compile time -- so this is not a JSON-only
 * reading, and `dispatchChoice.ts`'s own top note has the fuller rationale.
 */
it('§5.4: a choice discriminates by variant name alone, so an alias of a variant is not the variant', () => {
  expect(refusal('either', '{"$type":"n_of","body":"x"}').code).toBe('TYPE_MISMATCH');
});

it('flattening decides what a name means, not whether it is admitted: an unrelated alias is still refused', () => {
  expect(refusal('base', '{"$type":"n_of","body":"x"}').code).toBe('TYPE_MISMATCH');
});
