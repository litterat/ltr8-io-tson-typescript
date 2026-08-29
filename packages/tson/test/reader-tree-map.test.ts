import { describe, expect, it } from 'vitest';
import type { SchemaLocation } from '../src/core/diagnostic.js';
import type { MapBody } from '../src/schema/meta/bodies.js';
import { atomTreeReader, atomTypeReader } from '../src/reader/tree/atom.js';
import { mapTreeReader } from '../src/reader/tree/map.js';
import type { TypeReader } from '../src/reader/contracts.js';
import type { Value } from '../src/tree/nodes.js';
import {
  bodyContextOver,
  collectingContextOver,
  stubIntType,
  stubTextType,
} from './reader-tree-helpers.js';
import { runSync } from '../src/io/bytes.js';

/** `reader/tree/map.ts` -- ported from `MapAbstractReader`/`MapTreeReader`. */

const LOCATION: SchemaLocation = { schemaId: 'test://schema.tn', pointer: '/dictionary' };
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

function reader(minItems?: bigint, maxItems?: bigint): TypeReader<Value> {
  const body: MapBody = {
    kind: 'map',
    keyType: { name: 'text', arguments: [], annotations: [] },
    valueType: { name: 'int32', arguments: [], annotations: [] },
    state: 'REQUIRED',
    ...(minItems !== undefined ? { minItems } : {}),
    ...(maxItems !== undefined ? { maxItems } : {}),
  };
  return mapTreeReader('dictionary', 'dictionary', body, resolve, LOCATION);
}

describe('mapTreeReader -- shape and entries (§2.6, §2.8)', () => {
  it('reads entries with typed keys, in source order', () => {
    const value = runSync(reader().read(bodyContextOver('{ "a" => 1  "b" => 2 }')));
    if (value.kind !== 'map') throw new Error('unreachable');
    expect(value.typeRef).toBe('dictionary');
    expect(value.entries).toEqual([
      {
        key: { kind: 'atom', value: 'a', typeRef: 'text', annotations: { values: [] } },
        value: { kind: 'atom', value: 1, typeRef: 'int32', annotations: { values: [] } },
      },
      {
        key: { kind: 'atom', value: 'b', typeRef: 'text', annotations: { values: [] } },
        value: { kind: 'atom', value: 2, typeRef: 'int32', annotations: { values: [] } },
      },
    ]);
  });

  it('reads `{}` as a zero-entry map', () => {
    const value = runSync(reader().read(bodyContextOver('{}')));
    if (value.kind !== 'map') throw new Error('unreachable');
    expect(value.entries).toEqual([]);
  });

  it('reports TYPE_MISMATCH for a non-map value', () => {
    const { ctx, diagnostics } = collectingContextOver('"nope"');
    const value = runSync(reader().read(ctx));
    expect(value.kind).toBe('absent');
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });
});

describe('mapTreeReader -- keys (§2.6, §2.9)', () => {
  it('rejects the absent sentinel in key position', () => {
    const { ctx, diagnostics } = collectingContextOver('{ _ => 1 }');
    const value = runSync(reader().read(ctx));
    if (value.kind !== 'map') throw new Error('unreachable');
    expect(value.entries).toEqual([]);
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });

  it('reports DUPLICATE_MAP_KEY for a repeated decoded key; the last entry wins', () => {
    const { ctx, diagnostics } = collectingContextOver('{ "a" => 1  "a" => 2 }');
    const value = runSync(reader().read(ctx));
    if (value.kind !== 'map') throw new Error('unreachable');
    expect(value.entries.map((e) => (e.value.kind === 'atom' ? e.value.value : undefined))).toEqual(
      [1, 2],
    );
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['DUPLICATE_MAP_KEY']);
  });
});

describe('mapTreeReader -- size (§9)', () => {
  it('reports TYPE_MISMATCH when below min_items, counting `{}` as zero entries', () => {
    const { ctx, diagnostics } = collectingContextOver('{}');
    runSync(reader(1n).read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });

  it('reports TYPE_MISMATCH when above max_items', () => {
    const { ctx, diagnostics } = collectingContextOver('{ "a" => 1  "b" => 2 }');
    runSync(reader(undefined, 1n).read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });
});
