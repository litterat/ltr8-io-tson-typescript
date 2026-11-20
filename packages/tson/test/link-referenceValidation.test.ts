import { describe, expect, it } from 'vitest';

import { validateReferences } from '../src/link/referenceValidation.js';
import { collector } from '../src/core/diagnostic.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { NamedField, RecordField } from '../src/schema/meta/bodies.js';
import type { MetaValue, Token, Top, TypeExpr, TypeRef } from '../src/schema/meta/typedef.js';
import { namespaceOf } from '../src/schema/meta/typedef.js';
import { entry, fieldMapOf, namespaceEntry, parametricRecord } from './model-fixtures.js';

function ref(name: string): TypeRef {
  return { name, annotations: [] };
}

/** `head<arguments…>` written in place at a type slot (§5.10). */
function apply(head: string, ...args: readonly string[]): TypeExpr {
  return {
    kind: 'inline',
    head: 'meta.apply',
    of: { kind: 'apply', head: ref(head), arguments: args.map(ref) },
  };
}

function token(text: string, form: Token['form'] = 'UNQUOTED'): Token {
  return { text, form };
}

function field(name: string, type: TypeExpr, role: RecordField['role'], value?: Token): NamedField {
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
  // A non-empty `parameters` makes a record a parametric record (§5.10).
  const parameters = options.parameters ?? [];
  const value: Top =
    parameters.length === 0 || body.kind !== 'record' ? body : parametricRecord(parameters, body);
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
      ['al', def({ kind: 'alias', target: ref('text') })],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).not.toThrow();
  });

  it('reports through a receiver, letting every other entry still be checked', () => {
    const merged = new Map<string, Top>([
      ['text', text],
      ['bad_a', def({ kind: 'alias', target: ref('nowhere_a') })],
      ['bad_b', def({ kind: 'alias', target: ref('nowhere_b') })],
      ['good', def({ kind: 'alias', target: ref('text') })],
    ]);
    const diagnostics = collector();
    validateReferences(merged, { schemaId: 'https://x/s.tn', receiver: diagnostics });
    expect(diagnostics.diagnostics).toHaveLength(2);
    expect(diagnostics.diagnostics.every((d) => d.code === 'SCHEMA_ERROR')).toBe(true);
  });

  it('refuses an alias of an entry applying a namespace type: an alias target is a meta.type_ref (§4.1, §8.3)', () => {
    const merged = new Map<string, Top>([
      ['myapi', apiValue()],
      ['user', def({ kind: 'alias', target: ref('myapi') })],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/'user' names 'myapi', which is a value and not a type/u);
  });

  it('judges an alias by the entry its hops reach, so an alias of such an alias is refused too (§8.3)', () => {
    const merged = new Map<string, Top>([
      ['myapi', apiValue()],
      ['user', def({ kind: 'alias', target: ref('myapi') })],
      ['again', def({ kind: 'alias', target: ref('user') })],
    ]);
    const diagnostics = collector();
    validateReferences(merged, { schemaId: 'https://x/s.tn', receiver: diagnostics });
    expect(diagnostics.diagnostics.map((d) => d.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/'again' names 'user', which reaches a value and not a type/u),
      ]),
    );
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
  return namespaceEntry(namespaceOf('api', new Map([['orders', operation]])));
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

  /** `user`, a record whose one field `f` is typed `type`. */
  function user(type: TypeExpr): Top {
    return def({
      kind: 'record',
      fields: fieldMapOf([field('f', type, 'FREE')]),
      groups: [],
      extension: 'OPEN',
    });
  }

  it('rejects an application supplying too many arguments', () => {
    const merged = new Map<string, Top>([
      ['text', text],
      ['box', template],
      ['user', user(apply('box', 'text', 'text'))],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/takes 1 type argument/u);
  });

  it('admits an application supplying one argument per parameter', () => {
    const merged = new Map<string, Top>([
      ['text', text],
      ['box', template],
      ['user', user(apply('box', 'text'))],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).not.toThrow();
  });

  it('rejects a parametric record named bare at a type slot: it is no type until applied (§5.10)', () => {
    const merged = new Map<string, Top>([
      ['box', template],
      ['user', user(ref('box'))],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/not a type until it is applied/u);
  });

  it('rejects arguments applied to a name that declares no type parameters', () => {
    const merged = new Map<string, Top>([
      ['text', text],
      ['user', user(apply('text', 'text'))],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/declares no type parameters/u);
  });

  it('rejects a type parameter itself applied to arguments (no head abstraction, §5.10)', () => {
    const merged = new Map<string, Top>([
      [
        'box',
        def(
          {
            kind: 'record',
            fields: fieldMapOf([field('v', apply('T', 'text'), 'FREE')]),
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
    }).toThrow(/type parameter applied to arguments/u);
  });
});

describe('validateReferences: choice variants (§5.4)', () => {
  it('rejects two variants that resolve to the same type', () => {
    const merged = new Map<string, Top>([
      ['text', text],
      ['other_text', def({ kind: 'alias', target: ref('text') })],
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
      ['count', def({ kind: 'alias', target: ref('int') })],
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
      ['count', def({ kind: 'alias', target: ref('int') })],
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

  it('skips a field whose own type names one of the enclosing parametric record’s parameters', () => {
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

  it('rejects a default on a field typed by an application written in place: a value stands on a reference alone there (§5.2)', () => {
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
          fields: fieldMapOf([field('b', apply('box', 'text'), 'DEFAULT', token('x'))]),
          groups: [],
          extension: 'OPEN',
        }),
      ],
      ['text', text],
    ]);
    expect(() => {
      validateReferences(merged, { schemaId: 'https://x/s.tn' });
    }).toThrow(/not a scalar type/u);
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
