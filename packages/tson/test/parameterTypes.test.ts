import { describe, expect, it } from 'vitest';

import { inferAll, inferOne, kinds as kindsOf } from '../src/compiler/parameterTypes.js';
import { createHeldBody } from '../src/compiler/heldBody.js';
import { refValue, scoped, tokenValue } from '../src/compiler/wireForm.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { CoreValue } from '../src/ast/value.js';
import type { RecordBody } from '../src/schema/meta/bodies.js';
import type { TypeDefinition, TypeRef } from '../src/schema/meta/typedef.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

function refT(name: string): TypeRef {
  return { name, arguments: [], annotations: [] };
}

function record(fields: Record<string, CoreValue>): CoreValue {
  return {
    kind: 'record',
    fields: Object.entries(fields).map(([name, value]) => ({ name, value: scoped(value) })),
  };
}

function array(...values: CoreValue[]): CoreValue {
  return { kind: 'array', elements: values.map((v) => scoped(v)) };
}

function token(text: string): CoreValue {
  return tokenValue(text);
}

/** `<parameters> => !typeRef coreValue` -- an open declaration, held the way `definitionResolver.ts` holds one. */
function template(
  parameters: readonly string[],
  typeRef: string,
  coreValue: CoreValue,
): TypeDefinition {
  return {
    supertypes: [],
    subtypes: [],
    body: createHeldBody({ annotations: [], typeRef, coreValue }, parameters),
    annotations: [],
  };
}

function recordVocab(
  fields: readonly { readonly name: string; readonly type: string }[],
): TypeDefinition {
  const body: RecordBody = {
    kind: 'record',
    supertypes: [],
    groups: [],
    extension: 'OPEN',
    fields: fields.map((f) => ({
      name: f.name,
      type: refT(f.type),
      optional: false,
      voidable: false,
      role: 'FREE',
      annotations: [],
    })),
  };
  return {
    // IS-A `top` through `product` (hand-built) is what makes `isConstructor` true.
    supertypes: ['product', 'top'],
    subtypes: [],
    body,
    annotations: [],
  };
}

function arrayVocab(elementType: string): TypeDefinition {
  return {
    supertypes: ['product', 'top'],
    subtypes: [],
    body: {
      kind: 'array',
      elementType: refT(elementType),
      voidable: false,
      ordered: true,
      uniqueItems: false,
    },
    annotations: [],
  };
}

function atomVocab(): TypeDefinition {
  return {
    supertypes: ['atom', 'top'],
    subtypes: [],
    body: { kind: 'text_type', normalization: 'NONE' },
    annotations: [],
  };
}

/** A local type that IS-A each of `supertypes`, as the schema's own namespace records it. */
function localType(...supertypes: string[]): TypeDefinition {
  return {
    supertypes,
    subtypes: [],
    body: { kind: 'text_type', normalization: 'NONE' },
    annotations: [],
  };
}

/**
 * Just enough of the meta-kernel's own vocabulary for `array.element_type` to be `type_ref`,
 * `array.min_items` a `non_negative_integer`, `enum.members` a set of `identifier`, and
 * `reference.target` a `type_ref` -- the exact slots §5.10's own motivating cases classify
 * against.
 */
function baseMeta(): Map<string, TypeDefinition> {
  return new Map<string, TypeDefinition>([
    [
      'array',
      recordVocab([
        { name: 'element_type', type: 'type_ref' },
        { name: 'min_items', type: 'non_negative_integer' },
      ]),
    ],
    ['non_negative_integer', atomVocab()],
    ['record', recordVocab([{ name: 'fields', type: 'record_field_list' }])],
    ['record_field_list', arrayVocab('record_field')],
    [
      'record_field',
      recordVocab([
        { name: 'name', type: 'identifier' },
        { name: 'type', type: 'type_ref' },
        { name: 'value', type: 'value' },
      ]),
    ],
    ['value', atomVocab()],
    ['enum', recordVocab([{ name: 'members', type: 'enum_set' }])],
    ['enum_set', arrayVocab('identifier')],
    ['identifier', atomVocab()],
    ['reference', recordVocab([{ name: 'target', type: 'type_ref' }])],
    [
      'both',
      recordVocab([
        { name: 'x', type: 'type_ref' },
        { name: 'y', type: 'identifier' },
      ]),
    ],
  ]);
}

