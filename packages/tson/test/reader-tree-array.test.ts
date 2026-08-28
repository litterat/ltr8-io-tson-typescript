import { describe, expect, it } from 'vitest';
import type { SchemaLocation } from '../src/core/diagnostic.js';
import type { ArrayBody } from '../src/schema/meta/bodies.js';
import { atomTreeReader, atomTypeReader } from '../src/reader/tree/atom.js';
import { arrayTreeReader } from '../src/reader/tree/array.js';
import type { TypeReader } from '../src/reader/contracts.js';
import type { Value } from '../src/tree/nodes.js';
import { bodyContextOver, collectingContextOver, stubIntType } from './reader-tree-helpers.js';
import { runSync } from '../src/io/bytes.js';

/** `reader/tree/array.ts` -- ported from `ArrayAbstractReader`/`ArrayTreeReader`. */

const LOCATION: SchemaLocation = { schemaId: 'test://schema.tn', pointer: '/numbers' };
const INT_READER: TypeReader<Value> = atomTreeReader(
  atomTypeReader(stubIntType(), 'int32'),
  'int32',
);
const resolve = (): TypeReader<Value> => INT_READER;

function reader(
  options: {
    state?: 'REQUIRED' | 'OPTIONAL';
    uniqueItems?: boolean;
    minItems?: bigint;
    maxItems?: bigint;
  } = {},
): TypeReader<Value> {
  const body: ArrayBody = {
    kind: 'array',
    elementType: { name: 'int32', arguments: [], annotations: [] },
    state: options.state ?? 'REQUIRED',
    unordered: false,
    uniqueItems: options.uniqueItems ?? false,
    ...(options.minItems !== undefined ? { minItems: options.minItems } : {}),
    ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
  };
  return arrayTreeReader('numbers', 'numbers', body, resolve, LOCATION);
}

describe('arrayTreeReader -- shape and elements (§2.7)', () => {
  it('reads elements in source order', () => {
    const value = runSync(reader().read(bodyContextOver('[1 2 3]')));
    if (value.kind !== 'array') throw new Error('unreachable');
    expect(value.typeRef).toBe('numbers');
    expect(value.elements.map((e) => (e.kind === 'atom' ? e.value : undefined))).toEqual([1, 2, 3]);
  });

  it('reads an empty array', () => {
    const value = runSync(reader().read(bodyContextOver('[]')));
    if (value.kind !== 'array') throw new Error('unreachable');
    expect(value.elements).toEqual([]);
  });

  it('reports TYPE_MISMATCH for a non-array value', () => {
    const { ctx, diagnostics } = collectingContextOver('"nope"');
    const value = runSync(reader().read(ctx));
    expect(value.kind).toBe('absent');
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });
});

describe('arrayTreeReader -- absent elements (§5.3 element_state)', () => {
  it('a REQUIRED element written `_` reports FIELD_REQUIRED and is kept as AbsentNode', () => {
    const { ctx, diagnostics } = collectingContextOver('[1 _ 3]');
    const value = runSync(reader({ state: 'REQUIRED' }).read(ctx));
    if (value.kind !== 'array') throw new Error('unreachable');
    expect(value.elements.map((e) => e.kind)).toEqual(['atom', 'absent', 'atom']);
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['FIELD_REQUIRED']);
  });

  it('an OPTIONAL element written `_` is silently AbsentNode, no diagnostic', () => {
    const { ctx, diagnostics } = collectingContextOver('[1 _ 3]');
    const value = runSync(reader({ state: 'OPTIONAL' }).read(ctx));
    if (value.kind !== 'array') throw new Error('unreachable');
    expect(value.elements.map((e) => e.kind)).toEqual(['atom', 'absent', 'atom']);
    expect(diagnostics.diagnostics).toEqual([]);
  });
});

describe('arrayTreeReader -- unique_items and size', () => {
  it('reports TYPE_MISMATCH for a repeated decoded element when unique_items is set', () => {
    const { ctx, diagnostics } = collectingContextOver('[1 2 1]');
    const value = runSync(reader({ uniqueItems: true }).read(ctx));
    if (value.kind !== 'array') throw new Error('unreachable');
    expect(value.elements).toHaveLength(3); // every element is still kept
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });

  it('does not flag a repeat when unique_items is unset', () => {
    const { ctx, diagnostics } = collectingContextOver('[1 1]');
    runSync(reader({ uniqueItems: false }).read(ctx));
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it('reports TYPE_MISMATCH when below min_items or above max_items', () => {
    const below = collectingContextOver('[1]');
    runSync(reader({ minItems: 2n }).read(below.ctx));
    expect(below.diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);

    const above = collectingContextOver('[1 2 3]');
    runSync(reader({ maxItems: 2n }).read(above.ctx));
    expect(above.diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });
});
