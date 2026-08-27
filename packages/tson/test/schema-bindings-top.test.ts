import { describe, expect, it } from 'vitest';
import { toDataValue } from '../src/bind/encode.js';
import { metaBindings } from '../src/schema/bindings.js';
import type { TypeDefinition, Top } from '../src/schema/meta/typedef.js';

/**
 * `type_definition.body` is the one polymorphic slot in the resolved-schema model, and it is bound
 * as a variant. A variant given neither a discriminant nor per-member tests answers `undefined`
 * for every value, which the binding contract defines as a write error — so the whole model could
 * be read and never written, and nothing caught it because no test ever wrote a body.
 */
function definitionWith(body: Top): TypeDefinition {
  return {
    kind: 'PRODUCT',
    parameters: [],
    constructor: false,
    supertypes: [],
    subtypes: [],
    body,
    // schema/meta carries its own Annotations stand-in: a bare array, not `{ values }`.
    annotations: [],
  };
}

const binding = metaBindings.get('type_definition');

describe('type_definition.body can be written, not just read', () => {
  it.each([
    ['record', { kind: 'record', supertypes: [], fields: [], groups: [] }],
    ['unit', { kind: 'unit' }],
  ])('writes a %s body without a write error', (_name, body) => {
    if (binding === undefined) throw new Error('type_definition binding missing');
    const encoded = toDataValue(binding, definitionWith(body as Top));
    expect(encoded.coreValue.kind).toBe('record');
  });

  it('names the member on the wire, which is what a read matches back on', () => {
    if (binding === undefined) throw new Error('type_definition binding missing');
    const encoded = toDataValue(binding, definitionWith({ kind: 'unit' }));
    if (encoded.coreValue.kind !== 'record') throw new Error('unreachable');
    const body = encoded.coreValue.fields.find((f) => f.name === 'body');
    expect(body?.value.value.typeRef).toBe('unit');
  });
});
