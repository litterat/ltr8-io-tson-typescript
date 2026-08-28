import { describe, expect, it } from 'vitest';
import type { SchemaLocation } from '../src/core/diagnostic.js';
import type { RecordBody, RecordField } from '../src/schema/meta/bodies.js';
import { atomTreeReader, atomTypeReader } from '../src/reader/tree/atom.js';
import { recordTreeReader } from '../src/reader/tree/record.js';
import type { TypeReader } from '../src/reader/contracts.js';
import type { Value } from '../src/tree/nodes.js';
import {
  bodyContextOver,
  collectingContextOver,
  stubIntType,
  stubTextType,
} from './reader-tree-helpers.js';
import { runSync } from '../src/io/bytes.js';

/**
 * `reader/tree/record.ts` -- ported from `RecordAbstractReader`/`RecordTreeReader`. Exercised against
 * a real event stream (`stream/dataStream.ts`), never a hand-rolled event list, matching this
 * package's own `reader-context.test.ts` convention.
 */

const LOCATION: SchemaLocation = { schemaId: 'test://schema.tn', pointer: '/person' };

const TEXT_READER: TypeReader<Value> = atomTreeReader(
  atomTypeReader(stubTextType(), 'text'),
  'text',
);
const INT_READER: TypeReader<Value> = atomTreeReader(
  atomTypeReader(stubIntType(), 'int32'),
  'int32',
);

function resolve(typeName: string): TypeReader<Value> {
  if (typeName === 'text') return TEXT_READER;
  if (typeName === 'int32') return INT_READER;
  throw new Error(`unknown test type '${typeName}'`);
}

function field(
  name: string,
  type: 'text' | 'int32',
  state: RecordField['state'],
  value?: string,
): RecordField {
  return {
    name,
    type: { name: type, arguments: [], annotations: [] },
    state,
    annotations: [],
    ...(value !== undefined ? { value: { text: value, form: 'SINGLE_LINE_QUOTED' } } : {}),
  };
}

function reader(fields: RecordField[], groups: RecordBody['groups'] = []): TypeReader<Value> {
  const body: RecordBody = { kind: 'record', supertypes: [], fields, groups };
  return recordTreeReader('person', 'person', body, (f) => resolve(f.type.name), LOCATION);
}

describe('recordTreeReader -- shape (§5.2, §5.6)', () => {
  it('reads a fields-shaped record, omitting an absent OPTIONAL field and injecting a REQUIRED_DEFAULT one', () => {
    const r = reader([
      field('name', 'text', 'REQUIRED'),
      field('age', 'int32', 'OPTIONAL'),
      field('role', 'text', 'REQUIRED_DEFAULT', 'guest'),
    ]);
    const ctx = bodyContextOver('{ name: "Ada" }');
    const value = runSync(r.read(ctx));
    expect(value.kind).toBe('record');
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.typeRef).toBe('person');
    expect(value.fields.get('name')).toEqual({
      kind: 'atom',
      value: 'Ada',
      typeRef: 'text',
      annotations: { values: [] },
    });
    expect(value.fields.has('age')).toBe(false);
    expect(value.fields.get('role')).toEqual({
      kind: 'atom',
      value: 'guest',
      typeRef: 'text',
      annotations: { values: [] },
    });
  });

  it('reads `{}` as the empty record, every field falling to its own absent-field handling', () => {
    const r = reader([field('role', 'text', 'REQUIRED_DEFAULT', 'guest')]);
    const value = runSync(r.read(bodyContextOver('{}')));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.get('role')).toEqual({
      kind: 'atom',
      value: 'guest',
      typeRef: 'text',
      annotations: { values: [] },
    });
  });

  it('reads the positional form when exactly one bare REQUIRED field exists (§5.6)', () => {
    const r = reader([field('value', 'text', 'REQUIRED')]);
    const value = runSync(r.read(bodyContextOver('"hello"')));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.get('value')).toEqual({
      kind: 'atom',
      value: 'hello',
      typeRef: 'text',
      annotations: { values: [] },
    });
  });

  it('reports TYPE_MISMATCH and yields an AbsentNode when no shape matches', () => {
    const r = reader([field('name', 'text', 'REQUIRED'), field('age', 'int32', 'REQUIRED')]);
    const { ctx, diagnostics } = collectingContextOver('"not a record"');
    const value = runSync(r.read(ctx));
    expect(value.kind).toBe('absent');
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });
});

