import { describe, expect, it } from 'vitest';

import { validateReferences } from '../src/link/referenceValidation.js';
import { collector } from '../src/core/diagnostic.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { NamedField, RecordField } from '../src/schema/meta/bodies.js';
import { TYPE_KIND } from '../src/schema/meta/bodies.js';
import type { MetaValue, Token, Top, TypeRef } from '../src/schema/meta/typedef.js';
import { isTemplateBody, namespaceOf } from '../src/schema/meta/typedef.js';
import { entry, fieldMapOf } from './model-fixtures.js';

function ref(name: string, args: TypeRef['arguments'] = []): TypeRef {
  return { name, arguments: args, annotations: [] };
}

function token(text: string, form: Token['form'] = 'UNQUOTED'): Token {
  return { text, form };
}

function field(name: string, type: TypeRef, role: RecordField['role'], value?: Token): NamedField {
  const optional = role === 'DEFAULT';
  return {
    name,
    type,
    optional,
    voidable: false,
    role,
    annotations: [],
    ...(value === undefined ? {} : { value }),
  };
}

function def(
  body: Top,
  options: {
    readonly parameters?: readonly string[];
    readonly supertypes?: readonly string[];
    readonly subtypes?: readonly string[];
  } = {},
): Top {
  // A non-empty `parameters` makes a record a record template (§5.10): the record it is, with
  // its parameters, each a type parameter.
  const parameters = options.parameters ?? [];
  const value: Top =
    parameters.length === 0 || isTemplateBody(body) || body.kind !== 'record'
      ? body
      : {
          ...body,
          parameters: parameters.map((name) => ({
            name,
            type: { name: TYPE_KIND, arguments: [], annotations: [] },
          })),
        };
  return entry(value, options.supertypes ?? [], options.subtypes ?? []);
}

const text = def({ kind: 'text_type', normalization: 'NONE' });