function noReports(): { report(name: string, error: TsonSchemaValidationError): void } {
  return {
    report(name: string): void {
      throw new Error(`unexpected report for '${name}'`);
    },
  };
}

// ── inferOne: one template's own occurrences ────────────────────────────────────────────────

describe('inferOne', () => {
  it('a parameter standing at a `type_ref`-typed slot is a TYPE parameter', () => {
    const box = template(['T'], 'array', record({ element_type: token('T') }));
    const kinds = inferOne(box, (name) => baseMeta().get(name));
    expect(kinds.get('T')).toBe('TYPE');
  });

  it(
    "the enum-member motivating case: 'e => <M> !enum { members: [a b M] }' -- M is a VALUE " +
      'parameter, not a reference (§5.10)',
    () => {
      const e = template(
        ['M'],
        'enum',
        record({ members: array(token('a'), token('b'), token('M')) }),
      );
      const kinds = inferOne(e, (name) => baseMeta().get(name));
      expect(kinds.get('M')).toBe('VALUE');
    },
  );

  it('a parameter standing for a whole collection (neither type_ref nor scalar) is refused, not deferred', () => {
    // `<T> !enum { members: T }` -- T stands for the whole `enum_set`, an ArrayBody, not one of
    // its elements.
    const bad = template(['T'], 'enum', record({ members: token('T') }));
    expect(() => inferOne(bad, (name) => baseMeta().get(name))).not.toThrow();
    expect(inferOne(bad, (name) => baseMeta().get(name)).size).toBe(0);
  });

  it('a parameter used as both a type and a value parameter yields no kinds (a conflict, caught by the batch pass)', () => {
    const both = template(['T'], 'both', record({ x: token('T'), y: token('T') }));
    const kinds = inferOne(both, (name) => baseMeta().get(name));
    expect(kinds.size).toBe(0);
  });

  it('a non-template (no parameters) or a non-held body yields no kinds', () => {
    const plain: TypeDefinition = {
      supertypes: [],
      subtypes: [],
      body: { kind: 'record', supertypes: [], fields: [], groups: [], extension: 'OPEN' },
      annotations: [],
    };
    expect(inferOne(plain, (name) => baseMeta().get(name)).size).toBe(0);
  });
});

// ── inferAll: the whole-namespace batch pass, with its fixed point ─────────────────────────────

const NO_WRITTEN = new Map<string, ReadonlyMap<string, TypeRef>>();

/** `inferAll` over `entries`, every one of them local, against `baseMeta()` plus `extra`. */
function infer(
  entries: ReadonlyMap<string, TypeDefinition>,
  options: {
    readonly written?: ReadonlyMap<string, ReadonlyMap<string, TypeRef>>;
    readonly local?: ReadonlySet<string>;
    readonly extra?: ReadonlyMap<string, TypeDefinition>;
    readonly reporter?: { report(name: string, error: TsonSchemaValidationError): void };
  } = {},
) {
  const meta = baseMeta();
  // `extra` are types the schema's own namespace declares beside the templates under test.
  const namespace = new Map([...entries, ...(options.extra ?? [])]);
  return inferAll(
    namespace,
    options.local ?? new Set(entries.keys()),
    options.written ?? NO_WRITTEN,
    (name) => meta.get(name),
    options.reporter ?? noReports(),
  );
}

