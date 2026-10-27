import { describe, expect, it } from 'vitest';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

// [TSON-SCHEMA] §5.2, §7.7: a record's field names are values of its `name_type`, which defaults
// to the series' identifier. The schema grammar admits any single-line token at a field name
// (§12.1), so the default is judged when the schema links, as a resolver error (§8.1).

const HEAD = `
!!id:"https://example.test/field-names.tn"
!!meta:"https://tson.io/2026/38/m/meta.tn"
!!import:"https://tson.io/2026/38/m/core.tn"
`;

function schema(body: string) {
  return resolveUserSchema(`${HEAD}{\n${body}\n}`);
}

describe('a record with no stated name type names its fields with identifiers (§5.2, §7.7)', () => {
  it('an identifier field name links', () => {
    expect(schema('person => { first-name: text }').entries.has('person')).toBe(true);
  });

  it('a quoted field name outside the identifier grammar is a resolver error', () => {
    expect(() => schema('person => { "first name": text }')).toThrow(TsonSchemaValidationError);
    expect(() => schema('person => { "first name": text }')).toThrow(/not an identifier/);
  });

  it('a record inheriting a stated name type is judged by that type, not the default (§5.8)', () => {
    const linked = schema(`
      loose => !identifier_type { start: NONE  continue: NONE
        start_add: "0123456789abcdefghijklmnopqrstuvwxyz"  continue_add: "abcdefghijklmnopqrstuvwxyz" }
      base => !record { name_type: loose  fields: {} }
      node => base & { "1st": text }
    `);
    expect(linked.entries.has('node')).toBe(true);
  });
});

describe('a composition takes its supertypes’ one name type, judged by the resolver (§5.8)', () => {
  it('composing a record of a stated name type with a plain record is a resolver error', () => {
    expect(() =>
      schema(`
        loose => !identifier_type { start: NONE  continue: NONE
          start_add: "0123456789abcdefghijklmnopqrstuvwxyz"  continue_add: "abcdefghijklmnopqrstuvwxyz" }
        base => !record { name_type: loose  extension: ABSTRACT  fields: {} }
        address => { city: text }
        node => base & address & { "1st": text }
      `),
    ).toThrow(/have different name types/);
  });
});