describe('validateReferences: unresolved references (§3.3.1, §3.3.2)', () => {
  it('throws (fail-fast) on a field type that resolves to nothing', () => {
    const merged = new Map<string, Top>([
      ['text', text],
      [
        'widget',
        def({
          kind: 'record',
          fields: fieldMapOf([
            {
              name: 'x',
              type: ref('nowhere'),
              optional: false,
              voidable: false,
              role: 'FREE',
              annotations: [],
            },
          ]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(TsonSchemaValidationError);
  });

  it('accepts every field/element/key/value/variant reference that does resolve', () => {
    const merged = new Map<string, Top>([
      ['text', text],
      [
        'widget',
        def({
          kind: 'record',
          fields: fieldMapOf([
            {
              name: 'x',
              type: ref('text'),
              optional: false,
              voidable: false,
              role: 'FREE',
              annotations: [],
            },
          ]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
      [
        'arr',
        def({
          kind: 'array',
          elementType: ref('text'),
          voidable: false,
          ordered: true,
          uniqueItems: false,
        }),
      ],
      [
        'm',
        def({
          kind: 'map',
          keyType: ref('text'),
          valueType: ref('text'),
          voidable: false,
          ordered: false,
        }),
      ],
      [
        't',
        def({
          kind: 'tuple',
          elements: [{ elementType: ref('text'), voidable: false }],
        }),
      ],
      ['al', def({ kind: 'reference', target: ref('text') })],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).not.toThrow();
  });

  it('reports through a receiver, letting every other entry still be checked', () => {
    const merged = new Map<string, Top>([
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

  it('rejects a reference to an entry applying a namespace type, a value and not a type (§4.1)', () => {
    const merged = new Map<string, Top>([
      ['myapi', apiValue()],
      ['user', def({ kind: 'reference', target: ref('myapi') })],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/a value and not a type/u);
  });

  it('allows a reference to the enclosing declaration`s own type parameter', () => {
    const merged = new Map<string, Top>([
      [
        'box',
        def(
          {
            kind: 'record',
            fields: fieldMapOf([
              {
                name: 'v',
                type: ref('T'),
                optional: false,
                voidable: false,
                role: 'FREE',
                annotations: [],
              },
            ]),
            groups: [],
            extension: 'OPEN',
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

/** `myapi => !api { orders => { verb: GET } }` -- an entry applying a meta layer's namespace type (§4.1). */
function apiValue(): Top {
  const operation: MetaValue = {
    form: 'record',
    type: 'operation',
    fields: new Map([['verb', { form: 'token', token: { text: 'GET', form: 'UNQUOTED' } }]]),
  };
  return namespaceOf('api', new Map([['orders', operation]]));
}

describe('validateReferences: a namespace value is a value, never a type (§4.1)', () => {
  it('links an entry applying a namespace type without reading it as a type', () => {
    const merged = new Map<string, Top>([['myapi', apiValue()]]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).not.toThrow();
  });

  it('refuses a field typed by a namespace value, naming it a value', () => {
    const merged = new Map<string, Top>([
      ['myapi', apiValue()],
      [
        'holder',
        def({
          kind: 'record',
          fields: fieldMapOf([field('api', ref('myapi'), 'FREE')]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/'myapi', which is a value and not a type/u);
  });

  it('reports the refusal through a receiver as a schema error', () => {
    const merged = new Map<string, Top>([
      ['myapi', apiValue()],
      ['user', def({ kind: 'reference', target: ref('myapi') })],
    ]);
    const diagnostics = collector();
    validateReferences(merged, { schemaId: 'https://x/s.tn', receiver: diagnostics });
    expect(diagnostics.diagnostics).toHaveLength(1);
    expect(diagnostics.diagnostics[0]?.code).toBe('SCHEMA_ERROR');
  });
});

describe('validateReferences: arity (§5.10)', () => {
  const template = def(
    {
      kind: 'record',
      fields: fieldMapOf([
        {
          name: 'v',
          type: ref('T'),
          optional: false,
          voidable: false,
          role: 'FREE',
          annotations: [],
        },
      ]),
      groups: [],
      extension: 'OPEN',
    },
    { parameters: ['T'] },
  );

  it('rejects an application supplying too many arguments', () => {
    const merged = new Map<string, Top>([
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

  it('admits a bare reference to a record template, a family base and itself a type (§5.10)', () => {
    const merged = new Map<string, Top>([
      ['box', template],
      ['user', def({ kind: 'reference', target: ref('box') })],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).not.toThrow();
  });

  it('rejects a bare reference to a held template with no arguments at all (§5.10)', () => {
    const held: Top = {
      parameters: [{ name: 'T', type: { name: TYPE_KIND, arguments: [], annotations: [] } }],
      template: '!array { element_type: T }',
    };
    const merged = new Map<string, Top>([
      ['wrapped', held],
      ['user', def({ kind: 'reference', target: ref('wrapped') })],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/not a type until it is applied/u);
  });

  it('rejects arguments applied to a name that declares no type parameters', () => {
    const merged = new Map<string, Top>([
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
    const merged = new Map<string, Top>([
      [
        'box',
        def(
          {
            kind: 'record',
            fields: fieldMapOf([
              {
                name: 'v',
                type: ref('T', [{ kind: 'ref', ref: ref('text') }]),
                optional: false,
                voidable: false,
                role: 'FREE',
                annotations: [],
              },
            ]),
            groups: [],
            extension: 'OPEN',
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
    const merged = new Map<string, Top>([
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
    const merged = new Map<string, Top>([
      ['text', text],
      ['void', def({ kind: 'void_type' })],
      ['c', def({ kind: 'choice', variants: [ref('text'), ref('void')] })],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/optionality is not choice/u);
  });

  it('accepts a choice whose variants are all distinct and none is void', () => {
    const merged = new Map<string, Top>([
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
    const merged = new Map<string, Top>([
      ['text', text],
      [
        'box',
        def(
          {
            kind: 'record',
            fields: fieldMapOf([
              {
                name: 'v',
                type: ref('text'),
                optional: false,
                voidable: false,
                role: 'FREE',
                annotations: [],
              },
            ]),
            groups: [],
            extension: 'OPEN',
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
    const merged = new Map<string, Top>([
      [
        'widget',
        def(
          {
            kind: 'record',
            fields: fieldMapOf([]),
            groups: [],
            extension: 'OPEN',
          },
          { supertypes: ['nowhere'] },
        ),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/unresolved supertype/u);
  });

  it('rejects an unresolved subtype (a broken reverse-index invariant)', () => {
    const merged = new Map<string, Top>([
      [
        'widget',
        def(
          {
            kind: 'record',
            fields: fieldMapOf([]),
            groups: [],
            extension: 'OPEN',
          },
          { subtypes: ['nowhere'] },
        ),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/unresolved subtype/u);
  });

  it("resolves an entry's head against the structure-namespace fallback (§3.3.1)", () => {
    const structureNamespace = new Map<string, Top>([
      [
        'array',
        def({
          kind: 'array',
          elementType: ref('text'),
          voidable: false,
          ordered: true,
          uniqueItems: false,
        }),
      ], // stands in for a constructor role
    ]);
    const merged = new Map<string, Top>([
      [
        'widget',
        def({
          kind: 'record',
          fields: fieldMapOf([]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
    ]);
    // The constructor `widget` was built with is a fact beside its value (§8.1).
    const facts = new Map([['widget', { head: 'array' }]]);
    // `array` resolves only via the structure-namespace fallback, not the ordinary namespace --
    // this would throw with structureNamespace omitted.
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn', facts, structureNamespace });
    }).not.toThrow();
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn', facts });
    }).toThrow();
  });
});

describe('validateReferences: field values (§5.2)', () => {
  const point = def({
    kind: 'record',
    fields: fieldMapOf([]),
    groups: [],
    extension: 'OPEN',
  });
  const status = def({ kind: 'enum', members: ['UP', 'DOWN'], nameType: 'identifier' });
  const int = def({ kind: 'integer_type' });

  it('rejects a default on a record-typed field', () => {
    const merged = new Map<string, Top>([
      ['point', point],
      [
        'odd',
        def({
          kind: 'record',
          fields: fieldMapOf([field('p', ref('point'), 'DEFAULT', token('3'))]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/is declared 'point', which is a record, so it cannot have a default/u);
  });

  it('rejects a fixed value on an array-typed field, naming "fixed value" rather than "default"', () => {
    const merged = new Map<string, Top>([
      ['text', text],
      [
        'arr',
        def({
          kind: 'array',
          elementType: ref('text'),
          voidable: false,
          ordered: true,
          uniqueItems: false,
        }),
      ],
      [
        'odd',
        def({
          kind: 'record',
          fields: fieldMapOf([field('a', ref('arr'), 'FIXED', token('x'))]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/cannot have a fixed value/u);
  });

  it('rejects a default on a choice-typed field', () => {
    const merged = new Map<string, Top>([
      ['text', text],
      ['int', int],
      ['choice', def({ kind: 'choice', variants: [ref('text'), ref('int')] })],
      [
        'odd',
        def({
          kind: 'record',
          fields: fieldMapOf([field('c', ref('choice'), 'DEFAULT', token('x'))]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/is a choice/u);
  });

  it('accepts a default naming a real member of the field’s declared enum', () => {
    const merged = new Map<string, Top>([
      ['status', status],
      [
        'widget',
        def({
          kind: 'record',
          fields: fieldMapOf([field('state', ref('status'), 'DEFAULT', token('UP'))]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).not.toThrow();
  });

  it('rejects a default naming something that is not a member of the field’s declared enum', () => {
    const merged = new Map<string, Top>([
      ['status', status],
      [
        'widget',
        def({
          kind: 'record',
          fields: fieldMapOf([field('state', ref('status'), 'DEFAULT', token('SIDEWAYS'))]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/not a value of that type/u);
  });

  it('rejects a fixed value that is not shaped like the field’s declared atom type', () => {
    const merged = new Map<string, Top>([
      ['int', int],
      [
        'widget',
        def({
          kind: 'record',
          fields: fieldMapOf([field('n', ref('int'), 'FIXED', token('not-a-number'))]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/not a value of that type/u);
  });

  it("checks a fixed value against the terminal of the field's own type when that type is itself an alias (§5.2, §8.3)", () => {
    const merged = new Map<string, Top>([
      ['int', int],
      ['count', def({ kind: 'reference', target: ref('int') })],
      [
        'widget',
        def({
          kind: 'record',
          fields: fieldMapOf([field('n', ref('count'), 'FIXED', token('not-a-number'))]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
      // The message still names the field's own declared type, `count` -- the author's own
      // spelling, not `int`, the terminal the value is actually checked against.
    }).toThrow(/is declared 'count'.*not a value of that type/su);
  });

  it("accepts a fixed value that is a value of the terminal an alias-typed field's own chain leads to (§5.2, §8.3)", () => {
    const merged = new Map<string, Top>([
      ['int', int],
      ['count', def({ kind: 'reference', target: ref('int') })],
      [
        'widget',
        def({
          kind: 'record',
          fields: fieldMapOf([field('n', ref('count'), 'FIXED', token('3'))]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).not.toThrow();
  });

  it('skips a field whose own type names one of the enclosing template’s parameters', () => {
    const merged = new Map<string, Top>([
      [
        'box',
        def(
          {
            kind: 'record',
            fields: fieldMapOf([field('v', ref('T'), 'DEFAULT', token('T'))]),
            groups: [],
            extension: 'OPEN',
          },
          { parameters: ['T'] },
        ),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).not.toThrow();
  });

  it('skips a field whose declared type is itself still open (a template, not yet applied)', () => {
    const merged = new Map<string, Top>([
      [
        'box',
        def(
          {
            kind: 'record',
            fields: fieldMapOf([field('v', ref('T'), 'FREE')]),
            groups: [],
            extension: 'OPEN',
          },
          { parameters: ['T'] },
        ),
      ],
      [
        'widget',
        def({
          kind: 'record',
          fields: fieldMapOf([
            field('b', ref('box', [{ kind: 'ref', ref: ref('text') }]), 'DEFAULT', token('x')),
          ]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
      ['text', text],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).not.toThrow();
  });

  it("rejects a default on a field declared 'void' (unit's own non-scalar instance)", () => {
    const merged = new Map<string, Top>([
      ['void', def({ kind: 'void_type' })],
      [
        'widget',
        def({
          kind: 'record',
          fields: fieldMapOf([field('v', ref('void'), 'DEFAULT', token('x'))]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/the void type/u);
  });

  it("accepts a default on unit's scalar, non-'void' instance without checking the value’s shape", () => {
    const merged = new Map<string, Top>([
      ['token', def({ kind: 'value_type' })],
      [
        'widget',
        def({
          kind: 'record',
          fields: fieldMapOf([field('t', ref('token'), 'DEFAULT', token('anything at all'))]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).not.toThrow();
  });

  it('quotes the echoed value in the message when it was written quoted', () => {
    const merged = new Map<string, Top>([
      ['point', point],
      [
        'odd',
        def({
          kind: 'record',
          fields: fieldMapOf([
            field('p', ref('point'), 'DEFAULT', token('hi', 'SINGLE_LINE_QUOTED')),
          ]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/"hi"/u);
  });
});
