/**
 * A choice's nested variant and the map escape ([TSON-JSON] §5.7, §8.1, §8.3.1), read from JSON: the
 * cases of the Java reference's `JsonNestedChoiceTest` and the arbitrary-JSON declaration of §5.7.
 *
 * Decoder side only: this package has no schema-directed encoder, so §8.3.1's "an encoder refuses a
 * variant written in place that needs the escape" has no site here (`STATUS.md`).
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { jsonValueToText } from '../src/json/write.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

function readerOf(source: string) {
  const compiled = compileJsonSchema(resolveUserSchema(source));
  return (root: string, body: string) => {
    const result = validateJson(body, { schema: compiled, root });
    return {
      diagnostics: result.diagnostics,
      codes: result.diagnostics.map((d: Diagnostic) => d.code),
      value: result.value === undefined ? '' : jsonValueToText(result.value),
    };
  };
}

describe('§8.1: a tag naming a variant that is itself a choice is spent selecting it', () => {
  const read = readerOf(`
!!id:"https://example.test/json-nested-choice.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  narrow       => ( int32 | text )
  narrow_alias => narrow
  outer        => ( boolean | narrow )
  by_alias     => ( boolean | narrow_alias )
  h => { o?: outer  al?: by_alias  f?: ( boolean | narrow )  os?: [outer] }
}
`);

  it('the value is read at the nested choice untagged, in the wrapper form', () => {
    expect(read('h', '{"o": {"$type": "narrow", "$value": 5}}').codes).toEqual([]);
    expect(read('h', '{"o": {"$type": "narrow", "$value": "s"}}').codes).toEqual([]);
    expect(read('h', '{"o": {"$type": "boolean", "$value": true}}').codes).toEqual([]);
    expect(
      read(
        'h',
        '{"al": {"$type": "narrow_alias", "$value": 5}, "f": {"$type": "narrow", "$value": "s"}, ' +
          '"os": [{"$type": "narrow", "$value": 5}, {"$type": "boolean", "$value": false}]}',
      ).codes,
    ).toEqual([]);
  });

  it('the tree holds the value the nested choice read', () => {
    expect(
      read('h', '{"o": {"$type": "narrow", "$value": 5}, "f": {"$type": "narrow", "$value": "s"}}')
        .value,
    ).toBe('{"o":5,"f":"s"}');
  });

  it('a tag naming the nested choice’s own variant is refused: it is no variant of the outer choice', () => {
    expect(read('h', '{"o": {"$type": "int32", "$value": 5}}').codes).toEqual(['TYPE_MISMATCH']);
  });

  it('an untagged value at the outer choice is refused, the nested choice having no class of its own', () => {
    const found = read('h', '{"o": 5}');
    expect(found.codes).toEqual(['TYPE_MISMATCH']);
    expect(found.diagnostics[0]?.path).toBe('/o');
  });

  it('the value at the nested choice is judged there', () => {
    expect(read('h', '{"o": {"$type": "narrow", "$value": true}}').codes).toEqual([
      'TYPE_MISMATCH',
    ]);
  });
});

describe('§5.7, §8.3.1: the arbitrary-JSON declaration, and the escape that names the variant', () => {
  const read = readerOf(`
!!id:"https://example.test/json-escape.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  json        => ( text | number | boolean | [json?] | json_object )
  json_object => {text => json?}
  holder      => { j: json }
  inline      => ( text | {text => text} )
  holds       => { i: inline }
}
`);

  it('a JSON value of §3.1’s profile decodes at a json position tag-free, nulls landing as void', () => {
    for (const body of ['"s"', '1.5', 'true', '[1,null,"a"]', '{"a":1,"b":null,"c":[true]}']) {
      const found = read('holder', `{"j": ${body}}`);
      expect(found.codes, body).toEqual([]);
      expect(found.value, body).toBe(`{"j":${body}}`);
    }
  });

  it('an object holding an annotation key is written wrapped, naming the map variant', () => {
    const found = read('holder', '{"j": {"$type": "json_object", "$value": {"$type": 1}}}');
    expect(found.codes).toEqual([]);
    expect(found.value).toBe('{"j":{"$type":1}}');
    const nested = read(
      'holder',
      '{"j": {"$type": "json_object", "$value": {"a": {"$type": "json_object", "$value": {"$value": 2}}}}}',
    );
    expect(nested.codes).toEqual([]);
    expect(nested.value).toBe('{"j":{"a":{"$value":2}}}');
  });

  it('an object that leads with such a key is read as an annotation object, never as a map', () => {
    expect(read('holder', '{"j": {"$type": 1}}').codes).toEqual(['UNKNOWN_TYPE_REF']);
    expect(read('holder', '{"j": {"$value": 1}}').codes).toEqual(['UNKNOWN_TYPE_REF']);
  });

  it('one of the three among a map variant’s later keys is an ordinary key', () => {
    expect(read('holder', '{"j": {"a": 1, "$type": "x"}}').value).toBe('{"j":{"a":1,"$type":"x"}}');
  });

  it('the wrapper’s $value is the map itself: no annotation object stands in it', () => {
    // `json_object` is map-typed, so the members of `$value` are keys -- the three included.
    expect(
      read(
        'holder',
        '{"j": {"$type": "json_object", "$value": {"$type": "json_object", "$value": 1}}}',
      ).codes,
    ).toEqual([]);
  });

  it('a map variant written in place has no name, so no $type names it and the wrapper has nothing to say', () => {
    // The value is a map holding one of the three as a key and has no encoding here (§8.3.1): read
    // at the position, the leading `$type` is an annotation member naming no variant.
    const found = read('holds', '{"i": {"$type": "inline", "$value": {"$type": "x"}}}');
    expect(found.codes).toEqual(['TYPE_MISMATCH']);
    // Bare, the same object leads with an annotation member and is read as one, never as the map.
    expect(read('holds', '{"i": {"$type": "x"}}').codes).toEqual(['UNKNOWN_TYPE_REF']);
    // A map with no such key reads untagged.
    expect(read('holds', '{"i": {"a": "b"}}').codes).toEqual([]);
  });
});
