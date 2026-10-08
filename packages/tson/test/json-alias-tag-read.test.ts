/**
 * A port of the Java reference's `JsonAliasTagReadTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/JsonAliasTagReadTest.java`) -- a `$type` spelling an
 * **alias**. [TSON-SCHEMA] §7.2 compares "after reference flattening of both", so an alias and its
 * target are one type at either end -- and §9.4 makes that one rule across the encodings rather
 * than two that happen to agree, so what `!s_of` does in TSON text `"$type": "s_of"` does here.
 *
 * Every position that matches a written name against a set is covered: a plain record, an abstract
 * base, a sealed base's deeper tag, and -- alias-flattened on the same terms, though not through
 * §7.2's own general subsumption rule -- a choice's variants (§5.4's own "Resolution" paragraph
 * already reads a variant by what it *resolves to*; see this file's own choice-position cases,
 * below, and `json/schema/dispatchChoice.ts`'s top note for the full citation). In every case the
 * alias is admitted rather than rewritten to its target, so the reader that runs is the one named
 * for the entry the author wrote.
 */
import { expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { compileJsonSchema, type JsonCompiledSchema } from '../src/json/schema/compile.js';
import { validateJson } from '../src/json/facade.js';
import { jsonValueToText } from '../src/json/write.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const SCHEMA_SOURCE = `
!!id:"https://example.test/alias-tag.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
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
  n2     => note
  either => ( note | count )
  either2 => ( n_of | count )
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
 * §5.4's own "Resolution" paragraph reads a variant by what it *resolves to* ("the resolver
 * validates that each variant resolves to a distinct type"), not by its written spelling, and §8.3
 * states the general principle a variant reference shares with every other one: "a reference is a
 * hop, not a rewrite... the same type under another name". So `n_of` (an alias of `note`, a
 * variant of `either`) names the variant it points to, the same identity question every other
 * position in this file answers the same way. This port's text-encoding choice reader
 * (`compiler/choiceReader.ts`) reads the same way -- alias-flattened, not subtype-flattened -- so
 * this is not a JSON-only reading, and `dispatchChoice.ts`'s own top note has the fuller rationale,
 * including where this diverges from the reference (subtype admission, not exercised by this
 * fixture).
 */
it('§5.4/§8.3: an alias of a variant is admitted at a choice position, matching the variant it names', () => {
  expect(accepted('either', '{"$type":"n_of","body":"x"}')).toBe('{"body":"x"}');
});

it('flattening decides what a name means, not whether it is admitted: an unrelated alias is still refused', () => {
  expect(refusal('base', '{"$type":"n_of","body":"x"}').code).toBe('TYPE_MISMATCH');
});

/**
 * `either2`'s own declared variant is `n_of`, itself an alias of `note` -- not a
 * terminal. Flattening a written variant name to *its own* terminal first, then admitting every
 * name that ends there (`dispatchChoice.ts`'s own top note), is what lets a tag name `note`
 * (the variant's target) or `n2` (a sibling alias of the same target) here: both share `n_of`'s
 * own terminal, so both are the variant `n_of` names, under the identical "a reference is a hop,
 * not a rewrite" principle this file's other cases already apply -- flattening one way only (to
 * the *written* variant's own aliases, never past it to its target) would miss both.
 */
it('a variant that is itself an alias admits its own target at the choice’s tag', () => {
  expect(accepted('either2', '{"$type":"note","body":"x"}')).toBe('{"body":"x"}');
});

it('and a sibling alias of that same target, not only the variant’s own written spelling', () => {
  expect(accepted('either2', '{"$type":"n2","body":"x"}')).toBe('{"body":"x"}');
});

it('the variant’s own written spelling still works too', () => {
  expect(accepted('either2', '{"$type":"n_of","body":"x"}')).toBe('{"body":"x"}');
});
