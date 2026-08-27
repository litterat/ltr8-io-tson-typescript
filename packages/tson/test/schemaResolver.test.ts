import { describe, expect, it } from 'vitest';

import { fromString, runSync } from '../src/io/bytes.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';
import { collector } from '../src/core/diagnostic.js';
import {
  TsonInternalError,
  TsonNotImplementedError,
  TsonSchemaValidationError,
} from '../src/core/errors.js';
import {
  resolveSchema,
  type ImportedSchema,
  type Schema,
  type SchemaResolverDeps,
} from '../src/compiler/schemaResolver.js';
import type { DataValue, RecordValue, TokenValue } from '../src/ast/value.js';
import type { SchemaDocument } from '../src/ast/schema/document.js';
import type { ArrayBody, RecordBody, RecordField } from '../src/schema/meta/bodies.js';
import type { Top, TypeDefinition, TypeRef } from '../src/schema/meta/typedef.js';

// ── Parsing helper ───────────────────────────────────────────────────────────────────────────

function parse(header: string, declarations: string): SchemaDocument {
  return runSync(parseSchemaDocument(fromString(`${header} { ${declarations} }`)));
}

/** The common case: one meta, no imports, `!!id` present -- every declaration text is the caller's own. */
function document(declarations: string, id = 'https://example.com/s.tn1'): SchemaDocument {
  return parse(`!!id:"${id}" !!meta:"https://example.com/m.tn1"`, declarations);
}

// ── A minimal hand-rolled reader for `record`/`array` binding records ──────────────────────────
//
// Just enough of `definitionMetaReader`'s contract to bind what `definitionResolver.ts`/
// `templates.ts` actually hand it in these tests: the wire shapes `desugar.ts` and `heldBody.ts`
// themselves produce for a fresh record body and an array sugar lift. Not a stand-in for a real
// compiled reader (no field-level validation, no defaults) -- this package's own conformance
// suite exercises the real thing; this file only has to prove `schemaResolver.ts`'s own driving
// logic, which is agnostic to how a value gets bound.

function fieldOf(record: RecordValue, name: string): DataValue | undefined {
  return record.fields.find((f) => f.name === name)?.value.value;
}

function typeRefField(record: RecordValue, name: string): TypeRef {
  const value = fieldOf(record, name)?.coreValue;
  if (value === undefined) throw new Error(`missing '${name}'`);
  if (value.kind === 'token') return { name: value.text, arguments: [], annotations: [] };
  throw new Error(`unsupported type_ref wire shape for '${name}'`);
}

function testMetaReader(type: string, value: DataValue): Top {
  const record = value.coreValue as RecordValue;
  if (type === 'record') {
    const fieldsField = fieldOf(record, 'fields')?.coreValue;
    const fields: RecordField[] = [];
    if (fieldsField?.kind === 'array') {
      for (const element of fieldsField.elements) {
        const fieldRecord = element.value.coreValue as RecordValue;
        const name = (fieldOf(fieldRecord, 'name')?.coreValue as TokenValue).text;
        fields.push({
          name,
          type: typeRefField(fieldRecord, 'type'),
          state: 'REQUIRED',
          annotations: [],
        });
      }
    }
    return { kind: 'record', supertypes: [], fields, groups: [] } satisfies RecordBody;
  }
  if (type === 'array') {
    return {
      kind: 'array',
      elementType: typeRefField(record, 'element_type'),
      state: 'REQUIRED',
      unordered: false,
      uniqueItems: false,
    } satisfies ArrayBody;
  }
  throw new Error(`testMetaReader: unhandled constructor '${type}'`);
}

const neverCalled = (type: string): Top => {
  throw new Error(`not exercised by this test: '${type}'`);
};

/**
 * A structure namespace with the two constructors these tests' sugar/template forms apply --
 * enough vocabulary for `checkTemplateBindings` (§5.10's own declaration-time check) and
 * `testMetaReader` to have somewhere to bind them, mirroring the real `record`/`array` shapes
 * `spec/m/meta-kernel-resolved.tn` declares (`heldBody.ts`'s own `RECORD`/`ARRAY` wire fields).
 */
