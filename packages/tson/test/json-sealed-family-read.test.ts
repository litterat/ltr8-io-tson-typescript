/**
 * A port of the Java reference's `JsonSealedFamilyReadTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/JsonSealedFamilyReadTest.java`) -- [TSON-JSON]
 * §6.1.5's three readings of an untagged object, decided by the position's own extension fact
 * ([TSON-SCHEMA] §5.2).
 *
 * The point of the design is the documents that need no tag. A sealed family's value is placed by
 * reading the members it already carries, so the JSON a plain consumer would write is the JSON
 * this reads.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { compileJsonSchema, type JsonCompiledSchema } from '../src/json/schema/compile.js';
import { validateJson } from '../src/json/facade.js';
import { jsonValueToText } from '../src/json/write.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const SCHEMA_SOURCE = `
!!id:"https://example.test/pets.tn"
!!meta:"https://tson.io/2026/36/m/meta.tn"
!!import:"https://tson.io/2026/36/m/core.tn"
{
  pet => abstract { pet_type: text =?  name: text }
  dog => pet & { pet_type?: = "dog"  breed: text }
  cat => pet & { pet_type?: = "cat"  indoor: boolean }

  shape => abstract { area: int32 }
  square => shape & { side: int32 }

  frame => abstract { opcode: int32 =?  payload: text }
  ping => frame & { opcode?: = 0xFF  seq: int32 }

  event => abstract { source: text =?  kind: text =?  at: int32 }
  login => event & { source?: = "auth"  kind?: = "login"  user: text }

  holder => { p: pet  s?: shape? }
}
`;

const COMPILED: JsonCompiledSchema = compileJsonSchema(resolveUserSchema(SCHEMA_SOURCE));

function problems(json: string, typeName: string): readonly Diagnostic[] {
  return validateJson(json, { schema: COMPILED, root: typeName }).diagnostics;
}

function message(json: string, typeName: string): string {
  const diagnostics = problems(json, typeName);
  expect(diagnostics.length > 0, 'expected a refusal, got none').toBe(true);
  return diagnostics.map((d) => d.message).reduce((a, b) => `${a}\n${b}`, '');
}

// ── SEALED: the member is the selector ────────────────────────────────────────────────────────

describe('SEALED: the member is the selector', () => {
  it('no tag anywhere, in the schema or the document: the member places the value', () => {
    expect(problems('{"pet_type": "dog", "name": "Rex", "breed": "corgi"}', 'pet')).toEqual([]);
  });

  it('and the other member of the family, to show the selection is a selection and not a default', () => {
    expect(problems('{"pet_type": "cat", "name": "Tom", "indoor": true}', 'cat')).toEqual([]);
    expect(problems('{"pet_type": "cat", "name": "Tom", "indoor": true}', 'pet')).toEqual([]);
  });

  it('§6.1.5 puts the discriminators first, so one written after another member is missing, and the refusal says where it goes', () => {
    const refusal = message('{"breed": "corgi", "name": "Rex", "pet_type": "dog"}', 'pet');
    expect(refusal).toContain("missing discriminator 'pet_type'");
    expect(refusal).toContain('lead the object');
  });

  it('two discriminators lead in either order, and the pair selects the member', () => {
    expect(
      problems('{"source": "auth", "kind": "login", "at": 1, "user": "ada"}', 'event'),
    ).toEqual([]);
    expect(
      problems('{"kind": "login", "source": "auth", "at": 1, "user": "ada"}', 'event'),
    ).toEqual([]);
  });

  it('a second discriminator after another member is missing, even though the first led', () => {
    const refusal = message('{"source": "auth", "at": 1, "kind": "login", "user": "ada"}', 'event');
    expect(refusal).toContain("missing discriminator 'kind'");
  });

  it('the discriminators lead after the tag, where the object carries one', () => {
    expect(
      problems('{"$type": "dog", "pet_type": "dog", "name": "Rex", "breed": "corgi"}', 'pet'),
    ).toEqual([]);
  });

  it('the selected member then validates the whole value, so its own fields are checked as they always were', () => {
    expect(message('{"pet_type": "dog", "name": "Rex"}', 'pet')).toContain(
      "'breed' is required and was not written",
    );
  });

  it('a member of the family the selected type does not declare is still §6.1.1’s closure error', () => {
    expect(
      message('{"pet_type": "dog", "name": "Rex", "breed": "corgi", "indoor": true}', 'pet'),
    ).toContain("'indoor' is not a declared field of this record");
  });

  it('a missing discriminator is refused and never falls back to the tag', () => {
    expect(message('{"name": "Rex", "breed": "corgi"}', 'pet')).toContain(
      "missing discriminator 'pet_type'",
    );
  });

  it('a discriminator no member pins names what arrived and the alternatives', () => {
    const refusal = message('{"pet_type": "dgo", "name": "Rex"}', 'pet');
    expect(refusal).toContain("no member of 'pet' pins");
    expect(refusal.includes('dog') && refusal.includes('cat')).toBe(true);
  });

  /**
   * The pin is matched as a value, not as a token. The schema pins `= 0xFF` and the document
   * writes `255`: §4.3 makes those one integer, and both sides are decoded by the same parser
   * before either is compared. `seq` is what makes the assertion discriminating: `frame` does not
   * declare it, so a document carrying it validates only if the read really reached `ping`.
   */
  it('a pin matches by value and not by spelling', () => {
    expect(problems('{"opcode": 255, "payload": "hi", "seq": 1}', 'frame')).toEqual([]);
  });

  it('and the contrast: a value no member pins is refused, so the match above is a match and not a pass-through', () => {
    expect(message('{"opcode": 7, "payload": "hi", "seq": 1}', 'frame')).toContain(
      "no member of 'frame' pins",
    );
  });
});

