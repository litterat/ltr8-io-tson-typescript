import { describe, expect, it } from 'vitest';
import { standardLibrary } from '../src/stdlib/index.js';
import type { Diagnostic } from '../src/core/diagnostic.js';

// [TSON-SCHEMA] §5.2, §7.2, §7.7: a schema-governed record reads a document's field names by its
// name type -- matched in the type's form, judged by the type before closure, and held to
// [TSON-DATA] §8.2's per-name rules under the type's profile.

const HEAD = [
  '!!id:"https://example.test/names.tn"',
  '!!meta:"https://tson.io/2026/38/m/meta.tn"',
  '!!import:"https://tson.io/2026/38/m/core.tn"',
].join('\n');

const SCHEMA = `
  json_name => !identifier_type { start_add: "@$" }
  json_record => !record { name_type: json_name  extension: ABSTRACT  fields: {} }
  node => json_record & { "@id": text  label?: text }
  plain => { a?: text }
  holder => json_record & { "@id": text  inner: plain }
  folded => !identifier_type { normalization: NFKC_CASEFOLD }
  frow => !record { name_type: folded  fields: { name => { type: text } } }
  fbase => !record { name_type: folded  extension: ABSTRACT  fields: {} }
  fpet => abstract fbase & { kind: text =?  name: text }
  fdog => fpet & { kind?: = "dog"  breed: text }
  fkennel => { p: fpet }
`;

const tson = standardLibrary();
const compiled = tson.compile(tson.resolveSchema(`${HEAD}\n{\n${SCHEMA}\n}`));

function read(root: string, document: string): readonly Diagnostic[] {
  return tson.validate(new TextEncoder().encode(document), { schema: compiled, root }).diagnostics;
}

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => `${d.code} ${d.path ?? ''}`);
}

describe('a document’s field names are matched in the name type’s form (§5.2, §7.7)', () => {
  it('a relaxed name type admits the names it declares', () => {
    expect(read('node', '{ "@id": "urn:x"  label: x }')).toEqual([]);
  });

  it('under a case-folding name type, NAME is the field name', () => {
    expect(read('frow', '{ NAME: x }')).toEqual([]);
  });

  it('two spellings of one name are one field stated twice, reported at the second as written', () => {
    expect(codes(read('frow', '{ name: x  NAME: y }'))).toEqual(['DUPLICATE_FIELD /NAME']);
  });

  it('a wrong value at a folded name is reported at the name as written ([TSON-DATA] §8.1)', () => {
    expect(codes(read('frow', '{ NAME: [1] }'))).toEqual(['TYPE_MISMATCH /NAME']);
  });

  it('a sealed family’s selector is found however its name is cased (§5.2)', () => {
    expect(read('fkennel', '{ p: { KIND: dog  name: Rex  Breed: corgi } }')).toEqual([]);
  });
});

describe('the name type judges a name before closure does (§5.2, §7.2)', () => {
  it('a name that is no value of the type is an unrecognised field naming the type, never a refusal', () => {
    const diagnostics = read('node', '{ "@id": "urn:x"  "a b": 1 }');
    expect(codes(diagnostics)).toEqual(['UNRECOGNIZED_FIELD /a b']);
    expect(diagnostics[0]?.message).toContain("no value of its name_type 'json_name'");
  });

  it('a name that is a value of the type meets §8.2 under its profile, and is not also unrecognised', () => {
    // `@pаss` with a Cyrillic `а`: a json_name, and a mixed-script one, refused at Highly Restrictive.
    expect(codes(read('node', '{ "@id": "urn:x"  "@pаss": 1 }'))).toEqual([
      'RESTRICTED_SCRIPT /@pаss',
    ]);
  });

  it('a profile’s own additions meet no restricted-character rule', () => {
    expect(read('node', '{ "@id": "urn:x" }')).toEqual([]);
  });

  it('a record nested in a relaxed one judges its own names', () => {
    expect(codes(read('holder', '{ "@id": "urn:x"  inner: { "@a": y } }'))).toEqual([
      'UNRECOGNIZED_FIELD /inner/@a',
    ]);
  });
});
