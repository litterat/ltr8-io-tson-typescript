import { describe, expect, it } from 'vitest';
import type { SchemaLocation } from '../src/core/diagnostic.js';
import type { TypeDefinition } from '../src/schema/meta/typedef.js';
import { recordReaderFactory, type TreeReaderContext } from '../src/reader/tree/factory.js';
import { atomTreeReader, atomTypeReader } from '../src/reader/tree/atom.js';
import type { TypeReader } from '../src/reader/contracts.js';
import type { Value } from '../src/tree/nodes.js';
import { bodyContextOver, stubTextType } from './reader-tree-helpers.js';
import { runSync } from '../src/io/bytes.js';

/**
 * `reader/tree/factory.ts` -- the `ValueReaderFactory<TypeDefinition, TreeReaderContext>` wiring, a
 * starting point for Wave 5's compiler. Exercised end to end: one `TypeDefinition`, one hand-built
 * context, one read.
 */

describe('recordReaderFactory', () => {
  it('builds a working tree reader from a resolved TypeDefinition', () => {
    const definition: TypeDefinition = {
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
            name: 'name',
            type: { name: 'text', arguments: [], annotations: [] },
            state: 'REQUIRED',
            annotations: [],
          },
        ],
      },
    };
    const textReader: TypeReader<Value> = atomTreeReader(
      atomTypeReader(stubTextType(), 'text'),
      'text',
    );
    const context: TreeReaderContext = {
      resolve: () => textReader,
      locationOf: (name): SchemaLocation => ({ schemaId: 'test://s.tn', pointer: `/${name}` }),
    };
    const reader = recordReaderFactory.create('person', definition, context);
    const value = runSync(reader.read(bodyContextOver('{ name: "Ada" }')));
    expect(value).toEqual({
      kind: 'record',
      typeRef: 'person',
      annotations: { values: [] },
      fields: new Map([
        ['name', { kind: 'atom', value: 'Ada', typeRef: 'text', annotations: { values: [] } }],
      ]),
    });
  });

  it('throws when the definition is not record-shaped -- an authoring bug in the caller, not a document problem', () => {
    const definition: TypeDefinition = {
      kind: 'ATOM',
      parameters: [],
      constructor: false,
      supertypes: [],
      subtypes: [],
      annotations: [],
      body: { kind: 'unit' },
    };
    const context: TreeReaderContext = {
      resolve: () => atomTreeReader(atomTypeReader(stubTextType(), 'text'), 'text'),
      locationOf: (): SchemaLocation => ({ schemaId: 'test://s.tn' }),
    };
    expect(() => recordReaderFactory.create('thing', definition, context)).toThrow(
      /not record-shaped/,
    );
  });
});
