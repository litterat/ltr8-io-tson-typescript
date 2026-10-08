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

const text: TypeDefinition = def({ kind: 'text_type', normalization: 'NONE' });

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
        }),
      ],
      [
        'forest',
        def({
          kind: 'array',
          elementType: ref('tree'),
          voidable: false,
          ordered: true,
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
        }),
      ],
      [
        'forest',
        def({
          kind: 'map',
          keyType: ref('text'),
          valueType: ref('tree'),
          voidable: false,
          ordered: false,
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
      ['loop', def({ kind: 'tuple', elements: [{ elementType: ref('loop'), voidable: false }] })],
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
        }),
      ],
      ['void', def({ kind: 'void_type' })],
      ['text', text],
    ]);
    expect(() => {
      check(merged);
    }).toThrow(/'sealed_off' can never be satisfied/u);
  });

  it('rejects a required, non-voidable field typed by an ALIAS of void, followed through the reference chain (§5.10.1, §5.2, §8.3)', () => {
    const merged = new Map<string, TypeDefinition>([
      ['void', def({ kind: 'void_type' })],
      ['nothing', def({ kind: 'reference', target: ref('void') })],
      [
        'sealed_off',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('name', ref('text')), field('never', ref('nothing'))],
          groups: [],
          extension: 'OPEN',
        }),
      ],
      ['text', text],
    ]);
    expect(() => {
      check(merged);
    }).toThrow(TsonSchemaValidationError);
    expect(() => {
      check(merged);
    }).toThrow(/'sealed_off' can never be satisfied/u);
  });

  it('rejects a record field group that must be chosen with no satisfiable member', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'loop',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('a', ref('loop')), field('b', ref('loop'))],
          groups: [{ members: [['a'], ['b']], optional: false }],
          extension: 'OPEN',
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
        }),
      ],
      [
        'forest',
        def({
          kind: 'array',
          elementType: ref('tree'),
          voidable: false,
          ordered: true,
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
        }),
      ],
      [
        'forest',
        def({
          kind: 'array',
          elementType: ref('tree'),
          voidable: false,
          ordered: true,
          uniqueItems: false,
          minItems: 0n,
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('accepts a voidable array element, regardless of minItems', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'tree',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('children', ref('forest'))],
          groups: [],
          extension: 'OPEN',
        }),
      ],
      [
        'forest',
        def({
          kind: 'array',
          elementType: ref('tree'),
          voidable: true,
          ordered: true,
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
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('accepts a self-reference through a voidable tuple position', () => {
    const merged = new Map<string, TypeDefinition>([
      ['loop', def({ kind: 'tuple', elements: [{ elementType: ref('loop'), voidable: true }] })],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('accepts a self-reference behind an optional record field group', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'loop',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('a', ref('loop')), field('b', ref('loop'))],
          groups: [{ members: [['a'], ['b']], optional: true }],
          extension: 'OPEN',
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
          groups: [{ members: [['a'], ['b']], optional: false }],
          extension: 'OPEN',
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('a required group is satisfied by an option whose unmarked members are all inhabited (§5.10.1)', () => {
    const loopOption = (marked: boolean): Map<string, TypeDefinition> =>
      new Map<string, TypeDefinition>([
        ['text', text],
        [
          'loop',
          def({
            kind: 'record',
            supertypes: [],
            fields: [
              field('a', ref('loop'), { optional: true }),
              field('b', ref('text'), { optional: true }),
              field('c', ref('text'), { optional: true }),
            ],
            // Option one holds the recursive `a`; option two holds `b` and `c`.
            groups: [
              {
                members: [['a'], ['b', 'c']],
                ...(marked ? { optionalMembers: ['a'] } : {}),
                optional: false,
              },
            ],
            extension: 'OPEN',
          }),
        ],
      ]);
    expect(() => {
      check(loopOption(false));
    }).not.toThrow();
  });

  it('a required group whose every option holds an uninhabited unmarked member is uninhabited, and a marked member is not demanded (§5.10.1)', () => {
    const only = (optionalMembers: string[]): Map<string, TypeDefinition> =>
      new Map<string, TypeDefinition>([
        [
          'loop',
          def({
            kind: 'record',
            supertypes: [],
            fields: [
              field('a', ref('loop'), { optional: true }),
              field('b', ref('loop'), { optional: true }),
            ],
            groups: [
              {
                members: [['a'], ['b']],
                ...(optionalMembers.length > 0 ? { optionalMembers } : {}),
                optional: false,
              },
            ],
            extension: 'OPEN',
          }),
        ],
      ]);
    expect(() => {
      check(only([]));
    }).toThrow(/'loop' can never be satisfied/u);
  });

  it('a member marked optional within its option is not demanded once the option is chosen (§5.10.1)', () => {
    const merged = new Map<string, TypeDefinition>([
      ['text', text],
      [
        'loop',
        def({
          kind: 'record',
          supertypes: [],
          fields: [
            field('a', ref('loop'), { optional: true }),
            field('b', ref('text'), { optional: true }),
          ],
          groups: [{ members: [['a', 'b'], ['b']], optionalMembers: ['a'], optional: false }],
          extension: 'OPEN',
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('an optional group never demands an option (§5.10.1)', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'loop',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('a', ref('loop'), { optional: true })],
          groups: [{ members: [['a']], optional: true }],
          extension: 'OPEN',
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });

  it('a set may be empty, so a self-reference through one is productive; an array of voidable elements is too (§5.3, §5.10.1)', () => {
    const merged = new Map<string, TypeDefinition>([
      [
        'tree',
        def({
          kind: 'record',
          supertypes: [],
          fields: [field('children', ref('children'))],
          groups: [],
          extension: 'OPEN',
        }),
      ],
      [
        'children',
        def({
          kind: 'array',
          elementType: ref('tree'),
          voidable: false,
          ordered: false,
          uniqueItems: true,
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
      parameters: [{ name: 'T', type: { name: 'type_ref', arguments: [], annotations: [] } }],
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
      ['void', def({ kind: 'void_type' })],
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

describe('checkEveryEntryIsInhabited: chosen options (§5.10.1, §5.11)', () => {
  const void_: TypeDefinition = def({ kind: 'void_type' });
  const recordOf = (
    fields: RecordField[],
    groups: { members: string[][]; optionalMembers?: string[]; optional: boolean }[],
  ): TypeDefinition => def({ kind: 'record', supertypes: [], fields, groups, extension: 'OPEN' });
  const group = (
    fields: RecordField[],
    members: string[][],
    optionalMembers?: string[],
  ): ReadonlyMap<string, TypeDefinition> =>
    new Map<string, TypeDefinition>([
      ['void', void_],
      ['text', text],
      [
        'r',
        recordOf(fields, [
          {
            members,
            ...(optionalMembers === undefined ? {} : { optionalMembers }),
            optional: false,
          },
        ]),
      ],
    ]);
  const optionalField = (name: string, type: string, marks = {}): RecordField =>
    field(name, ref(type), { optional: true, ...marks });

  it('a group is productive when one option is choosable (§5.11)', () => {
    expect(() => {
      check(group([optionalField('a', 'void'), optionalField('b', 'text')], [['a'], ['b']]));
    }).not.toThrow();
  });

  it('an unmarked member narrowed to void makes its option unchoosable, and a group with no choosable option is unsatisfiable (§5.11)', () => {
    expect(() => {
      check(group([optionalField('a', 'void'), optionalField('b', 'void')], [['a'], ['b']]));
    }).toThrow(/'r' can never be satisfied/u);
  });

  it('a marked member narrowed to void drops out of its option, which stays choosable by the others (§5.11)', () => {
    expect(() => {
      check(
        group(
          [optionalField('a', 'text'), optionalField('b', 'void'), optionalField('c', 'void')],
          [['a', 'b'], ['c']],
          ['b'],
        ),
      );
    }).not.toThrow();
  });

  it('an option whose members are all marked and all void can be chosen by nothing (§5.11)', () => {
    expect(() => {
      check(
        group([optionalField('a', 'void'), optionalField('b', 'void')], [['a', 'b']], ['a', 'b']),
      );
    }).toThrow(/can never be satisfied/u);
  });

  it('a voidable member narrowed to void? is present as `_` and chooses its option (§5.11)', () => {
    expect(() => {
      check(
        group(
          [optionalField('a', 'void', { voidable: true }), optionalField('b', 'void')],
          [['a'], ['b']],
        ),
      );
    }).not.toThrow();
  });

  it('a map whose values may be void is productive when its keys are (§5.10.1)', () => {
    const merged = new Map<string, TypeDefinition>([
      ['text', text],
      [
        'm',
        def({
          kind: 'map',
          keyType: ref('text'),
          valueType: ref('m'),
          voidable: true,
          ordered: false,
          minItems: 1n,
        }),
      ],
    ]);
    expect(() => {
      check(merged);
    }).not.toThrow();
  });
});
