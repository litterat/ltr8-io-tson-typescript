import { describe, expect, it } from 'vitest';
import type { SchemaLocation } from '../src/core/diagnostic.js';
import type { FieldRole, RecordBody, RecordField } from '../src/schema/meta/bodies.js';
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

/** `marks` are §5.2's three independent facts: `optional` (the name's `?`), `voidable` (the type's `?`), `role` (the modifier). */
function field(
  name: string,
  type: 'text' | 'int32',
  marks: { optional?: boolean; voidable?: boolean; role?: FieldRole } = {},
  value?: string,
): RecordField {
  return {
    name,
    type: { name: type, arguments: [], annotations: [] },
    optional: marks.optional ?? false,
    voidable: marks.voidable ?? false,
    role: marks.role ?? 'FREE',
    annotations: [],
    ...(value !== undefined ? { value: { text: value, form: 'SINGLE_LINE_QUOTED' } } : {}),
  };
}

function reader(fields: RecordField[], groups: RecordBody['groups'] = []): TypeReader<Value> {
  const body: RecordBody = {
    kind: 'record',
    supertypes: [],
    fields,
    groups,
    extension: 'OPEN',
    discriminators: [],
  };
  return recordTreeReader(
    'person',
    'person',
    body,
    (f) => resolve(f.type.name),
    LOCATION,
    () => false,
  );
}

describe('recordTreeReader -- shape (§5.2, §5.6)', () => {
  it('reads a fields-shaped record, omitting an absent (optional, FREE) field and injecting a (optional, DEFAULT) one', () => {
    const r = reader([
      field('name', 'text'),
      field('age', 'int32', { optional: true }),
      field('role', 'text', { optional: true, role: 'DEFAULT' }, 'guest'),
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
    const r = reader([field('role', 'text', { optional: true, role: 'DEFAULT' }, 'guest')]);
    const value = runSync(r.read(bodyContextOver('{}')));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.get('role')).toEqual({
      kind: 'atom',
      value: 'guest',
      typeRef: 'text',
      annotations: { values: [] },
    });
  });

  it('reads the positional form when exactly one field has an unmarked name, whatever its modifier (§5.6)', () => {
    const r = reader([field('value', 'text')]);
    const value = runSync(r.read(bodyContextOver('"hello"')));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.get('value')).toEqual({
      kind: 'atom',
      value: 'hello',
      typeRef: 'text',
      annotations: { values: [] },
    });
  });

  it('a required, voidable field written `_` (§2.9) is present as an AbsentNode -- the key is still required (§5.2)', () => {
    const r = reader([field('name', 'text'), field('age', 'int32', { voidable: true })]);
    const stated = runSync(r.read(bodyContextOver('{ name: "Ada" age: _ }')));
    if (stated.kind !== 'record') throw new Error('unreachable');
    expect(stated.fields.has('age')).toBe(true);
    expect(stated.fields.get('age')).toEqual({ kind: 'absent', annotations: { values: [] } });
    const { ctx, diagnostics } = collectingContextOver('{ name: "Ada" }');
    runSync(r.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['FIELD_REQUIRED']);
  });

  it('an optional, voidable field: omitted is absence, written `_` is also absence, distinct from one never written', () => {
    const r = reader([
      field('name', 'text'),
      field('age', 'int32', { optional: true, voidable: true }),
    ]);
    const stated = runSync(r.read(bodyContextOver('{ name: "Ada" age: _ }')));
    const omitted = runSync(r.read(bodyContextOver('{ name: "Ada" }')));
    if (stated.kind !== 'record' || omitted.kind !== 'record') throw new Error('unreachable');
    expect(stated.fields.has('age')).toBe(true);
    expect(stated.fields.get('age')).toEqual({ kind: 'absent', annotations: { values: [] } });
    expect(omitted.fields.has('age')).toBe(false);
  });

  it('a non-voidable optional field written `_` is refused (§5.2: "a written `_` at a field that is not voidable is a validation error")', () => {
    const r = reader([field('name', 'text'), field('nickname', 'text', { optional: true })]);
    const { ctx, diagnostics } = collectingContextOver('{ name: "Ada" nickname: _ }');
    const value = runSync(r.read(ctx));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.has('nickname')).toBe(false);
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });

  it('a non-voidable required field written `_` is refused, distinctly from the missing-field error', () => {
    const r = reader([field('name', 'text'), field('age', 'int32')]);
    const { ctx, diagnostics } = collectingContextOver('{ name: "Ada" age: _ }');
    runSync(r.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });

  it('reports TYPE_MISMATCH and yields an AbsentNode when no shape matches', () => {
    const r = reader([field('name', 'text'), field('age', 'int32')]);
    const { ctx, diagnostics } = collectingContextOver('"not a record"');
    const value = runSync(r.read(ctx));
    expect(value.kind).toBe('absent');
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });
});