function testStructureNamespace(): (name: string) => TypeDefinition | undefined {
  const anyType: TypeRef = { name: 'any', arguments: [], annotations: [] };
  const constructorEntry = (fields: readonly RecordField[]): TypeDefinition => ({
    kind: 'PRODUCT',
    parameters: [],
    constructor: true,
    supertypes: [],
    subtypes: [],
    body: { kind: 'record', supertypes: [], fields, groups: [] },
    annotations: [],
  });
  const structure = new Map<string, TypeDefinition>([
    [
      'record',
      constructorEntry([{ name: 'fields', type: anyType, state: 'REQUIRED', annotations: [] }]),
    ],
    [
      'array',
      constructorEntry([
        { name: 'element_type', type: anyType, state: 'REQUIRED', annotations: [] },
      ]),
    ],
  ]);
  return (name) => structure.get(name);
}

function deps(overrides: Partial<SchemaResolverDeps> = {}): SchemaResolverDeps {
  return {
    definitionMetaReader: overrides.definitionMetaReader ?? neverCalled,
    metaDefinitions: overrides.metaDefinitions ?? (() => undefined),
    ...(overrides.annotationValueReader === undefined
      ? {}
      : { annotationValueReader: overrides.annotationValueReader }),
    ...(overrides.encodeSourceBody === undefined
      ? {}
      : { encodeSourceBody: overrides.encodeSourceBody }),
    ...(overrides.resolveImport === undefined ? {} : { resolveImport: overrides.resolveImport }),
  };
}

/** `deps()` plus a working `record`/`array` reader and structure namespace -- what every sugar/template test in this file needs. */
function depsWithReader(): SchemaResolverDeps {
  return deps({ definitionMetaReader: testMetaReader, metaDefinitions: testStructureNamespace() });
}

function isRecordBody(body: Top): body is RecordBody {
  return 'fields' in body;
}

function entryOf(schema: Schema, name: string): TypeDefinition {
  const entry = schema.entries.get(name);
  if (entry === undefined) throw new Error(`resolved schema has no entry '${name}'`);
  return entry;
}

function recordBodyOf(schema: Schema, name: string): RecordBody {
  const body = entryOf(schema, name).body;
  if (!isRecordBody(body)) throw new Error(`'${name}' is not record-shaped`);
  return body;
}

function fieldTypeOf(schema: Schema, name: string, field: string): TypeRef {
  const found = recordBodyOf(schema, name).fields.find((f) => f.name === field);
  if (found === undefined) throw new Error(`'${name}' has no field '${field}'`);
  return found.type;
}

// ── !!id / header handling ───────────────────────────────────────────────────────────────────

describe('!!id and header handling', () => {
  it('throws TsonSchemaValidationError when !!id is absent', () => {
    const doc = parse('!!meta:"https://example.com/m.tn1"', 'x => { v: text }');
    expect(() => resolveSchema(doc, deps())).toThrow(TsonSchemaValidationError);
  });

  it('carries !!id/!!meta/!!import straight through to the result', () => {
    const doc = parse(
      '!!id:"https://example.com/s.tn1" !!meta:"https://example.com/m.tn1" ' +
        '!!import:"https://example.com/i.tn1"',
      'x => { v: text }',
    );
    const schema = resolveSchema(
      doc,
      deps({
        resolveImport: (): ImportedSchema => ({
          entries: new Map(),
          originOf: () => 'https://example.com/i.tn1',
        }),
      }),
    );
    expect(schema.id).toBe('https://example.com/s.tn1');
    expect(schema.meta).toBe('https://example.com/m.tn1');
    expect(schema.imports).toEqual(['https://example.com/i.tn1']);
    expect(schema.bootstrap).toBe(false);
  });
});

// ── The driving loop: dependency order, not source order (§3.4.1) ──────────────────────────────

