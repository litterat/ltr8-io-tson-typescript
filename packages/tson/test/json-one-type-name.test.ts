/**
 * One value, one type name ([TSON-JSON] §3.3, §9.2): a wrapper's `$value` is the annotated value itself,
 * as the value after a tag is in text, and no annotation object. Where the selected type is not
 * map-typed, an object there that leads with an annotation member is a resolver error, in either form;
 * at a map-typed selection the members of `$value` are keys (§3.2, §8.3.1). The cases of the Java
 * reference's `JsonOneTypeNameTest`.
 *
 * A resolver error in this port's codes is `UNKNOWN_TYPE_REF` for a misplaced `$type`/`$value`
 * (`json/schema/tagMembers.ts`'s top note) and `SCOPE_NOT_ADMITTED` for an `$import`.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { jsonValueToText } from '../src/json/write.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const SCHEMA = compileJsonSchema(
  resolveUserSchema(`
!!id:"https://example.test/json-one-type-name.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  shape    => abstract { name: text }
  circle   => shape & { r: int32 }
  square   => shape & { side: int32 }
  person   => { name: text }
  employee => person & { dept: text }
  memo     => { note: text }
  small    => !int32 ^ { max: 10 }
  names    => [shape]
  lookup   => { text => int32 }
  atlas    => { text => shape }
  box      => { s: shape }
  item     => ( shape | lookup | small | names )
  h  => { i?: item  p?: person  m?: memo  any?: meta.declared }
}
`),
);

function read(root: string, body: string): { codes: string[]; paths: string[]; value: string } {
  const result = validateJson(body, { schema: SCHEMA, root });
  return {
    codes: result.diagnostics.map((d: Diagnostic) => d.code),
    paths: result.diagnostics.map((d: Diagnostic) => d.path ?? ''),
    value: result.value === undefined ? '' : jsonValueToText(result.value),
  };
}

describe('§3.3: a value has one spelling of its type', () => {
  it('a subtype is named by the one $type', () => {
    expect(
      read(
        'h',
        '{"i": {"$type": "circle", "name": "a", "r": 2}, "p": {"$type": "employee", "name": "a", "dept": "d"}}',
      ).codes,
    ).toEqual([]);
  });

  it('an annotation object in a wrapper’s $value is refused at its type, and nothing is read of it', () => {
    for (const [body, path] of [
      [
        '{"i": {"$type": "shape", "$value": {"$type": "circle", "name": "a", "r": 2}}}',
        '/i/$value/$type',
      ],
      [
        '{"p": {"$type": "person", "$value": {"$type": "employee", "name": "a", "dept": "d"}}}',
        '/p/$value/$type',
      ],
      ['{"m": {"$type": "memo", "$value": {"$type": "memo", "note": "n"}}}', '/m/$value/$type'],
    ] as const) {
      const found = read('h', body);
      expect(found.paths, body).toEqual([path]);
      expect(found.codes, body).toEqual(['UNKNOWN_TYPE_REF']);
    }
  });

  it('the refusal says a value’s type is written once, and where', () => {
    const result = validateJson(
      '{"p": {"$type": "person", "$value": {"$type": "employee", "name": "a", "dept": "d"}}}',
      { schema: SCHEMA, root: 'h' },
    );
    expect(result.diagnostics[0]?.message).toBe(
      "'$value' is the annotated value itself, and no annotation object: a value's type is " +
        "written once, in the wrapper's '$type', which names a subtype directly (§3.3)",
    );
  });

  it('a wrapper in a wrapper’s $value is refused, a bare $value included', () => {
    expect(
      read('h', '{"i": {"$type": "small", "$value": {"$type": "small", "$value": 5}}}').paths,
    ).toEqual(['/i/$value/$type']);
    expect(read('h', '{"i": {"$type": "small", "$value": {"$value": 5}}}').paths).toEqual([
      '/i/$value/$value',
    ]);
  });

  it('an $import there is the one refusal an $import meets at every value position', () => {
    const found = read(
      'h',
      '{"i": {"$type": "shape", "$value": {"$import": ["https://example.test/x.tn"], "name": "a"}}}',
    );
    expect(found.codes).toEqual(['SCOPE_NOT_ADMITTED']);
    expect(found.paths).toEqual(['/i/$value/$import']);
  });

  it('the values a wrapper’s $value holds, at their own positions, are annotated as at any position', () => {
    expect(
      read('h', '{"i": {"$type": "names", "$value": [{"$type": "circle", "name": "a", "r": 1}]}}')
        .codes,
    ).toEqual([]);
    expect(
      read(
        'h',
        '{"any": {"$type": "box", "$value": {"s": {"$type": "square", "name": "a", "side": 1}}}}',
      ).codes,
    ).toEqual([]);
    expect(
      read(
        'h',
        '{"any": {"$type": "atlas", "$value": {"k": {"$type": "circle", "name": "a", "r": 1}}}}',
      ).codes,
    ).toEqual([]);
  });

  it('the root’s wrapper is a wrapper too', () => {
    expect(
      read(
        'person',
        '{"$type": "person", "$value": {"$type": "employee", "name": "a", "dept": "d"}}',
      ).paths,
    ).toEqual(['/$value/$type']);
    expect(read('person', '{"$type": "person", "$value": {"name": "a"}}').codes).toEqual([]);
  });
});

describe('§3.2, §8.3.1: at a map-typed selection the members of $value are keys, the three among them', () => {
  it('a map selected by a choice’s tag holds the annotation members as keys', () => {
    const found = read('h', '{"i": {"$type": "lookup", "$value": {"$type": 1, "$value": 2}}}');
    expect(found.codes).toEqual([]);
    expect(found.value).toBe('{"i":{"$type":1,"$value":2}}');
  });

  it('and so does a map selected at a declared position', () => {
    expect(read('h', '{"any": {"$type": "lookup", "$value": {"$import": 3}}}').codes).toEqual([]);
  });
});
