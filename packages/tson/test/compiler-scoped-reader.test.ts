import { describe, expect, it } from 'vitest';
import { compile, validate } from '../src/compiler/compile.js';
import type { LinkedSchema } from '../src/link/link.js';
import type { TypeDefinition } from '../src/schema/meta/typedef.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';
import { requireValue } from './reader-tree-helpers.js';

/**
 * `compiler/compile.ts`'s `scoped` reader ([TSON-SCHEMA] §7.8) -- the open sum a value's own
 * type comes from a namespace for. Exercises the data rule (value shape picks LOCAL/EXTERN/
 * neither), the `scope` membership check both cells apply, the typed-position restriction a
 * nested `!!schema` meets at every OTHER position, and `schemas`' own narrowing.
 */

const FOREIGN_ID = 'https://tson.io/test-suite/scoped-reader/claim.tn';

const FOREIGN_SCHEMA = `
!!id:"${FOREIGN_ID}"
!!meta:"https://tson.io/2026/35/m/meta.tn"
!!import:"https://tson.io/2026/35/m/core.tn"
{
  claim => {
    id: text
    amount: int32
  }
  @doc:"A second type in the same schema, so a test can name one that is not the one admitted."
  remark => {
    text: text
  }
}
`;

const HOST_SCHEMA = `
!!id:"test://scoped-reader/host.tn"
!!meta:"https://tson.io/2026/35/m/meta.tn"
!!import:"https://tson.io/2026/35/m/core.tn"
{
  note => {
    body: text
  }

  envelope => {
    local:   declared
    foreign: extern
    either:  dynamic
    closed:  int32
  }
}
`;

const foreign = resolveUserSchema(FOREIGN_SCHEMA);
const host = resolveUserSchema(HOST_SCHEMA);

function compileHost(withForeign: boolean): ReturnType<typeof compile> {
  return compile(
    host,
    withForeign ? { foreignSchemas: (uri) => (uri === FOREIGN_ID ? foreign : undefined) } : {},
  );
}

describe('scoped reader -- the data rule (§7.8)', () => {
  it('LOCAL: a value naming a type in the governing namespace validates in full', () => {
    const compiled = compileHost(true);
    const bytes = new TextEncoder().encode(
      '{ local: !note { body: "hi" } foreign: !!schema:"' +
        FOREIGN_ID +
        '" !claim { id: "C1" amount: 1 } either: !note { body: "x" } closed: 1 }',
    );
    const result = validate(compiled, 'envelope', bytes);
    expect(result.diagnostics).toEqual([]);
    const value = requireValue(result);
    const local = value.kind === 'record' ? value.fields.get('local') : undefined;
    expect(local).toMatchObject({ kind: 'record', typeRef: 'note' });
  });

  it('EXTERN: a value carrying !!schema is read in full against the foreign schema it names', () => {
    const compiled = compileHost(true);
    const bytes = new TextEncoder().encode(
      '{ local: !note { body: "x" } ' +
        'foreign: !!schema:"' +
        FOREIGN_ID +
        '" !claim { id: "CLM-1" amount: 42 } ' +
        'either: !note { body: "x" } closed: 1 }',
    );
    const result = validate(compiled, 'envelope', bytes);
    expect(result.diagnostics).toEqual([]);
    const value = requireValue(result);
    const foreignField = value.kind === 'record' ? value.fields.get('foreign') : undefined;
    expect(foreignField).toMatchObject({
      kind: 'record',
      typeRef: 'claim',
      fields: new Map([
        ['id', { kind: 'atom', value: 'CLM-1' }],
        ['amount', { kind: 'atom', value: 42 }],
      ]),
    });
  });

  it('neither: a scoped value naming no type is a validation error, not a resolver one', () => {
    const compiled = compileHost(true);
    const bytes = new TextEncoder().encode(
      '{ local: { body: "no type-ref" } ' +
        'foreign: !!schema:"' +
        FOREIGN_ID +
        '" !claim { id: "C1" amount: 1 } either: !note { body: "x" } closed: 1 }',
    );
    const result = validate(compiled, 'envelope', bytes);
    const problem = result.diagnostics.find((d) => d.path === '/local');
    expect(problem?.code).toBe('VALIDATION_ERROR');
  });

  it('dynamic admits both a LOCAL and an EXTERN value in the same field', () => {
    const compiled = compileHost(true);
    const localBytes = new TextEncoder().encode(
      '{ local: !note { body: "x" } foreign: !!schema:"' +
        FOREIGN_ID +
        '" !claim { id: "C1" amount: 1 } either: !note { body: "local either" } closed: 1 }',
    );
    expect(validate(compiled, 'envelope', localBytes).diagnostics).toEqual([]);

    const externBytes = new TextEncoder().encode(
      '{ local: !note { body: "x" } foreign: !!schema:"' +
        FOREIGN_ID +
        '" !claim { id: "C1" amount: 1 } either: !!schema:"' +
        FOREIGN_ID +
        '" !remark { text: "extern either" } closed: 1 }',
    );
    expect(validate(compiled, 'envelope', externBytes).diagnostics).toEqual([]);
  });
});

