/**
 * A constructor is an ordinary record type ([TSON-SCHEMA] §4.1, §4.2), read from JSON as it is
 * from TSON text: a field typed by `net.uuid_type` holds a declaration read as data, a value of
 * `meta.record`'s own instances, and a reference over `meta.record` holds a constructor's name.
 * The JSON half and the text parity of the Java reference's `ConstructorAsRecordTypeTest`; its
 * bind-mode cases (a model class receiving the declaration) have no counterpart in this package.
 */
import { describe, expect, it } from 'vitest';

import { compile } from '../src/compiler/compile.js';
import { validate as validateText } from '../src/facade/tree.js';
import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const LINKED = resolveUserSchema(`
!!id:"https://example.test/constructor-as-type.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  holder   => { spec: net.uuid_type }
  pick     => { t: meta.ref<meta.record> }
  tpick    => { t: meta.type_ref }
  boxed    => <T> { v: T }
  box_spec => boxed<net.uuid_type>
  specs    => [net.uuid_type]
}
`);
const JSON_SCHEMA = compileJsonSchema(LINKED);
const TEXT_SCHEMA = compile(LINKED);

const fromJson = (root: string, body: string) =>
  validateJson(body, { schema: JSON_SCHEMA, root }).diagnostics;
const fromTson = (root: string, body: string) =>
  validateText(new TextEncoder().encode(body), { schema: TEXT_SCHEMA, root }).diagnostics;

describe('§4.1 a constructor is a type a field may be typed by', () => {
  it('a constructor-typed field holds a declaration, in both encodings', () => {
    expect(fromTson('holder', '{ spec: { version: 4 } }')).toEqual([]);
    expect(fromTson('holder', '{ spec: !net.uuid_type { version: 4 } }')).toEqual([]);
    expect(fromTson('specs', '[{ version: 4 } {}]')).toEqual([]);
    expect(fromTson('box_spec', '{ v: { version: 4 } }')).toEqual([]);
    expect(fromJson('holder', '{"spec": {"version": 4}}')).toEqual([]);
    expect(fromJson('specs', '[{"version": 4}, {}]')).toEqual([]);
    expect(fromJson('box_spec', '{"v": {"version": 4}}')).toEqual([]);
  });

  it('a member the constructor does not declare is refused, on one code in both encodings', () => {
    const tson = fromTson('holder', '{ spec: { nope: 4 } }');
    const json = fromJson('holder', '{"spec": {"nope": 4}}');
    expect(tson.map((d) => d.code)).toEqual(['UNRECOGNIZED_FIELD']);
    expect(json.map((d) => d.code)).toEqual(['UNRECOGNIZED_FIELD']);
  });
});

describe('§4.2 a reference over meta.record holds a constructor’s name', () => {
  it('a constructor’s name is a name in both encodings', () => {
    expect(fromTson('pick', '{ t: net.uuid_type }')).toEqual([]);
    expect(fromTson('pick', '{ t: meta.record }')).toEqual([]);
    expect(fromTson('tpick', '{ t: net.uuid_type }')).toEqual([]);
    expect(fromJson('pick', '{"t": "net.uuid_type"}')).toEqual([]);
    expect(fromJson('pick', '{"t": "meta.record"}')).toEqual([]);
    expect(fromJson('tpick', '{"t": "net.uuid_type"}')).toEqual([]);
  });
});
