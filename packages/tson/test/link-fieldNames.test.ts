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

describe('a stated name type is an identifier family that can judge names (§5.2, §7.4)', () => {
  it('a name type that is no identifier family is a resolver error', () => {
    expect(() =>
      schema('row => !record { name_type: text  fields: { "first name" => { type: text } } }'),
    ).toThrow(/is not an identifier family/);
    expect(() =>
      schema('node => !record { name_type: int32  fields: { "1" => { type: text } } }'),
    ).toThrow(TsonSchemaValidationError);
  });

  it('a name type whose normalization is NONE is refused: its form must imply NFC', () => {
    expect(() =>
      schema(`
        raw => !identifier_type { normalization: NONE }
        row => !record { name_type: raw  fields: { a => { type: text } } }
      `),
    ).toThrow(/normalization is NONE/);
  });

  it('ASCII_CASEFOLD is admitted only over a profile whose every character is ASCII', () => {
    expect(() =>
      schema(`
        folded => !identifier_type { normalization: ASCII_CASEFOLD }
        row => !record { name_type: folded  fields: { a => { type: text } } }
      `),
    ).toThrow(/ASCII_CASEFOLD/);
    const linked = schema(`
      header => !identifier_type { start: ASCII  continue: ASCII  medial: "-"  normalization: ASCII_CASEFOLD }
      headers => !record { name_type: header  fields: { "content-type" => { type: text } } }
    `);
    expect(linked.nameTypes.get('headers')?.definition.normalization).toBe('ASCII_CASEFOLD');
  });

  it('two declared spellings that are one value of a folding name type are a resolver error', () => {
    expect(() =>
      schema(`
        folded => !identifier_type { normalization: NFKC_CASEFOLD }
        row => !record { name_type: folded  fields: { name => { type: text }  NAME => { type: text } } }
      `),
    ).toThrow(/fields 'name' and 'NAME' are one value of its name_type 'folded'/);
  });

  it('one spelling written twice in the explicit form is the map’s duplicate key (§2.6)', () => {
    expect(() =>
      schema('point => !record { fields: { x => { type: int32 }  x => { type: text } } }'),
    ).toThrow(/duplicate map key 'x'/);
  });

  it('a declared name the name type admits links, and the linked schema records the type for readers', () => {
    const linked = schema(`
      json_name => !identifier_type { start_add: "@$" }
      node => !record { name_type: json_name  fields: { "@id" => { type: text }  label => { type: text } } }
      plain => { a: text }
    `);
    expect(linked.nameTypes.get('node')?.typeName).toBe('json_name');
    // The kernel's `field_name` is every reader's default, so a record stating none records nothing.
    expect(linked.nameTypes.has('plain')).toBe(false);
  });

  it('a stated name type resolves in the author’s own namespace first', () => {
    const linked = schema(`
      field_name => !identifier_type { start_add: "@" }
      stated => !record { name_type: field_name  fields: { "@id" => { type: text } } }
    `);
    expect(linked.nameTypes.get('stated')?.definition.startAdd).toBe('@');
  });

  it('two name types are one by the entry they resolve to, not by spelling (§5.2, §8.3)', () => {
    const linked = schema(`
      json_name => !identifier_type { start_add: "@$" }
      jn => json_name
      a => !record { name_type: json_name  extension: ABSTRACT  fields: {} }
      b => !record { name_type: jn  extension: ABSTRACT  fields: {} }
      both => a & b & { "@id": text }
    `);
    expect(linked.entries.has('both')).toBe(true);
  });

  it('a composition over an applied template takes the template’s name type (§5.8)', () => {
    const linked = schema(`
      json_name => !identifier_type { start_add: "@$" }
      json_record => !record { name_type: json_name  extension: ABSTRACT  fields: {} }
      page => <T> json_record & { "@id": T }
      labelled => page<text> & { label: text }
    `);
    expect(linked.nameTypes.get('labelled')?.typeName).toBe('json_name');
  });
});

describe('a profile may add no character that renders as nothing (§7.4, [TSON-DATA] §8.2)', () => {
  it('a soft hyphen, a control or a space other than U+0020 is refused as an addition', () => {
    expect(() => schema('zw => !identifier_type { continue_add: "\\u{AD}" }')).toThrow(
      /Default_Ignorable_Code_Point/,
    );
    expect(() => schema('nb => !identifier_type { medial: "\\u{A0}" }')).toThrow(
      /a space other than U\+0020/,
    );
    expect(() => schema('tab => !identifier_type { medial: "\\t" }')).toThrow(/a control/);
  });

  it('a medial U+0020 is how a name type holds words, and is admitted', () => {
    const linked = schema(`
      words => !identifier_type { continue_add: "-"  medial: " " }
      row => !record { name_type: words  fields: { "first name" => { type: text } } }
    `);
    expect(linked.nameTypes.get('row')?.typeName).toBe('words');
  });
});
