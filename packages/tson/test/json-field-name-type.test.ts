/**
 * A port of the Java reference's `JsonFieldNameTypeTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/JsonFieldNameTypeTest.java`): a record's field
 * names have a type ([TSON-SCHEMA] §5.2), and a JSON record's member names are its field names
 * ([TSON-JSON] §6.1) -- so a member is matched and judged by its record's `name_type` (§6.1.1,
 * §9.4), as a TSON text field name is.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema, type JsonCompiledSchema } from '../src/json/schema/compile.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const SCHEMA_SOURCE = `
!!id:"https://example.test/json-field-names.tn"
!!meta:"https://tson.io/2026/38/m/meta.tn"
!!import:"https://tson.io/2026/38/m/core.tn"
{
  json_name => !identifier_type { start_add: "@$" }
  node => !record { name_type: json_name  fields: {
    "@id" => { type: text }  label => { type: text } } }
  json_ref => !record { name_type: json_name  fields: {
    "$ref" => { type: text }  "$id" => { type: text  optional: true } } }
  typed => !record { name_type: json_name  fields: { "$type" => { type: text } } }
  address => json_record & { city: text }
  located => ld_node & address
  folded => !identifier_type { normalization: NFKC_CASEFOLD }
  frow => !record { name_type: folded  fields: { name => { type: text } } }
  fbase => !record { name_type: folded  extension: ABSTRACT  fields: {} }
  pet => abstract fbase & { kind: text =?  name: text }
  dog => pet & { kind?: = "dog"  breed: text }
  kennel => { p: pet }
  words => !identifier_type { continue_add: "-"  medial: " " }
  row => !record { name_type: words  fields: { "first name" => { type: text } } }
  json_record => !record { name_type: json_name  extension: ABSTRACT  fields: {} }
  ld_node => json_record & { "@id": text  label: text }
  ld_holder => { n: ld_node }
  ld_name => !identifier_type { start_add: "@" }
  ld_only => !record { name_type: ld_name  fields: { "@id" => { type: text } } }
  plain => { a: text }
}
`;

const COMPILED: JsonCompiledSchema = compileJsonSchema(resolveUserSchema(SCHEMA_SOURCE));

function read(typeName: string, json: string): readonly Diagnostic[] {
  return validateJson(json, { schema: COMPILED, root: typeName }).diagnostics;
}

describe('§6.1.1 a member name is a value of its record’s name type', () => {
  it('§6.1.1: a member name is read by its record’s field name type', () => {
    expect(read('node', '{"@id": "urn:x", "label": "y"}')).toEqual([]);
    expect(read('row', '{"first name": "Ada"}')).toEqual([]);
  });

  /**
   * §3.2 gives meaning to three names and no others, so a JSON Schema translation's `$ref` and
   * `$id` are ordinary members of a record whose name type admits them.
   */
  it('§3.2: a $ name outside the three is an ordinary field', () => {
    expect(read('json_ref', '{"$ref": "#/defs/a", "$id": "urn:a"}')).toEqual([]);
  });

  /**
   * §3.2: a record that declares one of the three obscures it -- a leading `$type` is the
   * annotation member, read as a type annotation naming a type, so the field is never read, the
   * undesirable result §3.2 warns of. Here `x` names nothing, which this port reports as
   * `UNKNOWN_TYPE_REF` where the reference reports `TYPE_MISMATCH` (§7.2's two-step rule,
   * `json/schema/record.ts`'s `admissibleTag`); `plain`, which resolves, is the reference's own code.
   */
  it('§3.2: a record declaring an annotation member obscures it', () => {
    expect(read('typed', '{"$type": "x"}').map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
    expect(read('typed', '{"$type": "plain"}').map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });

  it('§5.2: two records declared over one name type compose, and both one’s names and the other’s read from JSON', () => {
    expect(read('located', '{"@id": "urn:x", "label": "y", "city": "z"}')).toEqual([]);
  });

  it('§6.1.1, §6.1.5: a member name is matched in its name type’s form, and so is a family’s selector', () => {
    expect(read('frow', '{"NAME": "x"}')).toEqual([]);
    expect(read('kennel', '{"p": {"KIND": "dog", "name": "Rex", "Breed": "c"}}')).toEqual([]);
  });

  /**
   * §9.4: an undeclared member is judged by its record's name type, not the default's -- one the
   * type admits and the record does not declare is unknown, and one outside the type (here a `$`
   * where only `@` starts a name of `ld_only`, and a `/` in a plain record) can be no field and is
   * unknown. Neither is a name-policy refusal, and each lists the record's fields; a declared name
   * type is named with its reason, and the default, whose rules are any identifier's, is not.
   */
  it('§9.4: an undeclared member is judged by its record’s name type', () => {
    const cases: readonly (readonly [string, string, string, string | undefined])[] = [
      ['node', '{"@id": "urn:x", "label": "y", "$ref": 1}', '/$ref', undefined],
      ['ld_only', '{"@id": "urn:x", "$ref": 1}', '/$ref', "'ld_name'"],
      ['plain', '{"a": "x", "react/display-name": 1}', '/react~1display-name', undefined],
    ];
    for (const [type, json, path, nameType] of cases) {
      const problems = read(type, json);
      expect(problems, JSON.stringify(problems)).toHaveLength(1);
      const unknown = problems[0];
      expect(unknown?.code).toBe('UNRECOGNIZED_FIELD');
      expect(unknown?.path).toBe(path);
      if (nameType === undefined) {
        expect(unknown?.message).not.toContain('name type');
      } else {
        expect(unknown?.message).toContain(`not a value of the record's name type ${nameType}`);
      }
    }
  });

  /**
   * §6.1.1: under a folding name type a member and its field are spelled two ways, and each
   * pointer takes its own -- the data path the member as written, the only spelling RFC 6901
   * finds in the document, the schema pointer the declaration. A repeat is reported at the repeat,
   * naming the field and where it was first given.
   */
  it('§6.1.1: a folded member’s path is the member as written', () => {
    const wrong = read('frow', '{"NAME": 5}')[0];
    expect(wrong?.path).toBe('/NAME');
    expect(wrong?.schemaPointer).toBe('/frow/name');
    const repeated = read('frow', '{"name": "a", "NAME": "b"}');
    expect(repeated, JSON.stringify(repeated)).toHaveLength(1);
    expect(repeated[0]?.code).toBe('DUPLICATE_FIELD');
    expect(repeated[0]?.path).toBe('/NAME');
    expect(repeated[0]?.message).toContain("the field 'name' is already given, as 'name' at 1:2");
  });

  it('§5.2: a record composing a fieldless base takes the base’s field name type, and reads untagged where it is typed', () => {
    expect(read('ld_holder', '{"n": {"@id": "urn:x", "label": "y"}}')).toEqual([]);
  });
});
