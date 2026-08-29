import { describe, expect, it } from 'vitest';
import type { LinkedSchema } from '../src/link/link.js';
import type { TypeDefinition } from '../src/schema/meta/typedef.js';
import { compile, read, readValue, validate } from '../src/compiler/compile.js';
import { TsonInternalError } from '../src/core/errors.js';
import { fromString, runSync } from '../src/io/bytes.js';
import { collector } from '../src/core/diagnostic.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

/**
 * `compiler/compile.ts` -- Work package 17's own whole-schema `name -> reader` table and the two
 * whole-document entry points built over it.
 */

// ── A hand-built, cyclic LinkedSchema (no resolver/linker involved) ───────────────────────────

function linkedSchema(entries: ReadonlyMap<string, TypeDefinition>): LinkedSchema {
  return {
    id: 'test://s.tn',
    meta: 'test://m.tn',
    imports: [],
    entries,
    keyAnnotations: new Map(),
    bootstrap: false,
    origins: new Map([...entries.keys()].map((name) => [name, 'test://s.tn'])),
  };
}

const CYCLIC_SCHEMA = linkedSchema(
  new Map<string, TypeDefinition>([
    [
      'text',
      {
        kind: 'ATOM',
        parameters: [],
        constructor: false,
        supertypes: [],
        subtypes: [],
        annotations: [],
        body: { kind: 'text_type' },
      },
    ],
    [
      'node',
      {
        kind: 'PRODUCT',
        parameters: [],
        constructor: false,
        supertypes: [],
        subtypes: [],
        annotations: [],
        body: {
          kind: 'record',
          supertypes: [],
          groups: [],
          fields: [
            {
              name: 'value',
              type: { name: 'text', arguments: [], annotations: [] },
              state: 'REQUIRED',
              annotations: [],
            },
            {
              name: 'next',
              type: { name: 'node', arguments: [], annotations: [] },
              state: 'OPTIONAL',
              annotations: [],
            },
          ],
        },
      },
    ],
  ]),
);

describe('compile -- cycles resolve by tying the knot', () => {
  it('compiles a self-referential record and reads a nested chain of it', () => {
    const compiled = compile(CYCLIC_SCHEMA);
    const value = read(
      compiled,
      'node',
      new TextEncoder().encode('{ value: "a" next: { value: "b" next: _ } }'),
    );
    expect(value).toEqual({
      kind: 'record',
      typeRef: 'node',
      annotations: { values: [] },
      fields: new Map([
        ['value', { kind: 'atom', value: 'a', typeRef: 'text', annotations: { values: [] } }],
        [
          'next',
          {
            kind: 'record',
            typeRef: 'node',
            annotations: { values: [] },
            fields: new Map([
              ['value', { kind: 'atom', value: 'b', typeRef: 'text', annotations: { values: [] } }],
            ]),
          },
        ],
      ]),
    });
  });

  it('asking for the same cyclic entry twice returns the identical compiled reader', () => {
    const compiled = compile(CYCLIC_SCHEMA);
    expect(compiled.reader('node')).toBe(compiled.reader('node'));
  });

  it("throws TsonInternalError for a name absent from the schema's own linked namespace", () => {
    const compiled = compile(CYCLIC_SCHEMA);
    expect(() => compiled.reader('nowhere')).toThrow(TsonInternalError);
  });
});

describe('validate -- collects diagnostics rather than throwing', () => {
  it('reports FIELD_REQUIRED, naming the field, when a required field is missing', () => {
    const compiled = compile(CYCLIC_SCHEMA);
    const result = validate(compiled, 'node', new TextEncoder().encode('{ next: _ }'));
    expect(result.diagnostics.map((d) => d.code)).toEqual(['FIELD_REQUIRED']);
    expect(result.diagnostics[0]?.path).toBe('/value');
  });

  it('trailing content past the root value is already rejected by the event stream itself (§7.4), before document-end framing is ever reached', () => {
    const compiled = compile(CYCLIC_SCHEMA);
    const diagnostics = collector();
    expect(() =>
      runSync(readValue(compiled, 'node', fromString('{ value: "a" next: _ } extra'), diagnostics)),
    ).toThrow(/unexpected content after the document's value/);
  });
});

// ── A user schema importing the real, vendored core.tn ────────────────────────────────────────

const USER_SCHEMA = `
!!id:"test://person.tn"
!!meta:"https://tson.io/2026/34/m/meta.tn"
!!import:"https://tson.io/2026/34/m/core.tn"
{
  person => {
    name: text
    age: int32
    active: boolean
    tags: [text]
  }
}
`;

describe('compile against a real, resolved+linked user schema importing core.tn', () => {
  it('compiles and validates a conforming document, producing the values the document carries', () => {
    const linked = resolveUserSchema(USER_SCHEMA);
    const compiled = compile(linked);
    const bytes = new TextEncoder().encode(
      '{ name: "Ada Lovelace" age: 36 active: true tags: ["mathematics" "computing"] }',
    );
    const result = validate(compiled, 'person', bytes);
    expect(result.diagnostics).toEqual([]);
    expect(result.value).toMatchObject({
      kind: 'record',
      typeRef: 'person',
      fields: new Map([
        ['name', { kind: 'atom', value: 'Ada Lovelace' }],
        ['age', { kind: 'atom', value: 36 }],
        ['active', { kind: 'atom', value: true }], // §9's boolean enum narrows to a real host boolean
        [
          'tags',
          {
            kind: 'array',
            elements: [
              { kind: 'atom', value: 'mathematics' },
              { kind: 'atom', value: 'computing' },
            ],
          },
        ],
      ]),
    });
  });

  it('rejects non-conforming data with a diagnostic naming the field, the position, and the type it violated', () => {
    const linked = resolveUserSchema(USER_SCHEMA);
    const compiled = compile(linked);
    // `age` is out of int32's range, and `active` is not a boolean-enum member at all.
    const bytes = new TextEncoder().encode(
      '{ name: "Ada" age: 99999999999 active: "yes" tags: [] }',
    );
    const result = validate(compiled, 'person', bytes);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    const ageProblem = result.diagnostics.find((d) => d.path === '/age');
    expect(ageProblem?.code).toBe('ATOM_CONSTRAINT_VIOLATION');
    expect(ageProblem?.dataPosition).toBeDefined();
    const activeProblem = result.diagnostics.find((d) => d.path === '/active');
    expect(activeProblem?.code).toBe('ATOM_CONSTRAINT_VIOLATION');
  });

  it('rejects a missing required field, naming it', () => {
    const linked = resolveUserSchema(USER_SCHEMA);
    const compiled = compile(linked);
    const bytes = new TextEncoder().encode('{ name: "Ada" active: true tags: [] }');
    const result = validate(compiled, 'person', bytes);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: 'FIELD_REQUIRED', path: '/age' });
  });
});
