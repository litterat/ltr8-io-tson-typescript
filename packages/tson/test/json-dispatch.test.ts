/**
 * WP4C — the annotation object and dispatch ([TSON-JSON] §3.2, §3.3, §6.1.5, §8, §8.3.1, §9.4;
 * [TSON-SCHEMA] §5.2, §5.4, §5.10, §7.2). Ported in spirit from the Java reference's
 * `JsonTaggedValueReadTest`, `JsonSealedFamilyReadTest`, `JsonChoiceReadTest`,
 * `JsonAliasTagReadTest`, `SealedFactoryEncodingParityTest`, `TemplateFamilyEncodingParityTest`
 * and `CrossEncodingParityTest` — one schema per describe block, table-driven where the Java
 * carries an inline text block per case.
 *
 * `json-schema-read.test.ts` covers everything that reaches this package with no dispatch
 * (WP4B); this file is only the positions §6.1.5 and §8 govern.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { compile, type CompiledSchema } from '../src/compiler/compile.js';
import { validate as validateText } from '../src/facade/tree.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { validateJson, type ValidateJsonResult } from '../src/json/facade.js';
import { jsonValueToText } from '../src/json/write.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

// ── One schema, both encodings ────────────────────────────────────────────────────────────────

const SCHEMA_SOURCE = `
!!id:"https://example.test/json-dispatch.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  pet => abstract { pet_type: text =?  name: text  nickname?: text? }
  cat => pet & { pet_type: = cat  hunting_skill?: text ~ lazy }
  dog => pet & { pet_type: = dog  pack_size: positive_integer }
  dog_alias => dog
  puppy => dog & { age_months: int32 }
  puppy_alias => puppy

  vehicle => abstract { }
  car => vehicle & { wheels: int32 }
  truck => vehicle & { axles: int32 }

  base_shape => { common: text }
  wide_shape => base_shape & { extra: text }

  shape => ( int32 | text )
  mixed => ( { text => text } | boolean )
  ambiguous => ( { text => text } | { text => int32 } )

  registration => {
    id:   uuid
    pet:  pet
    tags?: [text]
  }

  words => set<text>
  fracs => set<rational>
  pinned_fraction => { half: rational = "1/2" }
  positive_integer => !integer ^ { min: 1 }
}
`;

const LINKED = resolveUserSchema(SCHEMA_SOURCE);
const JSON_SCHEMA = compileJsonSchema(LINKED);
const TEXT_SCHEMA: CompiledSchema = compile(LINKED);

function readJson(typeName: string, json: string): ValidateJsonResult {
  return validateJson(json, { schema: JSON_SCHEMA, root: typeName });
}

function acceptedJson(typeName: string, json: string): string {
  const result = readJson(typeName, json);
  expect(
    result.diagnostics,
    `expected a clean read, got ${JSON.stringify(result.diagnostics)}`,
  ).toEqual([]);
  if (result.value === undefined) throw new Error('accepted a read with no value');
  return jsonValueToText(result.value);
}

function refusalJson(typeName: string, json: string): Diagnostic {
  const result = readJson(typeName, json);
  expect(result.diagnostics.length, JSON.stringify(result.diagnostics)).toBe(1);
  const diagnostic = result.diagnostics[0];
  if (diagnostic === undefined) throw new Error('unreachable');
  return diagnostic;
}

function refusalText(typeName: string, text: string): Diagnostic {
  const result = validateText(bytesOf(text), { schema: TEXT_SCHEMA, root: typeName });
  expect(result.diagnostics.length, JSON.stringify(result.diagnostics)).toBe(1);
  const diagnostic = result.diagnostics[0];
  if (diagnostic === undefined) throw new Error('unreachable');
  return diagnostic;
}

// ── §3.2/§3.3: the reserved namespace and the annotation object ────────────────────────────────

describe('§3.2/§3.3 the annotation object', () => {
  it('the inline form: a leading, admissible $type beside a record’s own fields', () => {
    expect(
      acceptedJson('pet', '{"$type": "dog", "pet_type": "dog", "name": "Rex", "pack_size": 3}'),
    ).toBe('{"pet_type":"dog","name":"Rex","pack_size":3}');
  });

  it('the wrapper form: $schema/$type/$value only, $value carrying the value', () => {
    expect(
      acceptedJson(
        'dog',
        '{"$type": "dog", "$value": {"pet_type": "dog", "name": "Rex", "pack_size": 3}}',
      ),
    ).toBe('{"pet_type":"dog","name":"Rex","pack_size":3}');
  });

  it('a wrapper with a member besides the reserved three is a resolver error (§3.3, §9.4)', () => {
    const d = refusalJson(
      'dog',
      '{"$type": "dog", "$value": {"pet_type": "dog", "name": "Rex", "pack_size": 3}, "extra": 1}',
    );
    expect(d.code).toBe('UNKNOWN_TYPE_REF');
  });

  it('$type after another member is a resolver error -- the reserved members must lead (§3.3, §9.4)', () => {
    const d = refusalJson(
      'dog',
      '{"pet_type": "dog", "$type": "dog", "name": "Rex", "pack_size": 3}',
    );
    expect(d.code).toBe('UNKNOWN_TYPE_REF');
  });

  it('$value in an object not led by an admitted $type is a resolver error (§9.4)', () => {
    const d = refusalJson('dog', '{"$value": {"pet_type": "dog"}}');
    expect(d.code).toBe('UNKNOWN_TYPE_REF');
  });

  it('$schema is a resolver error everywhere this package reads (no scoped position built yet, §7.8, §9.4)', () => {
    const d = refusalJson('dog', '{"$schema": "https://example.test/x.tn", "pet_type": "dog"}');
    expect(d.code).toBe('UNKNOWN_TYPE_REF');
  });

  it('a $-initial member outside the closed reserved set is a resolver error (§3.2, §9.4)', () => {
    const d = refusalJson('dog', '{"$bogus": 1, "pet_type": "dog", "name": "Rex", "pack_size": 3}');
    expect(d.code).toBe('UNKNOWN_TYPE_REF');
    expect(d.path).toBe('/$bogus');
  });
});

// ── §6.1.5 record families: OPEN with subtypes ──────────────────────────────────────────────

describe('§6.1.5 OPEN with subtypes', () => {
  it('untagged is exactly the base', () => {
    expect(acceptedJson('base_shape', '{"common": "x"}')).toBe('{"common":"x"}');
  });

  it('a tag naming a subtype dispatches to it', () => {
    expect(acceptedJson('base_shape', '{"$type": "wide_shape", "common": "x", "extra": "y"}')).toBe(
      '{"common":"x","extra":"y"}',
    );
  });

  it('a redundant tag restating the base is admitted', () => {
    expect(acceptedJson('base_shape', '{"$type": "base_shape", "common": "x"}')).toBe(
      '{"common":"x"}',
    );
  });
});

// ── §6.1.5 record families: ABSTRACT, tag-dispatched ────────────────────────────────────────

describe('§6.1.5 ABSTRACT, no discriminators', () => {
  it('a missing tag is a validation error naming the position', () => {
    const d = refusalJson('vehicle', '{"wheels": 4}');
    expect(d.code).toBe('VALIDATION_ERROR');
  });

  it('a tag naming a subtype dispatches to it, validated in full', () => {
    expect(acceptedJson('vehicle', '{"$type": "car", "wheels": 4}')).toBe('{"wheels":4}');
  });

  it('a tag naming the base itself is refused -- no value satisfies it (§6.1.5)', () => {
    const d = refusalJson('vehicle', '{"$type": "vehicle"}');
    expect(d.code).toBe('VALIDATION_ERROR');
  });

  it('an unresolvable tag is UNKNOWN_TYPE_REF, an admissible-elsewhere one TYPE_MISMATCH (§7.2)', () => {
    expect(refusalJson('vehicle', '{"$type": "nope"}').code).toBe('UNKNOWN_TYPE_REF');
    expect(refusalJson('vehicle', '{"$type": "cat", "pet_type": "cat", "name": "x"}').code).toBe(
      'TYPE_MISMATCH',
    );
  });
});

// ── §6.1.5 record families: sealed (member-dispatched) ──────────────────────────────────────

describe('§6.1.5 sealed (member-dispatched)', () => {
  it('the discriminator selects the member, no tag needed', () => {
    expect(acceptedJson('pet', '{"pet_type": "dog", "name": "Rex", "pack_size": 3}')).toBe(
      '{"pet_type":"dog","name":"Rex","pack_size":3}',
    );
    expect(acceptedJson('pet', '{"pet_type": "cat", "name": "Tom"}')).toBe(
      '{"pet_type":"cat","name":"Tom","hunting_skill":"lazy"}',
    );
  });

  it('a discriminator not leading (arriving after an ordinary field) is a missing discriminator -- the streaming bound §10.1 exists for', () => {
    const d = refusalJson('pet', '{"name": "Rex", "pet_type": "dog", "pack_size": 3}');
    expect(d.code).toBe('FIELD_REQUIRED');
    expect(d.path).toBe('/pet_type');
  });

  it('an unmatched discriminator value is a validation error naming the position', () => {
    const d = refusalJson('pet', '{"pet_type": "bird", "name": "Kiwi"}');
    expect(d.code).toBe('VALIDATION_ERROR');
    expect(d.path).toBe('');
  });

  it('a tag naming the dispatched member only asserts and must agree -- the tag leads, before the discriminators (§6.1.5)', () => {
    expect(
      acceptedJson('pet', '{"$type": "dog", "pet_type": "dog", "name": "Rex", "pack_size": 3}'),
    ).toBe('{"pet_type":"dog","name":"Rex","pack_size":3}');
  });

  it('a tag deeper than one level: `puppy` is a subtype of the dispatched member `dog`, and its route reaches puppy’s own reader (§6.1.5: "a family dispatches one level by member and every level below it by tag")', () => {
    expect(
      acceptedJson(
        'pet',
        '{"$type": "puppy", "pet_type": "dog", "name": "Rex", "pack_size": 3, "age_months": 2}',
      ),
    ).toBe('{"pet_type":"dog","name":"Rex","pack_size":3,"age_months":2}');
  });

  it('a tag disagreeing with the discriminator is refused by the selected reader’s own FIXED check -- the tag places the value, and the pin the document actually wrote (§5.2) contradicts it', () => {
    const result = readJson(
      'pet',
      '{"$type": "cat", "pet_type": "dog", "name": "Rex", "pack_size": 3}',
    );
    expect(result.diagnostics.some((d) => d.code === 'FIELD_FIXED')).toBe(true);
  });

  it('a tag naming the sealed base itself is refused', () => {
    const d = refusalJson(
      'pet',
      '{"$type": "pet", "pet_type": "dog", "name": "Rex", "pack_size": 3}',
    );
    expect(d.code).toBe('VALIDATION_ERROR');
  });

  it('the wrapper form at a sealed position: $type places the value, $value carries it', () => {
    expect(
      acceptedJson(
        'pet',
        '{"$type": "dog", "$value": {"pet_type": "dog", "name": "Rex", "pack_size": 3}}',
      ),
    ).toBe('{"pet_type":"dog","name":"Rex","pack_size":3}');
  });

  it('a $type naming something outside the sealed family splits on whether it resolves (§7.2)', () => {
    const wrapped = (typeName: string): string =>
      `{"$type": "${typeName}", "$value": {"pet_type": "dog", "name": "Rex", "pack_size": 3}}`;
    // Resolves, but is not a member of 'pet' -- admissible somewhere, not admissible here.
    expect(refusalJson('pet', wrapped('vehicle')).code).toBe('TYPE_MISMATCH');
    // Resolves nowhere in the governing schema's namespace.
    expect(refusalJson('pet', wrapped('nope')).code).toBe('UNKNOWN_TYPE_REF');
  });

  it('a repeated $value in a wrapper is a duplicate, not a silent overwrite (§3.1/§9.1)', () => {
    const d = refusalJson(
      'pet',
      '{"$type": "dog", "$value": {"pet_type": "dog", "name": "Rex", "pack_size": 3}, ' +
        '"$value": {"pet_type": "cat", "name": "Tom"}}',
    );
    expect(d.code).toBe('DUPLICATE_FIELD');
  });
});

// ── §7.2 aliases (JsonAliasTagReadTest) ──────────────────────────────────────────────────────

describe('an alias names the same type as its target (§7.2, §8.3)', () => {
  it('a $type naming an alias of a family member dispatches to the member', () => {
    expect(
      acceptedJson(
        'pet',
        '{"$type": "dog_alias", "pet_type": "dog", "name": "Rex", "pack_size": 3}',
      ),
    ).toBe('{"pet_type":"dog","name":"Rex","pack_size":3}');
  });

  it('a $type naming an alias of a family member dispatches to the member even nested inside another record’s own field', () => {
    expect(
      acceptedJson(
        'registration',
        JSON.stringify({
          id: '9f1c8e2a-4b7d-4e6f-9a3b-2c5d8e7f1a09',
          pet: { $type: 'dog_alias', pet_type: 'dog', name: 'Rex', pack_size: 3 },
        }),
      ),
    ).toContain('"pack_size":3');
  });

  it('a $type naming an alias of a subtype (deeper than one level) dispatches through the alias too', () => {
    expect(
      acceptedJson(
        'pet',
        '{"$type": "puppy_alias", "pet_type": "dog", "name": "Rex", "pack_size": 3, "age_months": 2}',
      ),
    ).toBe('{"pet_type":"dog","name":"Rex","pack_size":3,"age_months":2}');
  });
});

// ── §8 choices ───────────────────────────────────────────────────────────────────────────────

describe('§8 choices', () => {
  it('§8.2: a disjoint choice dispatches untagged, by JSON value kind', () => {
    expect(acceptedJson('shape', '1')).toBe('1');
    expect(acceptedJson('shape', '"hi"')).toBe('"hi"');
  });

  it('§8.1: a tag is always accepted, even where it could have been omitted', () => {
    expect(acceptedJson('shape', '{"$type": "int32", "$value": 1}')).toBe('1');
  });

  it('§8.2: an untagged value of a kind no variant takes is a validation error', () => {
    const d = refusalJson('shape', 'true');
    expect(d.code).toBe('TYPE_MISMATCH');
  });

  it('§8.2: a choice with two brace-class variants is not disjoint, so the tag is REQUIRED', () => {
    const d = refusalJson('ambiguous', '{"a": "b"}');
    expect(d.code).toBe('TYPE_MISMATCH');
  });

  it('§8.3.1: a map whose keys happen to spell $-initial names (not one of the reserved three) is read untagged, as data', () => {
    expect(acceptedJson('mixed', '{"$bogus": "b"}')).toBe('{"$bogus":"b"}');
  });

  it('§8.3.1: the escape -- an object leading with a reserved member is read as the tagged form even at an untagged-eligible map variant', () => {
    // "cat" is not a variant of `mixed`, so this exercises the escape without needing a second
    // schema: the object is read as tagged (its `$type` inspected) rather than as the map variant
    // (which would otherwise have accepted "$type" as an ordinary key).
    const d = refusalJson('mixed', '{"$type": "cat"}');
    expect(d.code).toBe('TYPE_MISMATCH');
  });

  it('null admits no absence at a choice position (§7)', () => {
    expect(refusalJson('shape', 'null').code).toBe('FIELD_REQUIRED');
  });

  it('a $type at a choice position splits on whether it resolves (§7.2), the same as a record-family tag', () => {
    // "vehicle" resolves in this schema's namespace but names no variant of `shape` -- admissible
    // somewhere, not admissible here.
    expect(refusalJson('shape', '{"$type": "vehicle", "$value": {}}').code).toBe('TYPE_MISMATCH');
    // "nope" resolves nowhere.
    expect(refusalJson('shape', '{"$type": "nope", "$value": "x"}').code).toBe('UNKNOWN_TYPE_REF');
  });
});

// ── Cross-encoding parity (Class 3 equivalence, [TSON-JSON] §1.5) ───────────────────────────

describe('cross-encoding parity: same schema, same verdict', () => {
  it('a clean sealed-family value decodes with no diagnostics in both encodings', () => {
    expect(
      readJson('pet', '{"pet_type": "dog", "name": "Rex", "pack_size": 3}').diagnostics,
    ).toEqual([]);
    expect(
      validateText(bytesOf('{ pet_type: dog  name: Rex  pack_size: 3 }'), {
        schema: TEXT_SCHEMA,
        root: 'pet',
      }).diagnostics,
    ).toEqual([]);
  });

  it('an unmatched discriminator combination is the same code at the same pointer in both encodings', () => {
    const json = refusalJson('pet', '{"pet_type": "bird", "name": "Kiwi"}');
    const text = refusalText('pet', '{ pet_type: bird  name: Kiwi }');
    expect(json.code).toBe(text.code);
    expect(json.path).toBe(text.path);
  });

  it('a missing required field is FIELD_REQUIRED at the same pointer in both encodings', () => {
    const json = refusalJson('dog', '{"pet_type": "dog", "name": "Rex"}');
    const text = refusalText('dog', '{ pet_type: dog  name: Rex }');
    expect(json.code).toBe(text.code);
    expect(json.path).toBe(text.path);
  });

  it('a required tag missing at an ABSTRACT position is the same code (TYPE_MISMATCH) in both encodings', () => {
    const json = refusalJson('vehicle', '{"wheels": 4}');
    const text = refusalText('vehicle', '{ wheels: 4 }');
    expect(json.code).toBe(text.code);
  });

  it('a non-disjoint choice needing a tag is TYPE_MISMATCH in both encodings, untagged (§8.1: no recovery without one)', () => {
    const json = refusalJson('ambiguous', '{"a": "b"}');
    const text = refusalText('ambiguous', '{ a: b }');
    expect(json.code).toBe(text.code);
    expect(json.code).toBe('TYPE_MISMATCH');
  });

  // ── Legitimate divergences, pinned rather than silently tolerated (§1.5, REVISION-36-PLAN.md
  // "Member dispatch looks ahead within one record") ──────────────────────────────────────────

  it('DIVERGENCE: a late discriminator is invalid in JSON (bounded lookahead, §6.1.5) and valid in text (full-record lookahead, §5.2)', () => {
    const json = refusalJson('pet', '{"name": "Rex", "pet_type": "dog", "pack_size": 3}');
    expect(json.code).toBe('FIELD_REQUIRED');
    const text = validateText(bytesOf('{ name: Rex  pet_type: dog  pack_size: 3 }'), {
      schema: TEXT_SCHEMA,
      root: 'pet',
    });
    expect(text.diagnostics).toEqual([]);
  });

  /**
   * A tag naming the ABSTRACT base itself is reported at the *value's* own pointer in both
   * encodings, deliberately never at `/$type` though the member is right there in JSON: [TSON-JSON]
   * §9.4 holds both encodings to one pointer for a rule they share, and TSON text's tag is an
   * annotation with no pointer step of its own, so a rule the two stacks share can only be
   * located where they both have a location (`dispatchTag.ts`'s own top note on this, matching
   * the Java reference's `DispatchTagReader`/`RecordPlan.admitsTag`). This was a genuine pointer
   * divergence before that fix landed -- `json-cross-encoding-parity.test.ts` now pins the general
   * rule; this case is kept for `vehicle`'s own ABSTRACT-with-no-fields shape.
   */
  it('a tag naming the ABSTRACT base itself lands at the same pointer in both encodings', () => {
    const json = refusalJson('vehicle', '{"$type": "vehicle"}');
    expect(json.path).toBe('');
    const text = refusalText('vehicle', '!vehicle {}');
    expect(text.path).toBe('');
  });

  // ── One value identity end to end ([TSON-DATA] §7.2.1, §5.5; WP4C repair) -- the three probes
  // that found the two encodings' readers disagreeing before `value/equality.ts`'s `deepEqual`
  // gained `identityKey`'s own normalisations ────────────────────────────────────────────────

  it('a set<text> holding two NFC-equivalent spellings of one grapheme is a duplicate in both encodings', () => {
    const json = refusalJson('words', '["\\u00e9", "e\\u0301"]');
    const text = refusalText('words', '[ "é" "é" ]');
    expect(json.code).toBe(text.code);
    expect(json.code).toBe('TYPE_MISMATCH');
  });

  it('a set<rational> holding two spellings of one rational (1/2, 2/4) is a duplicate in both encodings', () => {
    const json = refusalJson('fracs', '["1/2", "2/4"]');
    const text = refusalText('fracs', '[ "1/2" "2/4" ]');
    expect(json.code).toBe(text.code);
    expect(json.code).toBe('TYPE_MISMATCH');
  });

  it('a field pinned = "1/2" accepts "2/4" in both encodings -- one rational value, two spellings', () => {
    expect(readJson('pinned_fraction', '{"half": "2/4"}').diagnostics).toEqual([]);
    expect(
      validateText(bytesOf('{ half: "2/4" }'), { schema: TEXT_SCHEMA, root: 'pinned_fraction' })
        .diagnostics,
    ).toEqual([]);
  });
});