describe('recordTreeReader -- closure and duplicates (§2.5, §7.2)', () => {
  it('a missing REQUIRED field reports FIELD_REQUIRED and is left out of the tree', () => {
    const r = reader([field('name', 'text', 'REQUIRED')]);
    const { ctx, diagnostics } = collectingContextOver('{}');
    const value = runSync(r.read(ctx));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.has('name')).toBe(false);
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['FIELD_REQUIRED']);
  });

  it('a name the type does not declare reports UNRECOGNIZED_FIELD and is discarded, not held against the rest', () => {
    const r = reader([field('name', 'text', 'REQUIRED')]);
    const { ctx, diagnostics } = collectingContextOver('{ name: "Ada" nickname: "A" }');
    const value = runSync(r.read(ctx));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.get('name')).toMatchObject({ value: 'Ada' });
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['UNRECOGNIZED_FIELD']);
  });

  it('a repeated field name reports DUPLICATE_FIELD; the last occurrence wins', () => {
    const r = reader([field('name', 'text', 'REQUIRED')]);
    const { ctx, diagnostics } = collectingContextOver('{ name: "Ada" name: "Grace" }');
    const value = runSync(r.read(ctx));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.get('name')).toMatchObject({ value: 'Grace' });
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['DUPLICATE_FIELD']);
  });
});

describe('recordTreeReader -- FIXED fields (§5.2)', () => {
  it('a matching value at a REQUIRED_FIXED field is accepted silently', () => {
    const r = reader([field('tag', 'text', 'REQUIRED_FIXED', 'x')]);
    const { ctx, diagnostics } = collectingContextOver('{ tag: "x" }');
    const value = runSync(r.read(ctx));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.get('tag')).toMatchObject({ value: 'x' });
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it('a contradicting value at a REQUIRED_FIXED field reports FIELD_FIXED, and the field is left out entirely', () => {
    const r = reader([field('tag', 'text', 'REQUIRED_FIXED', 'x')]);
    const { ctx, diagnostics } = collectingContextOver('{ tag: "y" }');
    const value = runSync(r.read(ctx));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.has('tag')).toBe(false);
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['FIELD_FIXED']);
  });

  it('an omitted REQUIRED_FIXED field injects the schema value', () => {
    const r = reader([field('tag', 'text', 'REQUIRED_FIXED', 'x')]);
    const value = runSync(r.read(bodyContextOver('{}')));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.get('tag')).toMatchObject({ value: 'x' });
  });

  it('writing `_` at an OPTIONAL_FIXED-with-value field is permitted (absence is what OPTIONAL allows)', () => {
    const r = reader([field('tag', 'text', 'OPTIONAL_FIXED', 'x')]);
    const { ctx, diagnostics } = collectingContextOver('{ tag: _ }');
    const value = runSync(r.read(ctx));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.has('tag')).toBe(false);
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it('writing `_` at a REQUIRED_FIXED field reports FIELD_FIXED (§5.2: `_` is a validation error there)', () => {
    const r = reader([field('tag', 'text', 'REQUIRED_FIXED', 'x')]);
    const { ctx, diagnostics } = collectingContextOver('{ tag: _ }');
    runSync(r.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['FIELD_FIXED']);
  });
});

describe('recordTreeReader -- field groups (§5.11)', () => {
  function groupedReader(): TypeReader<Value> {
    return reader(
      [field('a', 'text', 'OPTIONAL'), field('b', 'text', 'OPTIONAL')],
      [{ members: ['a', 'b'], state: 'REQUIRED' }],
    );
  }

  it('exactly one member present satisfies a REQUIRED group', () => {
    const { ctx, diagnostics } = collectingContextOver('{ a: "x" }');
    runSync(groupedReader().read(ctx));
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it('zero members present reports FIELD_REQUIRED', () => {
    const { ctx, diagnostics } = collectingContextOver('{}');
    runSync(groupedReader().read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['FIELD_REQUIRED']);
  });

  it('more than one member present reports TYPE_MISMATCH', () => {
    const { ctx, diagnostics } = collectingContextOver('{ a: "x" b: "y" }');
    runSync(groupedReader().read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });
});

describe('recordTreeReader -- annotations (§3.1)', () => {
  it("captures the record value's own leading annotations, structurally", () => {
    const r = reader([field('name', 'text', 'REQUIRED')]);
    const value = runSync(r.read(bodyContextOver('@doc:"hi" { name: "Ada" }')));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.annotations.values).toHaveLength(1);
    const [annotation] = value.annotations.values;
    expect(annotation?.name).toBe('doc');
    expect(annotation?.value?.coreValue).toEqual({
      kind: 'token',
      text: 'hi',
      form: 'single-line',
    });
  });
});
