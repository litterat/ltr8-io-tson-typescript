import { describe, expect, it } from 'vitest';

import { validateReferences } from '../src/link/referenceValidation.js';
import { collector } from '../src/core/diagnostic.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { Top, TypeDefinition, TypeRef } from '../src/schema/meta/typedef.js';

function ref(name: string, args: TypeRef['arguments'] = []): TypeRef {
  return { name, arguments: args, annotations: [] };
}

function def(
  body: Top,
  options: {
    readonly parameters?: readonly string[];
    readonly source?: TypeRef;
    readonly supertypes?: readonly string[];
    readonly subtypes?: readonly string[];
    readonly kind?: TypeDefinition['kind'];
  } = {},
): TypeDefinition {
  return {
    kind: options.kind ?? 'PRODUCT',
    parameters: options.parameters ?? [],
    constructor: false,
    supertypes: options.supertypes ?? [],
    subtypes: options.subtypes ?? [],
    body,
    annotations: [],
    ...(options.source === undefined ? {} : { source: options.source }),
  };
}

const text = def({ kind: 'text_type' });

describe('validateReferences: unresolved references (§3.3.1, §3.3.2)', () => {
  it('throws (fail-fast) on a field type that resolves to nothing', () => {
    const merged = new Map<string, TypeDefinition>([
      ['text', text],
      [
        'widget',
        def({
          kind: 'record',
          supertypes: [],
          fields: [{ name: 'x', type: ref('nowhere'), state: 'REQUIRED', annotations: [] }],
          groups: [],
        }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(TsonSchemaValidationError);
  });

  it('accepts every field/element/key/value/variant reference that does resolve', () => {
    const merged = new Map<string, TypeDefinition>([
      ['text', text],
      [
        'widget',
        def({
          kind: 'record',
          supertypes: [],
          fields: [{ name: 'x', type: ref('text'), state: 'REQUIRED', annotations: [] }],
          groups: [],
        }),
      ],
      [
        'arr',
        def({
          kind: 'array',
          elementType: ref('text'),
          state: 'REQUIRED',
          unordered: false,
          uniqueItems: false,
        }),
      ],
      ['m', def({ kind: 'map', keyType: ref('text'), valueType: ref('text') })],
      [
        't',
        def({
          kind: 'tuple',
          elements: [{ elementType: ref('text'), state: 'REQUIRED' }],
        }),
      ],
      ['al', def({ kind: 'reference', target: ref('text') })],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).not.toThrow();
  });

  it('reports through a receiver, letting every other entry still be checked', () => {
    const merged = new Map<string, TypeDefinition>([
      ['text', text],
      ['bad_a', def({ kind: 'reference', target: ref('nowhere_a') })],
      ['bad_b', def({ kind: 'reference', target: ref('nowhere_b') })],
      ['good', def({ kind: 'reference', target: ref('text') })],
    ]);
    const diagnostics = collector();
    validateReferences(merged, { schemaId: 'https://x/s.tn', receiver: diagnostics });
    expect(diagnostics.diagnostics).toHaveLength(2);
    expect(diagnostics.diagnostics.every((d) => d.code === 'SCHEMA_ERROR')).toBe(true);
  });

  it('rejects a reference to an entry whose kind is DATA (§4.1)', () => {
    const merged = new Map<string, TypeDefinition>([
      ['op', def({ kind: 'operation' }, { kind: 'DATA' })],
      ['user', def({ kind: 'reference', target: ref('op') })],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/describes something other than a data value/u);
  });

  it('allows a reference to the enclosing declaration`s own type parameter', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'box',
        def(
          {
            kind: 'record',
            supertypes: [],
            fields: [{ name: 'v', type: ref('T'), state: 'REQUIRED', annotations: [] }],
            groups: [],
          },
          { parameters: ['T'] },
        ),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).not.toThrow();
  });
});

describe('validateReferences: arity (§5.10)', () => {
  const template = def(
    {
      kind: 'record',
      supertypes: [],
      fields: [{ name: 'v', type: ref('T'), state: 'REQUIRED', annotations: [] }],
      groups: [],
    },
    { parameters: ['T'] },
  );

  it('rejects an application supplying too many arguments', () => {
    const merged = new Map<string, TypeDefinition>([
      ['text', text],
      ['box', template],
      [
        'user',
        def({
          kind: 'reference',
          target: ref('box', [
            { kind: 'ref', ref: ref('text') },
            { kind: 'ref', ref: ref('text') },
          ]),
        }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/takes 1 type argument/u);
  });

  it('rejects a bare reference to a template with no arguments at all', () => {
    const merged = new Map<string, TypeDefinition>([
      ['box', template],
      ['user', def({ kind: 'reference', target: ref('box') })],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/not a type until it is applied/u);
  });

  it('rejects arguments applied to a name that declares no type parameters', () => {
    const merged = new Map<string, TypeDefinition>([
      ['text', text],
      [
        'user',
        def({ kind: 'reference', target: ref('text', [{ kind: 'ref', ref: ref('text') }]) }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/declares no type parameters/u);
  });

  it('rejects a type parameter itself carrying an argument list (no head abstraction, §5.10)', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'box',
        def(
          {
            kind: 'record',
            supertypes: [],
            fields: [
              {
                name: 'v',
                type: ref('T', [{ kind: 'ref', ref: ref('text') }]),
                state: 'REQUIRED',
                annotations: [],
              },
            ],
            groups: [],
          },
          { parameters: ['T'] },
        ),
      ],
      ['text', text],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/no head abstraction/u);
  });
});

describe('validateReferences: choice variants (§5.4)', () => {
  it('rejects two variants that resolve to the same type', () => {
    const merged = new Map<string, TypeDefinition>([
      ['text', text],
      ['other_text', def({ kind: 'reference', target: ref('text') })],
      [
        'c',
        def({
          kind: 'choice',
          variants: [ref('text'), ref('other_text')],
        }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/resolve to a distinct type/u);
  });

  it('rejects a variant that resolves to void', () => {
    const merged = new Map<string, TypeDefinition>([
      ['text', text],
      ['void', def({ kind: 'unit' })],
      ['c', def({ kind: 'choice', variants: [ref('text'), ref('void')] })],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/optionality is not choice/u);
  });

  it('accepts a choice whose variants are all distinct and none is void', () => {
    const merged = new Map<string, TypeDefinition>([
      ['text', text],
      ['int32', def({ kind: 'integer_type' })],
      ['c', def({ kind: 'choice', variants: [ref('text'), ref('int32')] })],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).not.toThrow();
  });
});

describe('validateReferences: parameter usage (§5.10)', () => {
  it('rejects a declared type parameter the body never references', () => {
    const merged = new Map<string, TypeDefinition>([
      ['text', text],
      [
        'box',
        def(
          {
            kind: 'record',
            supertypes: [],
            fields: [{ name: 'v', type: ref('text'), state: 'REQUIRED', annotations: [] }],
            groups: [],
          },
          { parameters: ['T'] },
        ),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/never references it/u);
  });
});

describe('validateReferences: supertypes/subtypes must themselves resolve', () => {
  it('rejects an unresolved supertype', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'widget',
        def(
          { kind: 'record', supertypes: [], fields: [], groups: [] },
          { supertypes: ['nowhere'] },
        ),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/unresolved supertype/u);
  });

  it('rejects an unresolved subtype (a broken reverse-index invariant)', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'widget',
        def({ kind: 'record', supertypes: [], fields: [], groups: [] }, { subtypes: ['nowhere'] }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/unresolved subtype/u);
  });

  it('resolves a `source` against the structure-namespace fallback (§3.3.1)', () => {
    const structureNamespace = new Map<string, TypeDefinition>([
      [
        'array',
        def({
          kind: 'array',
          elementType: ref('text'),
          state: 'REQUIRED',
          unordered: false,
          uniqueItems: false,
        }),
      ], // stands in for a constructor role
    ]);
    const merged = new Map<string, TypeDefinition>([
      [
        'widget',
        def({ kind: 'record', supertypes: [], fields: [], groups: [] }, { source: ref('array') }),
      ],
    ]);
    // `array` resolves only via the structure-namespace fallback, not the ordinary namespace --
    // this would throw with structureNamespace omitted.
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn', structureNamespace });
    }).not.toThrow();
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow();
  });
});
