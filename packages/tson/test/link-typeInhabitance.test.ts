import { describe, expect, it } from 'vitest';

import { checkEveryEntryIsInhabited } from '../src/link/typeInhabitance.js';
import { collector } from '../src/core/diagnostic.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { RecordField } from '../src/schema/meta/bodies.js';
import type { Top, TypeDefinition, TypeRef } from '../src/schema/meta/typedef.js';

function ref(name: string): TypeRef {
  return { name, arguments: [], annotations: [] };
}

function field(
  name: string,
  type: TypeRef,
  marks: { optional?: boolean; voidable?: boolean; role?: RecordField['role'] } = {},
): RecordField {
  return {
    name,
    type,
    optional: marks.optional ?? false,
    voidable: marks.voidable ?? false,
    role: marks.role ?? 'FREE',
    annotations: [],
  };
}

function def(body: Top): TypeDefinition {
  return {
    supertypes: [],
    subtypes: [],
    body,
    annotations: [],
  };
}

const text: TypeDefinition = def({ kind: 'text_type' });

function names(namespace: ReadonlyMap<string, TypeDefinition>): ReadonlySet<string> {
  return new Set(namespace.keys());
}

function check(
  namespace: ReadonlyMap<string, TypeDefinition>,
  localNames = names(namespace),
): void {
  checkEveryEntryIsInhabited(namespace, localNames, { schemaId: 'https://x/s.tn' });
}

describe('checkEveryEntryIsInhabited: uninhabited entries are rejected (§5.10.1)', () => {
  it('rejects a direct self-reference through a required field', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'loop',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('self', ref('loop'))],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).toThrow(TsonSchemaValidationError);
    expect(() => {
      check(merged);
    }).toThrow(/'loop' can never be satisfied by any document/u);
    expect(() => {
      check(merged);
    }).toThrow(/§5\.10\.1/u);
  });

  it('rejects mutual recursion with no base case (x needs y needs x)', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'x',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('y', ref('y'))],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
      [
        'y',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('x', ref('x'))],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
    ]);
    const diagnostics = collector();
    checkEveryEntryIsInhabited(merged, names(merged), {
      schemaId: 'https://x/s.tn',
      receiver: diagnostics,
    });
    expect(diagnostics.diagnostics).toHaveLength(2);
    expect(diagnostics.diagnostics.every((d) => d.code === 'SCHEMA_ERROR')).toBe(true);
    expect(diagnostics.diagnostics[0]?.message).toMatch(/needs/u);
  });

  it('rejects a required array element with a non-empty minimum recursing with no base case', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'tree',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('children', ref('forest'))],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
      [
        'forest',
        def({
          kind: 'array',
          elementType: ref('tree'),
          state: 'REQUIRED',
          unordered: false,
          uniqueItems: false,
          minItems: 1n,
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).toThrow(/'tree' can never be satisfied/u);
  });

  it('rejects a required map with a non-empty minimum recursing through its value type', () => {
    const merged = new Map<string, TypeDefinition>([
      ['text', text],
      [
        'tree',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('children', ref('forest'))],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
      [
        'forest',
        def({
          kind: 'map',
          keyType: ref('text'),
          valueType: ref('tree'),
          state: 'REQUIRED',
          minItems: 1n,
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).toThrow(/'tree' can never be satisfied/u);
  });

  it('rejects a required tuple position that recurses with no base case', () => {
    const merged = new Map<string, TypeDefinition>([
      ['loop', def({ kind: 'tuple', elements: [{ elementType: ref('loop'), state: 'REQUIRED' }] })],
    ]);
    expect(() => {
      check(merged);
    }).toThrow(/'loop' can never be satisfied/u);
  });

  it('rejects a required, non-voidable void-typed field on its own -- the record has no member at all (§5.10.1, §5.2)', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'sealed_off',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('name', ref('text')), field('never', ref('void'))],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
      ['text', text],
    ]);
    expect(() => {
      check(merged);
    }).toThrow(/'sealed_off' can never be satisfied/u);
  });

  it('rejects a record field group that is REQUIRED with no satisfiable member', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'loop',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('a', ref('loop')), field('b', ref('loop'))],
          groups: [{ members: ['a', 'b'], state: 'REQUIRED' }],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).toThrow(/'loop' can never be satisfied/u);
  });

  it('rejects an entry whose own reference body points at an uninhabited target', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'loop',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('self', ref('loop'))],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
      ['alias', def({ kind: 'reference', target: ref('loop') })],
    ]);
    const diagnostics = collector();
    checkEveryEntryIsInhabited(merged, names(merged), {
      schemaId: 'https://x/s.tn',
      receiver: diagnostics,
    });
    expect(diagnostics.diagnostics).toHaveLength(2);
    expect(
      diagnostics.diagnostics.some((d) => d.message.includes("'alias' can never be satisfied")),
    ).toBe(true);
  });

  it('does not report a non-local (imported) uninhabited entry', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'loop',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('self', ref('loop'))],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
    ]);
    // `loop` is in the merged namespace (e.g. imported) but not one of this schema's own local
    // declarations, so it was already judged when its own schema linked.
    expect(() => {
      check(merged, new Set());
    }).not.toThrow();
  });
});