describe('recordTreeReader -- closure and duplicates (§2.5, §7.2)', () => {
  it('a missing unmarked-name field reports FIELD_REQUIRED and is left out of the tree', () => {
    const r = reader([field('name', 'text')]);
    const { ctx, diagnostics } = collectingContextOver('{}');
    const value = runSync(r.read(ctx));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.has('name')).toBe(false);
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['FIELD_REQUIRED']);
  });

  it('a name the type does not declare reports UNRECOGNIZED_FIELD and is discarded, not held against the rest', () => {
    const r = reader([field('name', 'text')]);
    const { ctx, diagnostics } = collectingContextOver('{ name: "Ada" nickname: "A" }');
    const value = runSync(r.read(ctx));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.get('name')).toMatchObject({ value: 'Ada' });
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['UNRECOGNIZED_FIELD']);
  });

  it('a repeated field name reports DUPLICATE_FIELD; the last occurrence wins', () => {
    const r = reader([field('name', 'text')]);
    const { ctx, diagnostics } = collectingContextOver('{ name: "Ada" name: "Grace" }');
    const value = runSync(r.read(ctx));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.get('name')).toMatchObject({ value: 'Grace' });
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['DUPLICATE_FIELD']);
  });
});

describe('recordTreeReader -- FIXED fields (§5.2)', () => {
  it('a matching value at a FIXED field on an unmarked name is accepted silently', () => {
    const r = reader([field('tag', 'text', { role: 'FIXED' }, 'x')]);
    const { ctx, diagnostics } = collectingContextOver('{ tag: "x" }');
    const value = runSync(r.read(ctx));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.get('tag')).toMatchObject({ value: 'x' });
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it('a contradicting value at a FIXED field reports FIELD_FIXED, and the field is left out entirely', () => {
    const r = reader([field('tag', 'text', { role: 'FIXED' }, 'x')]);
    const { ctx, diagnostics } = collectingContextOver('{ tag: "y" }');
    const value = runSync(r.read(ctx));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.has('tag')).toBe(false);
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['FIELD_FIXED']);
  });

  it('an omitted FIXED field on an UNMARKED name is FIELD_REQUIRED -- a marker the document must state itself (§5.2)', () => {
    const r = reader([field('tag', 'text', { role: 'FIXED' }, 'x')]);
    const { ctx, diagnostics } = collectingContextOver('{}');
    const value = runSync(r.read(ctx));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.has('tag')).toBe(false);
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['FIELD_REQUIRED']);
  });

  it('an omitted FIXED field on a MARKED name injects the pin', () => {
    const r = reader([field('tag', 'text', { optional: true, role: 'FIXED' }, 'x')]);
    const value = runSync(r.read(bodyContextOver('{}')));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.get('tag')).toMatchObject({ value: 'x' });
  });

  it('writing `_` at a FIXED field is always refused, marked or not -- a pin on a voidable type is a resolver error, so FIXED is never voidable (§5.2)', () => {
    const marked = reader([field('tag', 'text', { optional: true, role: 'FIXED' }, 'x')]);
    const unmarked = reader([field('tag', 'text', { role: 'FIXED' }, 'x')]);
    const markedResult = collectingContextOver('{ tag: _ }');
    runSync(marked.read(markedResult.ctx));
    expect(markedResult.diagnostics.diagnostics.map((d) => d.code)).toEqual(['FIELD_FIXED']);
    const unmarkedResult = collectingContextOver('{ tag: _ }');
    runSync(unmarked.read(unmarkedResult.ctx));
    expect(unmarkedResult.diagnostics.diagnostics.map((d) => d.code)).toEqual(['FIELD_FIXED']);
  });
});

describe('recordTreeReader -- field groups (§5.11)', () => {
  function groupedReader(): TypeReader<Value> {
    return reader(
      [field('a', 'text', { optional: true }), field('b', 'text', { optional: true })],
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

  /**
   * A restated member may carry `role: 'FIXED'` (§5.11: "it may take `= v`, which is checked
   * when written and never injected -- the one pin that does not inject, because an injected
   * member would be present, and presence is what selects the group's alternative"). This is the
   * one shape {@link fieldOmission}'s `isGroupMember` flag exists for: `a` is `optional: true,
   * role: 'FIXED'` here, the same four facts a defaulted (non-member) field carries, but its
   * omission must still be the group's `'ABSENT'`, never `'INJECTED'`.
   */
  function pinnedMemberReader(): TypeReader<Value> {
    return reader(
      [
        field('a', 'text', { optional: true, role: 'FIXED' }, 'x'),
        field('b', 'text', { optional: true }),
      ],
      [{ members: ['a', 'b'], state: 'REQUIRED' }],
    );
  }

  it('a pinned member is never injected on omission -- omitting it entirely leaves the group unsatisfied, not silently filled with the pin', () => {
    const { ctx, diagnostics } = collectingContextOver('{}');
    const value = runSync(pinnedMemberReader().read(ctx));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.has('a')).toBe(false);
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['FIELD_REQUIRED']);
  });

  it('a pinned member satisfies the group when the other member is written, without also injecting the pin', () => {
    const { ctx, diagnostics } = collectingContextOver('{ b: "y" }');
    const value = runSync(pinnedMemberReader().read(ctx));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.has('a')).toBe(false);
    expect(value.fields.get('b')).toMatchObject({ value: 'y' });
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it('a pinned member written with the pinned value satisfies the group', () => {
    const { ctx, diagnostics } = collectingContextOver('{ a: "x" }');
    const value = runSync(pinnedMemberReader().read(ctx));
    if (value.kind !== 'record') throw new Error('unreachable');
    expect(value.fields.get('a')).toMatchObject({ value: 'x' });
    expect(diagnostics.diagnostics).toEqual([]);
  });
});

describe('recordTreeReader -- annotations (§3.1)', () => {
  it("captures the record value's own leading annotations, structurally", () => {
    const r = reader([field('name', 'text')]);
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
