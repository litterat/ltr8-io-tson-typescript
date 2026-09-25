import { describe, expect, it } from 'vitest';
import type { SchemaLocation } from '../src/core/diagnostic.js';
import type { ChoiceBody } from '../src/schema/meta/bodies.js';
import type { TypeDefinition } from '../src/schema/meta/typedef.js';
import { choiceTreeReader } from '../src/compiler/choiceReader.js';
import { compile, validate } from '../src/compiler/compile.js';
import { atomTreeReader, atomTypeReader } from '../src/reader/tree/atom.js';
import type { TypeReader } from '../src/reader/contracts.js';
import type { Value } from '../src/tree/nodes.js';
import {
  bodyContextOver,
  collectingContextOver,
  requireValue,
  stubIntType,
  stubTextType,
} from './reader-tree-helpers.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';
import { runSync } from '../src/io/bytes.js';

/** No entries -- every call below that exercises only the tagged path passes a `false`/empty pair, since none of it turns on a real namespace. */
const NO_NAMESPACE: ReadonlyMap<string, TypeDefinition> = new Map();

/**
 * `compiler/choiceReader.ts` -- the `!type-ref` dispatch `reader/tree/grammar.ts`'s own top note
 * reserves for Wave 5's compiler. Mirrors `reader/bind.ts`'s `readVariant` algorithm; exercised
 * the same way that module's own tests are (see `reader-tree-*.test.ts`'s convention).
 */

const LOCATION: SchemaLocation = { schemaId: 'test://schema.tn', pointer: '/contact_method' };

function variantReader(typeRef: string, kind: 'int' | 'text'): TypeReader<Value> {
  return kind === 'int'
    ? atomTreeReader(atomTypeReader(stubIntType(), typeRef), typeRef)
    : atomTreeReader(atomTypeReader(stubTextType(), typeRef), typeRef);
}

const BODY: ChoiceBody = {
  kind: 'choice',
  variants: [
    { name: 'phone', arguments: [], annotations: [] },
    { name: 'email', arguments: [], annotations: [] },
  ],
};

function resolveType(name: string): TypeReader<Value> {
  return name === 'phone' ? variantReader('phone', 'int') : variantReader('email', 'text');
}