describe('inferAll -- each parameter gets the type an argument for it is read as (§5.10, §8.1)', () => {
  it('a parameter at a type_ref slot is a type parameter, recorded type: type_ref with no bound', () => {
    const entries = new Map([
      ['box', template(['T'], 'array', record({ element_type: token('T') }))],
    ]);
    expect(infer(entries).get('box')?.get('T')).toEqual({ name: 'T', type: refT('type_ref') });
  });

  it("a parameter at a scalar slot records that slot's declared type", () => {
    const entries = new Map([
      [
        'vec',
        template(['N'], 'array', record({ element_type: token('text'), min_items: token('N') })),
      ],
      ['e', template(['M'], 'enum', record({ members: array(token('a'), token('M')) }))],
    ]);
    const parameters = infer(entries);
    expect(parameters.get('vec')?.get('N')).toEqual({
      name: 'N',
      type: refT('non_negative_integer'),
    });
    expect(parameters.get('e')?.get('M')).toEqual({ name: 'M', type: refT('identifier') });
  });

  it('kinds() reads a type parameter off type: type_ref and every other as a value parameter', () => {
    const entries = new Map([
      ['box', template(['T'], 'array', record({ element_type: token('T') }))],
      ['e', template(['M'], 'enum', record({ members: array(token('a'), token('M')) }))],
    ]);
    const kinds = kindsOf(infer(entries));
    expect(kinds.get('box')?.get('T')).toBe('TYPE');
    expect(kinds.get('e')?.get('M')).toBe('VALUE');
  });

  it(
    "a routed default or fixed value takes the field's own declared type, read from the sibling " +
      '`type` slot -- `<T, N> { w?: T ~ N }` gives N the type T (§5.10)',
    () => {
      const w = record({
        name: token('w'),
        type: token('T'),
        value: token('N'),
      });
      const entries = new Map([
        ['boxed', template(['T', 'N'], 'record', record({ fields: array(w) }))],
      ]);
      const parameters = infer(entries).get('boxed');
      expect(parameters?.get('T')).toEqual({ name: 'T', type: refT('type_ref') });
      expect(parameters?.get('N')).toEqual({ name: 'N', type: refT('T') });
    },
  );

  it("a parameter riding another template's argument list takes the callee's recorded type, settled by a fixed point", () => {
    const box = template(['T'], 'array', record({ element_type: token('T') }));
    const wrap = template(
      ['U'],
      'reference',
      record({
        target: refValue({
          name: 'box',
          arguments: [{ kind: 'ref', ref: refT('U') }],
          annotations: [],
        }),
      }),
    );
    const entries = new Map([
      ['box', box],
      ['wrap', wrap],
    ]);
    const parameters = infer(entries);
    expect(parameters.get('box')?.get('T')?.type).toEqual(refT('type_ref'));
    expect(parameters.get('wrap')?.get('U')).toEqual({ name: 'U', type: refT('type_ref') });
  });

  it("a parameter grounded only by mutual template recursion ('loop => <T> loop<T>') is an unbounded type parameter, not an error", () => {
    const loop = template(
      ['T'],
      'reference',
      record({
        target: refValue({
          name: 'loop',
          arguments: [{ kind: 'ref', ref: refT('T') }],
          annotations: [],
        }),
      }),
    );
    const parameters = infer(new Map([['loop', loop]]));
    expect(parameters.get('loop')?.get('T')).toEqual({ name: 'T', type: refT('type_ref') });
  });

  it('a parameter used by no position is an unbounded type parameter', () => {
    const entries = new Map([
      ['unused', template(['T'], 'array', record({ element_type: token('text') }))],
    ]);
    expect(infer(entries).get('unused')?.get('T')).toEqual({ name: 'T', type: refT('type_ref') });
  });

  it('an imported template is taken as recorded, not walked again -- a local template passing a parameter to it inherits the recorded bound', () => {
    const imported = template(['T'], 'array', record({ element_type: token('T') }));
    const recorded: TypeDefinition = {
      ...imported,
      body: {
        ...imported.body,
        parameters: [{ name: 'T', type: refT('type_ref'), bound: refT('text') }],
      },
    };
    const wrap = template(
      ['U'],
      'reference',
      record({
        target: refValue({
          name: 'imported',
          arguments: [{ kind: 'ref', ref: refT('U') }],
          annotations: [],
        }),
      }),
    );
    const parameters = infer(
      new Map([
        ['imported', recorded],
        ['wrap', wrap],
      ]),
      { local: new Set(['wrap']), extra: new Map([['text', localType()]]) },
    );
    expect(parameters.has('imported')).toBe(false);
    expect(parameters.get('wrap')?.get('U')).toEqual({
      name: 'U',
      type: refT('type_ref'),
      bound: refT('text'),
    });
  });
});

