import { describe, expect, it } from 'vitest';
import type { SchemaLocation } from '../src/core/diagnostic.js';
import type { ChoiceBody } from '../src/schema/meta/bodies.js';
import { choiceTreeReader } from '../src/compiler/choiceReader.js';
import { atomTreeReader, atomTypeReader } from '../src/reader/tree/atom.js';
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
 * `compiler/choiceReader.ts` -- the `!type-ref` dispatch `reader/tree/grammar.ts`'s own top note
 * reserves for Wave 5's compiler. Mirrors `reader/bind.ts`'s `readVariant` algorithm; exercised
 * the same way that module's own tests are (see `reader-tree-*.test.ts`'s convention).
 */

const LOCATION: SchemaLocation = { schemaId: 'test://schema.tn', pointer: '/contact_method' };

function variantReader(typeRef: string, kind: 'int' | 'text'): TypeReader<Value> {
  return kind === 'int'
    ? atomTreeReader(atomTypeReader(stubIntType(), typeRef), typeRef)
    : atomTreeReader(atomTypeReader(stubTextType(), typeRef), typeRef);
}

const BODY: ChoiceBody = {
  kind: 'choice',
  variants: [
    { name: 'phone', arguments: [], annotations: [] },
    { name: 'email', arguments: [], annotations: [] },
  ],
};

function resolveType(name: string): TypeReader<Value> {
  return name === 'phone' ? variantReader('phone', 'int') : variantReader('email', 'text');
}

describe('choiceTreeReader -- SUM-kind !type-ref dispatch (§3.2, §5.4)', () => {
  it('dispatches to the variant its own leading !type-ref names, leaving the whole value for the delegate to read', () => {
    const reader = choiceTreeReader(
      'contact_method',
      'contact_method',
      BODY,
      resolveType,
      LOCATION,
    );
    const value = runSync(reader.read(bodyContextOver('!phone 5551234')));
    expect(value).toEqual({
      kind: 'atom',
      value: 5551234,
      typeRef: 'phone',
      annotations: { values: [] },
    });
  });

  it('dispatches to a different variant by its own !type-ref, annotations included', () => {
    const reader = choiceTreeReader(
      'contact_method',
      'contact_method',
      BODY,
      resolveType,
      LOCATION,
    );
    const value = runSync(reader.read(bodyContextOver('@doc:"work" !email "ada@example.org"')));
    expect(value).toEqual({
      kind: 'atom',
      value: 'ada@example.org',
      typeRef: 'email',
      annotations: {
        values: [
          {
            name: 'doc',
            value: {
              annotations: [],
              coreValue: { kind: 'token', text: 'work', form: 'single-line' },
            },
          },
        ],
      },
    });
  });

  it('reports UNKNOWN_TYPE_REF when the value carries no !type-ref at all', () => {
    const reader = choiceTreeReader(
      'contact_method',
      'contact_method',
      BODY,
      resolveType,
      LOCATION,
    );
    const { ctx, diagnostics } = collectingContextOver('5551234');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
  });

  it('reports UNKNOWN_TYPE_REF when the !type-ref names no member of this choice', () => {
    const reader = choiceTreeReader(
      'contact_method',
      'contact_method',
      BODY,
      resolveType,
      LOCATION,
    );
    const { ctx, diagnostics } = collectingContextOver('!fax 5551234');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
  });
});
