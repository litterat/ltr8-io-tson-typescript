import { describe, expect, it } from 'vitest';
import { toDataValue } from '../src/bind/encode.js';
import { headed, topBinding } from '../src/schema/bindings.js';
import type { Top } from '../src/schema/meta/typedef.js';
import { fieldMapOf } from './model-fixtures.js';

/**
 * An entry is its value (Part 2 §8.1), and `top` is the one polymorphic binding in the
 * resolved-schema model: every entry's value is written through it, as a variant. A variant given
 * neither a discriminant nor per-member tests answers `undefined` for every value, which the
 * binding contract defines as a write error — so the whole model could be read and never written,
 * and nothing caught it unless a test writes a value.
 */
describe("an entry's value can be written, not just read (§8.1)", () => {
  it.each([
    [
      'record',
      {
        kind: 'record',
        fields: fieldMapOf([]),
        groups: [],
        extension: 'OPEN',
      },
    ],
    ['value_type', { kind: 'value_type' }],
    ['void_type', { kind: 'void_type' }],
    ['enum_type', { kind: 'enum', nameType: 'identifier', members: ['A', 'B'] }],
  ])('writes a %s value without a write error', (wireName, body) => {
    const encoded = toDataValue(topBinding, body as Top);
    expect(encoded.typeRef).toBe(wireName);
  });

  it('names the constructor on the wire, which is what a read matches back on', () => {
    expect(toDataValue(topBinding, { kind: 'value_type' }).typeRef).toBe('value_type');
  });

  it("writes a value under the constructor its entry's facts name (§8.1)", () => {
    const enumeration: Top = { kind: 'enum', nameType: 'identifier', members: ['A', 'B'] };
    // `enum` and `enum_type` share one body shape: the head, never the shape, says which.
    expect(toDataValue(topBinding, headed(enumeration, 'enum')).typeRef).toBe('enum');
    expect(toDataValue(topBinding, enumeration).typeRef).toBe('enum_type');
  });
});
