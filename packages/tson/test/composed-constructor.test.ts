/**
 * [TSON-SCHEMA] §5.8, §5.6, §8.1: a constructor composed over one constructor of types and adding no field has that
 * parent's shape, so an application or a construction of it binds as the parent does and its pins hold (§5.2). A
 * field added, `record` composed, or a base kind composed directly is not that rule's.
 */
import { describe, expect, it } from 'vitest';

import { TsonNotImplementedError } from '../src/core/errors.js';
import { load, loadError, jsonCodes, textCodes } from './schema-read-helpers.js';

const META = '!!import:"https://tson.io/2026/40/m/meta.tn"';
const MY_LIST = '  my_list => meta.array & { min_items?: = 1 }\n';

describe('§5.8 an instance of a composed constructor that adds no field', () => {
  it.each([
    ['the sugar', 'names => my_list<text>'],
    ['the braced construction', 'names => !my_list { element_type: text }'],
    ['the positional construction', 'names => !my_list text'],
    ['the pin restated at its value', 'names => !my_list { element_type: text  min_items: 1 }'],
  ])('%s is the parent’s body with the pin in it (§5.5, §8.1)', (_what, declaration) => {
    const linked = load(MY_LIST + declaration, META);
    const names = linked.entries.get('names');
    expect(names).toMatchObject({
      kind: 'array',
      elementType: { name: 'text' },
      minItems: 1n,
    });
    expect(linked.facts.get('names')?.head).toBe('my_list');
  });

  it('the pin is read by both encodings (§5.2)', () => {
    const linked = load(`${MY_LIST}names => my_list<text>`, META);
    expect(textCodes(linked, 'names', '[a b]')).toEqual([]);
    expect(textCodes(linked, 'names', '[]')).toHaveLength(1);
    expect(jsonCodes(linked, 'names', '["a"]')).toEqual([]);
    expect(jsonCodes(linked, 'names', '[]')).toHaveLength(1);
  });

  it('an application at a field is the same construction in place', () => {
    const linked = load(`${MY_LIST}page => { names: my_list<text> }`, META);
    expect(textCodes(linked, 'page', '{ names: [a] }')).toEqual([]);
    expect(textCodes(linked, 'page', '{ names: [] }')).toHaveLength(1);
  });

  it('a construction writing another value at the pin is refused (§5.2)', () => {
    expect(
      loadError(`${MY_LIST}names => !my_list { element_type: text  min_items: 0 }`, META),
    ).toMatch(/'min_items' is fixed at 1 by 'my_list'/);
  });

  it('a default is injected and overridable', () => {
    const body =
      'counted => meta.array & { min_items?: ~ 2 }\nn => counted<text>\nm => !counted { element_type: text  min_items: 5 }';
    const linked = load(body, META);
    expect(linked.entries.get('n')).toMatchObject({ kind: 'array', minItems: 2n });
    expect(linked.entries.get('m')).toMatchObject({ kind: 'array', minItems: 5n });
  });

  it('the instance is refined as its parent’s are, the pin holding (§5.7)', () => {
    const linked = load(`${MY_LIST}names => my_list<text>\nfew => !names ^ { max_items: 3 }`, META);
    expect(linked.entries.get('few')).toMatchObject({ kind: 'array', minItems: 1n, maxItems: 3n });
    expect(textCodes(linked, 'few', '[a b c d]')).toHaveLength(1);
    expect(
      loadError(`${MY_LIST}names => my_list<text>\nfew => !names ^ { min_items: 2 }`, META),
    ).toMatch(/'min_items' is fixed at 1 by 'my_list'/);
  });

  it('an open construction of it is completed', () => {
    const linked = load(`${MY_LIST}open => !my_list ^ { max_items: 4 }\nnames => open<text>`, META);
    expect(linked.entries.get('names')).toMatchObject({
      kind: 'array',
      minItems: 1n,
      maxItems: 4n,
    });
  });

  it('a composition over a composition binds as its parent does, through an alias hop too', () => {
    const linked = load(
      `${MY_LIST}two => my_list & { max_items?: = 3 }\nn => two<text>\nal => meta.array\nhop => al & { ordered?: = false }\nh => hop<text>`,
      META,
    );
    expect(linked.entries.get('n')).toMatchObject({ kind: 'array', minItems: 1n, maxItems: 3n });
    expect(linked.entries.get('h')).toMatchObject({ kind: 'array' });
  });

  it.each([
    [
      'a field added',
      'c => meta.map & { label?: text }\nx => !c { key_type: text  value_type: int32 }',
    ],
    [
      'record composed',
      'c => meta.record & { extension?: = FINAL }\nx => !c { fields: { id => { type: text } } }',
    ],
    [
      'record composed with a field added',
      'c => meta.record & { extra: text }\nx => !c { fields: { id => { type: text } }  extra: hello }',
    ],
    ['a base kind composed directly (atom)', 'c => meta.atom & {}\nx => !c {}'],
    ['a base kind composed directly (product)', 'c => meta.product & {}\nx => !c {}'],
  ])('%s is no part of that rule: a gap, never a body bound as another’s', (_what, body) => {
    expect(() => load(body, META)).toThrow(TsonNotImplementedError);
  });

  it('the other collection constructors and the atom constructors bind the same', () => {
    const body = [
      'my_map => meta.map & { min_items?: = 1 }',
      'counts => my_map<text int32>',
      'my_ns => meta.namespace & { min_items?: = 1 }',
      'ops => !my_ns { key_type: meta.identifier  value_type: text }',
      'short => unicode.text_type & { max_length?: = 3 }',
      'code => !short {}',
      'even => numeric.integer_type & { multiple_of?: = 2 }',
      'evens => !even {}',
    ].join('\n');
    const linked = load(body, META);
    expect(linked.entries.get('counts')).toMatchObject({ kind: 'map', minItems: 1n });
    expect(linked.entries.get('ops')).toMatchObject({ kind: 'namespace', minItems: 1n });
    expect(linked.entries.get('code')).toMatchObject({ maxLength: 3n });
    expect(textCodes(linked, 'counts', '{}')).toHaveLength(1);
    expect(textCodes(linked, 'code', 'abc')).toEqual([]);
    expect(textCodes(linked, 'code', 'abcd')).toHaveLength(1);
    expect(textCodes(linked, 'evens', '3')).toHaveLength(1);
  });
});