describe('choiceTreeReader -- SUM-kind !type-ref dispatch (§3.2, §5.4)', () => {
  it('dispatches to the variant its own leading !type-ref names, leaving the whole value for the delegate to read', () => {
    const reader = choiceTreeReader(
      'contact_method',
      'contact_method',
      BODY,
      resolveType,
      LOCATION,
      false,
      NO_NAMESPACE,
    );
    const value = runSync(reader.read(bodyContextOver('!phone 5551234')));
    expect(value).toEqual({
      kind: 'atom',
      value: 5551234,
      typeRef: 'phone',
      annotations: { values: [] },
    });
  });

  it('dispatches to a different variant by its own !type-ref, annotations included', () => {
    const reader = choiceTreeReader(
      'contact_method',
      'contact_method',
      BODY,
      resolveType,
      LOCATION,
      false,
      NO_NAMESPACE,
    );
    const value = runSync(reader.read(bodyContextOver('@doc:"work" !email "ada@example.org"')));
    expect(value).toEqual({
      kind: 'atom',
      value: 'ada@example.org',
      typeRef: 'email',
      annotations: {
        values: [
          {
            name: 'doc',
            value: {
              annotations: [],
              coreValue: { kind: 'token', text: 'work', form: 'single-line' },
            },
          },
        ],
      },
    });
  });

  it('reports TYPE_MISMATCH when the value carries no !type-ref at all -- a required tag absent establishes no type (§7.2)', () => {
    const reader = choiceTreeReader(
      'contact_method',
      'contact_method',
      BODY,
      resolveType,
      LOCATION,
      false,
      NO_NAMESPACE,
    );
    const { ctx, diagnostics } = collectingContextOver('5551234');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });

  it("reports TYPE_MISMATCH when the !type-ref names a real schema entry that just isn't a member of this choice (§7.2's two-step rule: resolves, but not admitted here)", () => {
    // `fax` resolves in the schema (declared alongside the choice, an unrelated entry) but is not
    // one of `phone`/`email` -- admissibility fails, not resolution.
    const namespace: ReadonlyMap<string, TypeDefinition> = new Map([
      ['fax', { supertypes: [], subtypes: [], annotations: [], body: { kind: 'text_type' } }],
    ]);
    const reader = choiceTreeReader(
      'contact_method',
      'contact_method',
      BODY,
      resolveType,
      LOCATION,
      false,
      namespace,
    );
    const { ctx, diagnostics } = collectingContextOver('!fax 5551234');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });

  it("reports UNKNOWN_TYPE_REF when the !type-ref names nothing the governing schema declares at all (§7.2's two-step rule: does not resolve)", () => {
    const reader = choiceTreeReader(
      'contact_method',
      'contact_method',
      BODY,
      resolveType,
      LOCATION,
      false,
      NO_NAMESPACE,
    );
    const { ctx, diagnostics } = collectingContextOver('!fax 5551234');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
  });

  /**
   * §5.4/§8.3: a variant reference is a hop, not a rewrite, so an alias of a variant names the
   * variant it points to -- `dispatchChoice.ts`'s own top note has the fuller citation, and
   * `json-alias-tag-read.test.ts` pins the same reading for the JSON encoding.
   */
  it('dispatches an alias of a variant to the variant it names (§5.4, §8.3)', () => {
    const namespace: ReadonlyMap<string, TypeDefinition> = new Map([
      [
        'phone_of',
        {
          supertypes: [],
          subtypes: [],
          annotations: [],
          body: { kind: 'reference', target: { name: 'phone', arguments: [] } },
        },
      ],
    ]);
    const reader = choiceTreeReader(
      'contact_method',
      'contact_method',
      BODY,
      resolveType,
      LOCATION,
      false,
      namespace,
    );
    const value = runSync(reader.read(bodyContextOver('!phone_of 5551234')));
    expect(value).toEqual({
      kind: 'atom',
      value: 5551234,
      typeRef: 'phone',
      annotations: { values: [] },
    });
  });

  it('a proper subtype of a variant is not itself admitted -- a deliberate divergence from the reference (§7.2, §8.4)', () => {
    const namespace: ReadonlyMap<string, TypeDefinition> = new Map([
      [
        'phone_sub',
        { supertypes: ['phone'], subtypes: [], annotations: [], body: { kind: 'text_type' } },
      ],
    ]);
    const reader = choiceTreeReader(
      'contact_method',
      'contact_method',
      BODY,
      resolveType,
      LOCATION,
      false,
      namespace,
    );
    const { ctx, diagnostics } = collectingContextOver('!phone_sub 5551234');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });
});

// ── Untagged recovery at a disjoint choice (§5.4) ──────────────────────────────────────────────
//
// Run through the real pipeline (resolve/link/compile), not hand-built ChoiceBody + stub readers:
// disjointness is a namespace-wide fact (`link/disjointness.ts`'s own `computeDisjointness`), so
// only a schema that actually linked has it to thread through, and `choiceTreeReader`'s own
// untagged path is exercised end to end -- lookahead, classification, dispatch -- the same way
// `compiler-subsumption.test.ts` exercises §7.2.

const DISJOINT_SCHEMA = `
!!id:"test://choice-disjoint.tn"
!!meta:"https://tson.io/2026/35/m/meta.tn"
!!import:"https://tson.io/2026/35/m/core.tn"
{
  designator => !text ^ { pattern: "[A-Z]{3}-[0-9]{3}" }
  channel => !integer ^ { min: 1  max: 64 }
  @disjoint
  target_ref => (designator | channel)
  holder => { targets: [target_ref; 1..8] }

  code_a => !text ^ { min_length: 1 }
  code_b => !text ^ { max_length: 40 }
  ambiguous_code => (code_a | code_b)
  ambiguous_holder => { code: ambiguous_code }

  point => { x: int32  y: int32 }
  @disjoint
  shape_choice => (point | [int32] | boolean)
  shape_holder => { shape: shape_choice }
}
`;

const disjointCompiled = compile(resolveUserSchema(DISJOINT_SCHEMA));
const disjointBytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The named field of a {@link RecordNode}-shaped {@link Value}, or throws -- every assertion below reads one record field at a time rather than pinning a synthetic array/choice entry's own generated name. */
function fieldOf(value: Value, name: string): Value {
  if (value.kind !== 'record') throw new Error(`expected a record, got '${value.kind}'`);
  const field = value.fields.get(name);
  if (field === undefined) throw new Error(`record has no field '${name}'`);
  return field;
}