// ── SEALED: the tag can only assert ──────────────────────────────────────────────────────────

describe('SEALED: the tag can only assert', () => {
  it('a tag agreeing with the discriminator is admitted', () => {
    expect(
      problems('{"$type": "dog", "pet_type": "dog", "name": "Rex", "breed": "corgi"}', 'pet'),
    ).toEqual([]);
  });

  it('the tag places the value and the selected member’s reader holds it to the discriminator', () => {
    const refusal = message(
      '{"$type": "cat", "pet_type": "dog", "name": "Rex", "breed": "corgi"}',
      'pet',
    );
    expect(refusal).toContain("'pet_type' is fixed and this document's value contradicts it");
  });
});

// ── ABSTRACT: the tag is the only selector ────────────────────────────────────────────────────

describe('ABSTRACT: the tag is the only selector', () => {
  it('an abstract position requires the tag', () => {
    const refusal = message('{"area": 4, "side": 2}', 'shape');
    expect(refusal).toContain('is abstract and has no direct instances');
    expect(refusal).toContain('square');
  });

  it('an abstract position reads the tagged subtype', () => {
    expect(problems('{"$type": "square", "area": 4, "side": 2}', 'shape')).toEqual([]);
  });

  it('the base has no direct instances, so a tag naming it is not a redundant restatement but an error', () => {
    expect(message('{"$type": "shape", "area": 4}', 'shape')).toContain('no value satisfies it');
  });
});

// ── Nested, which is where the design earns its keep ─────────────────────────────────────────

describe('nested', () => {
  it('a sealed family reads at a field position with no tag anywhere, beside an abstract one that needs its tag', () => {
    const result = validateJson('{"p": {"pet_type": "cat", "name": "Tom", "indoor": false}}', {
      schema: COMPILED,
      root: 'holder',
    });
    expect(result.diagnostics).toEqual([]);
    if (result.value === undefined) throw new Error('accepted a read with no value');
    expect(jsonValueToText(result.value)).toContain('Tom');
  });
});