describe('scoped reader -- scope membership (§7.8)', () => {
  it('declared (scope: [LOCAL]) refuses a pushed scope even onto a schema it never named', () => {
    const compiled = compileHost(true);
    const bytes = new TextEncoder().encode(
      '{ local: !!schema:"' +
        FOREIGN_ID +
        '" !claim { id: "C1" amount: 1 } foreign: !!schema:"' +
        FOREIGN_ID +
        '" !claim { id: "C1" amount: 1 } either: !note { body: "x" } closed: 1 }',
    );
    const result = validate(compiled, 'envelope', bytes);
    const problem = result.diagnostics.find((d) => d.path === '/local');
    expect(problem?.code).toBe('VALIDATION_ERROR');
  });

  it('extern (scope: [EXTERN]) refuses a value that never opens a scope', () => {
    const compiled = compileHost(true);
    const bytes = new TextEncoder().encode(
      '{ local: !note { body: "x" } foreign: !note { body: "governing-namespace type" } ' +
        'either: !note { body: "x" } closed: 1 }',
    );
    const result = validate(compiled, 'envelope', bytes);
    const problem = result.diagnostics.find((d) => d.path === '/foreign');
    expect(problem?.code).toBe('VALIDATION_ERROR');
  });
});

describe('scoped reader -- typed-position restriction, derived structurally (§7.8)', () => {
  it('a nested !!schema at a non-scoped position is refused, and the whole read is abandoned (WP3B)', () => {
    const compiled = compileHost(true);
    const bytes = new TextEncoder().encode(
      '{ local: !note { body: "x" } foreign: !!schema:"' +
        FOREIGN_ID +
        '" !claim { id: "C1" amount: 1 } either: !note { body: "x" } closed: !!schema:"' +
        FOREIGN_ID +
        '" 1 }',
    );
    const result = validate(compiled, 'envelope', bytes);
    const problem = result.diagnostics.find((d) => d.path === '/closed');
    expect(problem?.code).toBe('VALIDATION_ERROR');
    // A read is all-or-nothing (WP3B): the refusal at '/closed' means no partial 'envelope' to
    // mistake for a valid one, not a record with every other field intact.
    expect(result.value).toBeUndefined();
  });
});

