import { describe, expect, it } from 'vitest';

import { checkEveryEntryIsInhabited } from '../src/link/typeInhabitance.js';
import { collector } from '../src/core/diagnostic.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { RecordField } from '../src/schema/meta/bodies.js';
import type { Top, TypeDefinition, TypeRef } from '../src/schema/meta/typedef.js';

function ref(name: string): TypeRef {
  return { name, arguments: [], annotations: [] };
}

function field(name: string, type: TypeRef, state: RecordField['state'] = 'REQUIRED'): RecordField {
  return { name, type, state, annotations: [] };
}

function def(body: Top, parameters: readonly string[] = []): TypeDefinition {
  return {
    kind: 'PRODUCT',
    parameters,
    constructor: false,
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
        def({ kind: 'record', supertypes: [], fields: [field('self', ref('loop'))], groups: [] }),
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
      ['x', def({ kind: 'record', supertypes: [], fields: [field('y', ref('y'))], groups: [] })],
      ['y', def({ kind: 'record', supertypes: [], fields: [field('x', ref('x'))], groups: [] })],
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

  it('rejects a record field group that is REQUIRED with no satisfiable member', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'loop',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('a', ref('loop')), field('b', ref('loop'))],
          groups: [{ members: ['a', 'b'], state: 'REQUIRED' }],
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
        def({ kind: 'record', supertypes: [], fields: [field('self', ref('loop'))], groups: [] }),
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
        def({ kind: 'record', supertypes: [], fields: [field('self', ref('loop'))], groups: [] }),
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
          fields: [field('self', ref('loop'), 'OPTIONAL')],
          groups: [],
        }),
      ],
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
          fields: [field('self', ref('loop'), 'OPTIONAL_FIXED')],
          groups: [],
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
      names: () => new Set<string>(),
      applications: () => [],
    };
    const merged = new Map<string, TypeDefinition>([['tree', def(held, ['T'])]]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('treats a Data body as inhabited unconditionally', () => {
    const merged = new Map<string, TypeDefinition>([
      ['op', { ...def({ kind: 'operation' }), kind: 'DATA' }],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('a mutually-recursive pair stays legal once one side is reachable through an optional hop', () => {
    // The three bundled schemas are recursive by design (e.g. a schema's own `type_definition`
    // recurring through `field_state`/`record`/...); the guard that keeps this legal is the same
    // one exercised here at small scale: at least one edge in the cycle is optional.
    const merged = new Map<string, TypeDefinition>([
      [
        'x',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('y', ref('y'), 'OPTIONAL')],
          groups: [],
        }),
      ],
      ['y', def({ kind: 'record', supertypes: [], fields: [field('x', ref('x'))], groups: [] })],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });
});
