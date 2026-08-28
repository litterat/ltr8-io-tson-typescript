import { describe, expect, it } from 'vitest';
import type { SchemaLocation } from '../src/core/diagnostic.js';
import type { TupleBody, TupleElement } from '../src/schema/meta/bodies.js';
import { atomTreeReader, atomTypeReader } from '../src/reader/tree/atom.js';
import { tupleTreeReader } from '../src/reader/tree/tuple.js';
import type { TypeReader } from '../src/reader/contracts.js';
import type { Value } from '../src/tree/nodes.js';
import {
  bodyContextOver,
  collectingContextOver,
  stubIntType,
  stubTextType,
} from './reader-tree-helpers.js';
import { runSync } from '../src/io/bytes.js';

/** `reader/tree/tuple.ts` -- ported from `TupleAbstractReader`/`TupleTreeReader`. */

const LOCATION: SchemaLocation = { schemaId: 'test://schema.tn', pointer: '/pair' };
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

function slot(type: 'text' | 'int32', state: TupleElement['state'] = 'REQUIRED'): TupleElement {
  return { elementType: { name: type, arguments: [], annotations: [] }, state };
}

function reader(elements: TupleElement[]): TypeReader<Value> {
  const body: TupleBody = { kind: 'tuple', elements };
  return tupleTreeReader('pair', 'pair', body, resolve, LOCATION);
}

describe('tupleTreeReader -- positions (§5.3 [TSON-SCHEMA])', () => {
  it('reads each position with its own type, in order', () => {
    const value = runSync(reader([slot('text'), slot('int32')]).read(bodyContextOver('["a" 1]')));
    expect(value.kind).toBe('tuple');
    if (value.kind !== 'tuple') throw new Error('unreachable');
    expect(value.typeRef).toBe('pair');
    expect(value.elements).toEqual([
      { kind: 'atom', value: 'a', typeRef: 'text', annotations: { values: [] } },
      { kind: 'atom', value: 1, typeRef: 'int32', annotations: { values: [] } },
    ]);
  });

  it('reports TYPE_MISMATCH for a non-array value', () => {
    const { ctx, diagnostics } = collectingContextOver('"nope"');
    const value = runSync(reader([slot('text')]).read(ctx));
    expect(value.kind).toBe('absent');
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });

  it('a REQUIRED position written `_` reports FIELD_REQUIRED and is kept as AbsentNode', () => {
    const { ctx, diagnostics } = collectingContextOver('[_ 1]');
    const value = runSync(reader([slot('text'), slot('int32')]).read(ctx));
    if (value.kind !== 'tuple') throw new Error('unreachable');
    expect(value.elements[0]?.kind).toBe('absent');
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['FIELD_REQUIRED']);
  });

  it('an OPTIONAL position written `_` is silently AbsentNode', () => {
    const { ctx, diagnostics } = collectingContextOver('[_ 1]');
    const value = runSync(reader([slot('text', 'OPTIONAL'), slot('int32')]).read(ctx));
    if (value.kind !== 'tuple') throw new Error('unreachable');
    expect(value.elements[0]?.kind).toBe('absent');
    expect(diagnostics.diagnostics).toEqual([]);
  });
});

describe('tupleTreeReader -- arity (§5.3)', () => {
  it('too few elements reports WRONG_ARITY once; the missing position is AbsentNode', () => {
    const { ctx, diagnostics } = collectingContextOver('["a"]');
    const value = runSync(reader([slot('text'), slot('int32')]).read(ctx));
    if (value.kind !== 'tuple') throw new Error('unreachable');
    expect(value.elements).toHaveLength(2);
    expect(value.elements[1]?.kind).toBe('absent');
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['WRONG_ARITY']);
  });

  it('too many elements reports WRONG_ARITY once; the extras are decoded-and-discarded, not appended', () => {
    const { ctx, diagnostics } = collectingContextOver('["a" 1 2 3]');
    const value = runSync(reader([slot('text'), slot('int32')]).read(ctx));
    if (value.kind !== 'tuple') throw new Error('unreachable');
    expect(value.elements).toHaveLength(2);
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['WRONG_ARITY']);
  });
});