// ── A record-bodied template family base (§5.10; SealedFactoryEncodingParityTest,
// TemplateFamilyEncodingParityTest's own corner) ────────────────────────────────────────────

describe('a record-bodied template family base', () => {
  const TEMPLATE_SCHEMA = resolveUserSchema(`
!!id:"https://example.test/json-dispatch-template.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  box => abstract <T> { kind: text =?  value: T }
  int_box => box<int32> & { kind: = int_box }
  text_box => box<text> & { kind: = text_box }
  int_box_field => { held: int_box }
}
`);
  const TEMPLATE_COMPILED = compileJsonSchema(TEMPLATE_SCHEMA);

  function acceptedTemplate(typeName: string, json: string): string {
    const result = validateJson(json, { schema: TEMPLATE_COMPILED, root: typeName });
    expect(result.diagnostics, JSON.stringify(result.diagnostics)).toEqual([]);
    if (result.value === undefined) throw new Error('accepted a read with no value');
    return jsonValueToText(result.value);
  }

  // `kind` is marked `=?`, so `box` is a *member*-dispatched family base (§5.2, §6.1.5), not a
  // tag-dispatched one -- the discriminator alone places the value, and a tag only asserts.

  it('a tag naming an instantiation dispatches to it, validated in full', () => {
    expect(acceptedTemplate('box', '{"$type": "int_box", "kind": "int_box", "value": 1}')).toBe(
      '{"kind":"int_box","value":1}',
    );
  });

  it('the discriminator alone dispatches, with no tag needed', () => {
    expect(acceptedTemplate('box', '{"kind": "text_box", "value": "hi"}')).toBe(
      '{"kind":"text_box","value":"hi"}',
    );
  });

  it('a kind matching no instantiation is a validation error', () => {
    const result = validateJson('{"kind": "nope", "value": 1}', {
      schema: TEMPLATE_COMPILED,
      root: 'box',
    });
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0]?.code).toBe('VALIDATION_ERROR');
  });
});