describe('resolving a whole document, on demand and dependency-following', () => {
  it('resolves a composition supertype declared LATER in the same schema', () => {
    const doc = document('child => parent & { y: text } parent => { x: text }');
    const schema = resolveSchema(doc, deps());
    expect(schema.entries.size).toBe(2);
    const child = recordBodyOf(schema, 'child');
    expect(child.fields.map((f) => f.name).sort()).toEqual(['x', 'y']);
    expect(child.supertypes).toEqual(['parent']);
  });

  it('resolves every declaration exactly once, however many others depend on it', () => {
    const doc = document('a => base & {} b => base & {} base => { x: text }');
    const schema = resolveSchema(doc, deps());
    expect(schema.entries.size).toBe(3);
    expect(recordBodyOf(schema, 'a').supertypes).toEqual(['base']);
    expect(recordBodyOf(schema, 'b').supertypes).toEqual(['base']);
  });

  it('rejects a circular composition chain', () => {
    const doc = document('a => b & {} b => a & {}');
    expect(() => resolveSchema(doc, deps())).toThrow(/circular/);
    expect(() => resolveSchema(doc, deps())).toThrow(TsonSchemaValidationError);
  });

  it('rejects a composition supertype naming nothing this schema declares', () => {
    const doc = document('a => nowhere & {}');
    expect(() => resolveSchema(doc, deps())).toThrow(TsonSchemaValidationError);
  });
});

// ── !!import merging ─────────────────────────────────────────────────────────────────────────

describe('!!import merging into the type-name namespace', () => {
  it('lets a local declaration compose with an imported one', () => {
    const imported = new Map<string, TypeDefinition>([
      [
        'base',
        {
          kind: 'PRODUCT',
          parameters: [],
          constructor: false,
          supertypes: [],
          subtypes: [],
          body: { kind: 'record', supertypes: [], fields: [], groups: [] },
          annotations: [],
        },
      ],
    ]);
    const doc = parse(
      '!!id:"https://example.com/s.tn1" !!meta:"https://example.com/m.tn1" ' +
        '!!import:"https://example.com/i.tn1"',
      'child => base & { y: text }',
    );
    const schema = resolveSchema(
      doc,
      deps({
        resolveImport: (uri): ImportedSchema => {
          expect(uri).toBe('https://example.com/i.tn1');
          return { entries: imported, originOf: () => uri };
        },
      }),
    );
    expect(recordBodyOf(schema, 'child').supertypes).toEqual(['base']);
    // Imported entries are visible during resolution but never part of the local-only result.
    expect(schema.entries.has('base')).toBe(false);
  });

  it('rejects a local declaration colliding with an imported name', () => {
    const imported = new Map<string, TypeDefinition>([
      [
        'base',
        {
          kind: 'PRODUCT',
          parameters: [],
          constructor: false,
          supertypes: [],
          subtypes: [],
          body: { kind: 'record', supertypes: [], fields: [], groups: [] },
          annotations: [],
        },
      ],
    ]);
    const doc = parse(
      '!!id:"https://example.com/s.tn1" !!meta:"https://example.com/m.tn1" ' +
        '!!import:"https://example.com/i.tn1"',
      'base => { x: text }',
    );
    expect(() =>
      resolveSchema(
        doc,
        deps({
          resolveImport: (uri): ImportedSchema => ({ entries: imported, originOf: () => uri }),
        }),
      ),
    ).toThrow(TsonSchemaValidationError);
  });

  it('reports TsonNotImplementedError for a document that writes !!import with no loader supplied', () => {
    const doc = parse(
      '!!id:"https://example.com/s.tn1" !!meta:"https://example.com/m.tn1" ' +
        '!!import:"https://example.com/i.tn1"',
      'x => { v: text }',
    );
    expect(() => resolveSchema(doc, deps())).toThrow(TsonNotImplementedError);
  });
});

// ── Collecting mode: a receiver lets every other declaration still resolve ─────────────────────