describe('inferAll -- a written type narrows what the positions give (§5.10)', () => {
  const extra = new Map<string, TypeDefinition>([
    ['text', localType()],
    ['uint8', localType('non_negative_integer')],
    ['int8', localType('integer')],
  ]);

  it('on a type parameter it is the bound', () => {
    const entries = new Map([
      ['box', template(['T'], 'array', record({ element_type: token('T') }))],
    ]);
    const written = new Map([['box', new Map([['T', refT('text')]])]]);
    expect(infer(entries, { written, extra }).get('box')?.get('T')).toEqual({
      name: 'T',
      type: refT('type_ref'),
      bound: refT('text'),
    });
  });

  it('on a value parameter it replaces the type, and must IS-A the derived one', () => {
    const entries = new Map([
      [
        'vec',
        template(['N'], 'array', record({ element_type: token('text'), min_items: token('N') })),
      ],
    ]);
    const written = new Map([['vec', new Map([['N', refT('uint8')]])]]);
    expect(infer(entries, { written, extra }).get('vec')?.get('N')).toEqual({
      name: 'N',
      type: refT('uint8'),
    });
  });

  it('a written value type that does not IS-A the derived one is reported at the declaration', () => {
    const entries = new Map([
      [
        'vec',
        template(['N'], 'array', record({ element_type: token('text'), min_items: token('N') })),
      ],
    ]);
    const written = new Map([['vec', new Map([['N', refT('int8')]])]]);
    const reported: string[] = [];
    const result = infer(entries, {
      written,
      extra,
      reporter: {
        report(name, error): void {
          reported.push(name);
          expect(error.message).toContain('never replaces it');
        },
      },
    });
    expect(reported).toEqual(['vec']);
    expect(result.has('vec')).toBe(false);
  });

  it('a bound naming a constructor of the governing meta is refused: a bound names a type (§3.3.1)', () => {
    const entries = new Map([
      ['box', template(['T'], 'array', record({ element_type: token('T') }))],
    ]);
    const written = new Map([['box', new Map([['T', refT('array')]])]]);
    const reported: string[] = [];
    infer(entries, {
      written,
      extra,
      reporter: {
        report(_name, error): void {
          reported.push(error.message);
        },
      },
    });
    expect(reported[0]).toContain('structure vocabulary, not a type');
  });

  it('a parameter inherits the bound of the template it is passed to, and a written bound may not be wider', () => {
    const box = template(['T'], 'array', record({ element_type: token('T') }));
    const wrap = template(
      ['U'],
      'reference',
      record({
        target: refValue({
          name: 'box',
          arguments: [{ kind: 'ref', ref: refT('U') }],
          annotations: [],
        }),
      }),
    );
    const entries = new Map([
      ['box', box],
      ['wrap', wrap],
    ]);
    const bounded = infer(entries, {
      written: new Map([['box', new Map([['T', refT('uint8')]])]]),
      extra,
    });
    expect(bounded.get('wrap')?.get('U')).toEqual({
      name: 'U',
      type: refT('type_ref'),
      bound: refT('uint8'),
    });

    const reported: string[] = [];
    infer(entries, {
      written: new Map([
        ['box', new Map([['T', refT('uint8')]])],
        ['wrap', new Map([['U', refT('text')]])],
      ]),
      extra,
      reporter: {
        report(name, error): void {
          reported.push(`${name}: ${error.message}`);
        },
      },
    });
    expect(reported.some((m) => m.startsWith('wrap:') && m.includes('never widens'))).toBe(true);
  });
});

describe('inferAll -- what it refuses', () => {
  it('reports a declared entry whose parameter stands for a whole collection, at the declaration', () => {
    const bad = template(['T'], 'enum', record({ members: token('T') }));
    const reported: string[] = [];
    const parameters = infer(new Map([['bad', bad]]), {
      reporter: {
        report(name, error): void {
          reported.push(name);
          expect(error).toBeInstanceOf(TsonSchemaValidationError);
        },
      },
    });
    expect(reported).toEqual(['bad']);
    expect(parameters.has('bad')).toBe(false);
  });

  it('reports a declared entry whose parameter is used as both a type and a value parameter', () => {
    const both = template(['T'], 'both', record({ x: token('T'), y: token('T') }));
    const reported: string[] = [];
    const parameters = infer(new Map([['both', both]]), {
      reporter: {
        report(name, error): void {
          reported.push(name);
          expect(error.message).toContain('both a type position and a value position');
        },
      },
    });
    expect(reported).toEqual(['both']);
    expect(parameters.has('both')).toBe(false);
  });

  it("never reports an imported entry's own failure against this schema (`local` filters it)", () => {
    const bad = template(['T'], 'enum', record({ members: token('T') }));
    const parameters = infer(new Map([['imported_bad', bad]]), { local: new Set() });
    expect(parameters.has('imported_bad')).toBe(false);
  });

  it('skips a non-parameterised entry and one with no held body entirely', () => {
    const plain: TypeDefinition = {
      supertypes: [],
      subtypes: [],
      body: { kind: 'record', supertypes: [], fields: [], groups: [], extension: 'OPEN' },
      annotations: [],
    };
    expect(infer(new Map([['plain', plain]])).has('plain')).toBe(false);
  });
});