describe('scoped reader -- the foreign-schema lookup seam', () => {
  it('reports SCHEMA_NOT_PERMITTED when the compile carries no foreign-schema lookup at all', () => {
    const compiled = compileHost(false);
    const bytes = new TextEncoder().encode(
      '{ local: !note { body: "x" } foreign: !!schema:"' +
        FOREIGN_ID +
        '" !claim { id: "C1" amount: 1 } either: !note { body: "x" } closed: 1 }',
    );
    const result = validate(compiled, 'envelope', bytes);
    const problem = result.diagnostics.find((d) => d.path === '/foreign');
    expect(problem?.code).toBe('SCHEMA_NOT_PERMITTED');
  });

  it('reports SCHEMA_NOT_FOUND when the named schema is not registered with this lookup', () => {
    const compiled = compile(host, { foreignSchemas: () => undefined });
    const bytes = new TextEncoder().encode(
      '{ local: !note { body: "x" } foreign: !!schema:"' +
        FOREIGN_ID +
        '" !claim { id: "C1" amount: 1 } either: !note { body: "x" } closed: 1 }',
    );
    const result = validate(compiled, 'envelope', bytes);
    const problem = result.diagnostics.find((d) => d.path === '/foreign');
    expect(problem?.code).toBe('SCHEMA_NOT_FOUND');
  });
});

// A hand-built `Scoped` body (no resolver/linker involved, matching `compiler-compile.test.ts`'s
// own `linkedSchema` pattern) -- narrows `schemas` directly, decoupled from whether a `<S, T>`
// template application resolves to one (`extern_of`/`extern_type` themselves, §5.10's own
// materialisation, are a different package's own concern this stage does not touch).
function narrowingSchema(): LinkedSchema {
  const entries = new Map<string, TypeDefinition>([
    [
      'narrow_scope',
      {
        supertypes: [],
        subtypes: [],
        annotations: [],
        body: { kind: 'scoped', scope: ['EXTERN'], schemas: new Map([[FOREIGN_ID, ['claim']]]) },
      },
    ],
    [
      'attachment_holder',
      {
        supertypes: [],
        subtypes: [],
        annotations: [],
        body: {
          kind: 'record',
          supertypes: [],
          groups: [],
          extension: 'OPEN',
          discriminators: [],
          fields: [
            {
              name: 'attachment',
              type: { name: 'narrow_scope', arguments: [], annotations: [] },
              optional: false,
              voidable: false,
              role: 'FREE',
              annotations: [],
            },
          ],
        },
      },
    ],
  ]);
  return {
    id: 'test://scoped-reader/narrowing.tn',
    meta: 'test://m.tn',
    imports: [],
    entries,
    keyAnnotations: new Map(),
    bootstrap: false,
    origins: new Map(
      [...entries.keys()].map((name) => [name, 'test://scoped-reader/narrowing.tn']),
    ),
  };
}

describe('scoped reader -- schemas narrows the foreign namespace (§7.8)', () => {
  const narrowed = narrowingSchema();

  it('admits the one named type of the one named schema', () => {
    const compiled = compile(narrowed, {
      foreignSchemas: (uri) => (uri === FOREIGN_ID ? foreign : undefined),
    });
    const bytes = new TextEncoder().encode(
      '{ attachment: !!schema:"' + FOREIGN_ID + '" !claim { id: "C1" amount: 1 } }',
    );
    const result = validate(compiled, 'attachment_holder', bytes);
    expect(result.diagnostics).toEqual([]);
  });

  it('refuses a type of that schema outside the narrowed list', () => {
    const compiled = compile(narrowed, {
      foreignSchemas: (uri) => (uri === FOREIGN_ID ? foreign : undefined),
    });
    const bytes = new TextEncoder().encode(
      '{ attachment: !!schema:"' + FOREIGN_ID + '" !remark { text: "not claim" } }',
    );
    const result = validate(compiled, 'attachment_holder', bytes);
    const problem = result.diagnostics.find((d) => d.path === '/attachment');
    expect(problem?.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a schema outside the narrowed set entirely', () => {
    const compiled = compile(narrowed, {
      foreignSchemas: (uri) => (uri === FOREIGN_ID ? foreign : undefined),
    });
    const bytes = new TextEncoder().encode(
      '{ attachment: !!schema:"https://tson.io/test-suite/scoped-reader/other.tn" !claim { id: "C1" amount: 1 } }',
    );
    const result = validate(compiled, 'attachment_holder', bytes);
    const problem = result.diagnostics.find((d) => d.path === '/attachment');
    expect(problem?.code).toBe('VALIDATION_ERROR');
  });
});