describe('collecting mode (a DiagnosticsReceiver in options)', () => {
  it('fails fast with no receiver: the first bad declaration throws and nothing is returned', () => {
    const doc = document('bad => nowhere & {} good => { x: text }');
    expect(() => resolveSchema(doc, deps())).toThrow(TsonSchemaValidationError);
  });

  it('with a receiver, reports the bad declaration and still resolves the rest', () => {
    const doc = document('bad => nowhere & {} good => { x: text }');
    const receiver = collector();
    const schema = resolveSchema(doc, deps(), { receiver });
    expect(receiver.diagnostics).toHaveLength(1);
    expect(receiver.diagnostics[0]?.code).toBe('SCHEMA_ERROR');
    expect(receiver.diagnostics[0]?.schemaPointer).toBe('/bad');
    // `good` resolved cleanly despite `bad`'s failure.
    expect(recordBodyOf(schema, 'good').fields.map((f) => f.name)).toEqual(['x']);
    // `bad` is present as an absorbing placeholder, not missing.
    expect(schema.entries.has('bad')).toBe(true);
    expect(recordBodyOf(schema, 'bad').fields).toEqual([]);
  });
});

// ── §5.3 sugar lift and the @synthetic key marker (§8.2) ────────────────────────────────────────

describe('a sugar form lifts to a synthetic entry, marked @synthetic at its key', () => {
  it('desugars [text] to a synthetic array instance and marks only that key', () => {
    const doc = document('wrapper => { v: [text] }');
    const schema = resolveSchema(doc, depsWithReader());
    expect(schema.entries.size).toBe(2); // wrapper + one lifted array entry
    const fieldType = fieldTypeOf(schema, 'wrapper', 'v');
    const synthetic = entryOf(schema, fieldType.name);
    expect(synthetic.source).toEqual({ name: 'array', arguments: [], annotations: [] });
    expect(schema.keyAnnotations.get(fieldType.name)).toEqual([{ name: 'synthetic' }]);
    // The author's own declaration carries no @synthetic marker.
    expect(schema.keyAnnotations.has('wrapper')).toBe(false);
  });
});

// ── §5.10 template materialisation, wired through the real templates.ts ────────────────────────

describe('template materialisation (§5.10), end to end through the real TemplateMaterialiser', () => {
  it('closes text_box => box<text> to the instantiation entry a record template denotes', () => {
    const doc = document('box => <T> { v: T } text_box => box<text>');
    const schema = resolveSchema(doc, depsWithReader());
    // `box` itself stays a template (it is still open, with a parameter list).
    expect(entryOf(schema, 'box').parameters).toEqual(['T']);
    // `text_box` is a REFERENCE onto whatever entry the application closed to.
    const alias = entryOf(schema, 'text_box');
    expect(alias.kind).toBe('REFERENCE');
    const target = (alias.body as { readonly target: TypeRef }).target;
    const instantiation = entryOf(schema, target.name);
    expect(instantiation.source).toEqual({
      name: 'box',
      arguments: [{ kind: 'ref', ref: { name: 'text', arguments: [], annotations: [] } }],
      annotations: [],
    });
    expect(fieldTypeOf(schema, target.name, 'v').name).toBe('text');
  });

  it('closes a composition supertype that is a closed generic application on demand, during resolution', () => {
    const doc = document('box => <T> { v: T } wrapped => box<text> & { w: text }');
    const schema = resolveSchema(doc, depsWithReader());
    const wrapped = recordBodyOf(schema, 'wrapped');
    // Absorbed box<text>'s own field (v: text) plus wrapped's own (w: text).
    expect(wrapped.fields.map((f) => f.name).sort()).toEqual(['v', 'w']);
  });

  it('rejects head abstraction -- a type parameter applied to arguments (§5.10)', () => {
    const doc = document('bad => <T> { v: T<text> }');
    expect(() => resolveSchema(doc, depsWithReader())).toThrow(TsonSchemaValidationError);
  });
});

// ── Small internal-consistency guard ────────────────────────────────────────────────────────

describe('an internal invariant', () => {
  it('never lets a plain TsonInternalError escape as a schema verdict for these ordinary documents', () => {
    const doc = document('a => { x: text }');
    expect(() => resolveSchema(doc, deps())).not.toThrow(TsonInternalError);
  });
});