describe('checkEveryEntryIsInhabited: the recursive shapes that stay legal', () => {
  it('accepts a self-reference behind an optional field', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'loop',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('self', ref('loop'), { optional: true })],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('accepts an optional void-typed field -- `a?: void` only empties the field, not the record (§5.2)', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'person',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('name', ref('text')), field('retired', ref('void'), { optional: true })],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
      ['text', text],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('accepts a self-reference behind an OPTIONAL_FIXED field', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'loop',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('self', ref('loop'), { optional: true, voidable: true })],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('accepts a self-reference inside an array that may be empty (no minItems)', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'tree',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('children', ref('forest'))],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
      [
        'forest',
        def({
          kind: 'array',
          elementType: ref('tree'),
          state: 'REQUIRED',
          unordered: false,
          uniqueItems: false,
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('accepts a self-reference inside an array explicitly declaring minItems: 0', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'tree',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('children', ref('forest'))],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
      [
        'forest',
        def({
          kind: 'array',
          elementType: ref('tree'),
          state: 'REQUIRED',
          unordered: false,
          uniqueItems: false,
          minItems: 0n,
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('accepts an array element itself OPTIONAL, regardless of minItems', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'tree',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('children', ref('forest'))],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
      [
        'forest',
        def({
          kind: 'array',
          elementType: ref('tree'),
          state: 'OPTIONAL',
          unordered: false,
          uniqueItems: false,
          minItems: 1n,
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('accepts a choice with one inhabited variant, even though another recurses with no base case', () => {
    const merged = new Map<string, TypeDefinition>([
      ['text', text],
      ['shape', def({ kind: 'choice', variants: [ref('text'), ref('node')] })],
      [
        'node',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('left', ref('shape')), field('right', ref('shape'))],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('accepts a self-reference through a tuple position marked OPTIONAL', () => {
    const merged = new Map<string, TypeDefinition>([
      ['loop', def({ kind: 'tuple', elements: [{ elementType: ref('loop'), state: 'OPTIONAL' }] })],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('accepts a self-reference behind a record field group that is OPTIONAL', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'loop',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('a', ref('loop')), field('b', ref('loop'))],
          groups: [{ members: ['a', 'b'], state: 'OPTIONAL' }],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('accepts a required field group with at least one inhabited member alongside a recursive one', () => {
    const merged = new Map<string, TypeDefinition>([
      ['text', text],
      [
        'loop',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('a', ref('loop')), field('b', ref('text'))],
          groups: [{ members: ['a', 'b'], state: 'REQUIRED' }],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('treats every atom body as inhabited, whatever its own facets say', () => {
    const merged = new Map<string, TypeDefinition>([
      ['n', def({ kind: 'integer_type', min: 300n, max: 200n })], // incoherent, but not this rule's question
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('treats a held (open template) body as inhabited unconditionally', () => {
    const held: Top = {
      parameters: ['T'],
      template: '!record { fields: [] }',
    };
    const merged = new Map<string, TypeDefinition>([['tree', def(held)]]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('treats a Data body as inhabited unconditionally', () => {
    const merged = new Map<string, TypeDefinition>([['op', def({ kind: 'operation' })]]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('a mutually-recursive pair stays legal once one side is reachable through an optional hop', () => {
    // The three bundled schemas are recursive by design (e.g. a schema's own `type_definition`
    // recurring through `record_field`/`record`/...); the guard that keeps this legal is the same
    // one exercised here at small scale: at least one edge in the cycle is optional.
    const merged = new Map<string, TypeDefinition>([
      [
        'x',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('y', ref('y'), { optional: true })],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
      [
        'y',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('x', ref('x'))],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });
});

describe('checkEveryEntryIsInhabited: "Inhabitance gains no case" for ABSTRACT records (§5.2, §5.10.1)', () => {
  it("an ABSTRACT record with no subtype in this schema's closure is not itself a productivity error -- its own (satisfiable) field set is what answers the question, not the absence of members its importers have yet to supply", () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'pet',
        {
          supertypes: [],
          subtypes: [], // no member anywhere in this closure
          annotations: [],
          body: {
            kind: 'record',
            supertypes: [],
            // A selector (§5.2's own example): unmarked, atom-typed, ordinarily satisfiable on
            // its own -- nothing here recurs, so the ordinary field walk finds this inhabited
            // with no need for a subtype to exist at all.
            fields: [field('pet_type', ref('text')), field('name', ref('text'))],
            groups: [],
            extension: 'ABSTRACT',
            discriminators: ['pet_type'],
          },
        },
      ],
      ['text', text],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('an ABSTRACT record whose own field set cannot be satisfied is uninhabited exactly as an OPEN record with the same fields would be -- gains no exemption from having no subtype either', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'lib',
        {
          supertypes: [],
          subtypes: [],
          annotations: [],
          body: {
            kind: 'record',
            supertypes: [],
            // A required, non-voidable self-reference: the ordinary loop this file's own top
            // describes (`x => { y: y }`), unaffected by `extension`.
            fields: [field('inner', ref('lib'))],
            groups: [],
            extension: 'ABSTRACT',
            discriminators: [],
          },
        },
      ],
    ]);
    expect(() => {
      check(merged);
    }).toThrow(TsonSchemaValidationError);
  });

  it('an ABSTRACT record with an unmarked `void`-typed field is uninhabited (§5.2: `a: void` empties the record, §5.10.1)', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'lib',
        {
          supertypes: [],
          subtypes: [],
          annotations: [],
          body: {
            kind: 'record',
            supertypes: [],
            fields: [field('a', ref('void'))],
            groups: [],
            extension: 'ABSTRACT',
            discriminators: [],
          },
        },
      ],
    ]);
    expect(() => {
      check(merged);
    }).toThrow(TsonSchemaValidationError);
  });

  it("an ABSTRACT base's own inhabitance does not depend on its subtypes at all: an uninhabited-looking base with an uninhabited subtype is judged on its own (satisfiable) fields alone, and an inhabited-looking base with only uninhabited subtypes stays inhabited", () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'pet',
        {
          supertypes: [],
          subtypes: ['dog'],
          annotations: [],
          body: {
            kind: 'record',
            supertypes: [],
            fields: [], // trivially satisfiable by itself, whatever dog does
            groups: [],
            extension: 'ABSTRACT',
            discriminators: [],
          },
        },
      ],
      [
        'dog',
        {
          supertypes: ['pet'],
          subtypes: [],
          annotations: [],
          body: {
            kind: 'record',
            supertypes: [ref('pet')],
            fields: [field('self', ref('dog'))], // dog itself never terminates
            groups: [],
            extension: 'OPEN',
            discriminators: [],
          },
        },
      ],
    ]);
    // `dog` is uninhabited and reported; `pet` is judged on its own empty field set and is not.
    expect(() => {
      check(merged);
    }).toThrow(/'dog' can never be satisfied/u);
  });
});