describe('choiceTreeReader -- untagged recovery at a disjoint choice (§5.4)', () => {
  it('recovers a text-class and a number-class member from the repro in the work package, untagged', () => {
    const result = validate(
      disjointCompiled,
      'holder',
      disjointBytes('{ targets: ["MKA-777" 42] }'),
    );
    expect(result.diagnostics).toEqual([]);
    const targets = fieldOf(requireValue(result), 'targets');
    if (targets.kind !== 'array') throw new Error(`expected an array, got '${targets.kind}'`);
    expect(targets.elements).toEqual([
      { kind: 'atom', value: 'MKA-777', typeRef: 'designator', annotations: { values: [] } },
      { kind: 'atom', value: 42n, typeRef: 'channel', annotations: { values: [] } },
    ]);
  });

  it('still validates the same values tagged (§5.4: "a tag is never wrong")', () => {
    const result = validate(
      disjointCompiled,
      'holder',
      disjointBytes('{ targets: [!designator "MKA-777" !channel 42] }'),
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('keeps demanding the tag at a non-disjoint choice, unchanged from the tagged-only path', () => {
    const result = validate(
      disjointCompiled,
      'ambiguous_holder',
      disjointBytes('{ code: "hello" }'),
    );
    expect(result.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
    expect(result.diagnostics[0]?.message).toContain(
      "a 'ambiguous_code' value needs its own !type-ref",
    );
  });

  it('reports TYPE_MISMATCH when an untagged value at a disjoint choice matches no variant’s class', () => {
    // `target_ref` admits `number`/`string`; an untagged boolean matches neither.
    const result = validate(disjointCompiled, 'holder', disjointBytes('{ targets: [true] }'));
    expect(result.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
    expect(result.diagnostics[0]?.message).toContain('matches none of them');
  });

  it('dispatches an untagged brace value to a record variant', () => {
    const result = validate(
      disjointCompiled,
      'shape_holder',
      disjointBytes('{ shape: { x: 1  y: 2 } }'),
    );
    expect(result.diagnostics).toEqual([]);
    expect(fieldOf(requireValue(result), 'shape')).toEqual({
      kind: 'record',
      typeRef: 'point',
      fields: new Map([
        ['x', { kind: 'atom', value: 1, typeRef: 'int32', annotations: { values: [] } }],
        ['y', { kind: 'atom', value: 2, typeRef: 'int32', annotations: { values: [] } }],
      ]),
      annotations: { values: [] },
    });
  });

  it('dispatches an untagged bracket value to an array variant', () => {
    const result = validate(disjointCompiled, 'shape_holder', disjointBytes('{ shape: [1 2 3] }'));
    expect(result.diagnostics).toEqual([]);
    const shape = fieldOf(requireValue(result), 'shape');
    if (shape.kind !== 'array') throw new Error(`expected an array, got '${shape.kind}'`);
    expect(shape.elements).toEqual([
      { kind: 'atom', value: 1, typeRef: 'int32', annotations: { values: [] } },
      { kind: 'atom', value: 2, typeRef: 'int32', annotations: { values: [] } },
      { kind: 'atom', value: 3, typeRef: 'int32', annotations: { values: [] } },
    ]);
  });

  it('dispatches an untagged boolean value to a boolean-class variant', () => {
    const result = validate(disjointCompiled, 'shape_holder', disjointBytes('{ shape: true }'));
    expect(result.diagnostics).toEqual([]);
    expect(fieldOf(requireValue(result), 'shape')).toEqual({
      kind: 'atom',
      value: true,
      typeRef: 'boolean',
      annotations: { values: [] },
    });
  });
});

// ── §6.1.5 / §8.4: a sealed family's own name as a choice variant ──────────────────────────────

/**
 * `pet` is a choice variant of `c1` and is itself a SEALED family (§6.1.5's third
 * reading, member-dispatched by `pet_type`). Every variant of `c1` shares the record
 * shape, so no untagged route recovers it and the tag is always required (§5.4) -- and since no
 * subtype admission holds at a choice's own tag (this file's own case above), `dog`/`cat`
 * are not themselves admissible there. `pet`'s own name is the *only* admissible spelling,
 * though `pet` has no direct instances of its own (§6.1.5) -- exactly the combination
 * `compiler/choiceReader.ts`'s own `hasChoiceSelfTag` exists for.
 */
const SEALED_CHOICE_SCHEMA = `
!!id:"test://choice-sealed.tn"
!!meta:"https://tson.io/2026/36/m/meta.tn"
!!import:"https://tson.io/2026/36/m/core.tn"
{
  pet => abstract {
    pet_type: text =?
    name: text
  }
  dog => pet & { pet_type?: = "dog"  breed: text }
  cat => pet & { pet_type?: = "cat"  indoor: boolean }

  robot => { serial: text }

  c1 => ( pet | robot )
}
`;

const sealedChoiceCompiled = compile(resolveUserSchema(SEALED_CHOICE_SCHEMA));

describe("choiceTreeReader -- a sealed family's own name as a choice variant (§6.1.5, §8.4)", () => {
  it('the sealed base’s own name, tagged, dispatches on the discriminator it carries', () => {
    const result = validate(
      sealedChoiceCompiled,
      'c1',
      disjointBytes('!pet { pet_type: dog  name: Rex  breed: corgi }'),
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('the other member selects just as well, from the same tag', () => {
    const result = validate(
      sealedChoiceCompiled,
      'c1',
      disjointBytes('!pet { pet_type: cat  name: Tom  indoor: true }'),
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('a discriminator this document contradicts is still refused, exactly as the untagged route would refuse it', () => {
    const result = validate(
      sealedChoiceCompiled,
      'c1',
      disjointBytes('!pet { pet_type: bird  name: Kiwi }'),
    );
    expect(result.diagnostics.map((d) => d.code)).toEqual(['VALIDATION_ERROR']);
  });

  it('a subtype’s own name is still not admissible at the choice’s tag -- this fix only reaches the variant’s own name', () => {
    const result = validate(
      sealedChoiceCompiled,
      'c1',
      disjointBytes('!dog { pet_type: dog  name: Rex  breed: corgi }'),
    );
    expect(result.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });

  it('the same sealed base at an ordinary (non-choice) position still refuses its own name -- this fix is choice-routed only', () => {
    const result = validate(
      sealedChoiceCompiled,
      'pet',
      disjointBytes('!pet { pet_type: dog  name: Rex  breed: corgi }'),
    );
    expect(result.diagnostics.map((d) => d.code)).toEqual(['VALIDATION_ERROR']);
  });
});

// ── §5.4/§8.3: a variant that is itself an alias ────────────────────────────────────────────────

/**
 * `either2`'s own declared variant is `n_of`, itself an alias of `note` -- not a terminal.
 * Flattening a written variant name to *its own* terminal first, then admitting every name that
 * ends there (`compiler/choiceReader.ts`'s own top note), is what lets a tag name `note` (the
 * variant's target) or `n2` (a sibling alias of the same target): both share `n_of`'s own
 * terminal. Flattening one way only (to the *written* variant's own aliases, never past it to its
 * target) would miss both -- `json-alias-tag-read.test.ts`'s own case is the JSON-side twin.
 */
const ALIAS_VARIANT_SCHEMA = `
!!id:"test://choice-alias-variant.tn"
!!meta:"https://tson.io/2026/36/m/meta.tn"
!!import:"https://tson.io/2026/36/m/core.tn"
{
  note    => { body: text }
  n_of    => note
  n2      => note
  count   => { n: int32 }
  either2 => ( n_of | count )
}
`;

const aliasVariantCompiled = compile(resolveUserSchema(ALIAS_VARIANT_SCHEMA));

describe('choiceTreeReader -- a variant that is itself an alias (§5.4, §8.3)', () => {
  it('admits the alias variant’s own target', () => {
    const result = validate(aliasVariantCompiled, 'either2', disjointBytes('!note { body: "x" }'));
    expect(result.diagnostics).toEqual([]);
  });

  it('admits a sibling alias of that same target', () => {
    const result = validate(aliasVariantCompiled, 'either2', disjointBytes('!n2 { body: "x" }'));
    expect(result.diagnostics).toEqual([]);
  });

  it('the variant’s own written spelling still works too', () => {
    const result = validate(aliasVariantCompiled, 'either2', disjointBytes('!n_of { body: "x" }'));
    expect(result.diagnostics).toEqual([]);
  });
});
