/**
 * [TSON-SCHEMA] §5.7's `!T ^ { values }` over a type built by `meta.array`, `meta.map` or a constructor IS-A either,
 * a namespace type included (change log §4.5, items 106, 120–121): a refinement by the same constructor, IS-A its
 * source and the source's chain, each written facet judged by its kind over effective values -- bounds move inward,
 * a type slot and `ordered` are restated only, `unique_items` only rises and `voidable` only falls. A type slot is
 * restated by the entry its name reaches (§8.3), judged once every entry is ready.
 */
import { describe, expect, it } from 'vitest';

import { load, loadError, textCodes } from './schema-read-helpers.js';
import { subtypesIn, supertypesIn } from './model-fixtures.js';
import type { ArrayBody, MapBody, NamespaceBody } from '../src/schema/meta/bodies.js';

const META = '!!import:"https://tson.io/2026/40/m/meta.tn"';

describe('§5.7 an array type refined by its facets', () => {
  it('narrows a bound, keeps the source’s other facets, and IS-A the source', () => {
    const linked = load(
      'tags => [text; ..10]\nfew => !tags ^ { max_items: 3  unique_items: true }',
    );
    const few = linked.entries.get('few') as ArrayBody;
    expect(few).toMatchObject({ kind: 'array', maxItems: 3n, uniqueItems: true, ordered: true });
    expect(few.elementType).toMatchObject({ name: 'text' });
    expect(supertypesIn(few)).toEqual(['tags']);
    expect(subtypesIn(linked.entries.get('tags'))).toEqual(['few']);
  });

  it('a refinement of a refinement carries its complete chain', () => {
    const linked = load(
      'tags => [text]\nfew => !tags ^ { max_items: 5 }\nfewer => !few ^ { min_items: 1 }',
    );
    expect(supertypesIn(linked.entries.get('fewer'))).toEqual(['few', 'tags']);
    expect(linked.entries.get('fewer')).toMatchObject({ minItems: 1n, maxItems: 5n });
  });

  it.each([
    [
      'raising a ceiling',
      'few => [text; ..5]\nmore => !few ^ { max_items: 6 }',
      /max_items 6 is above/,
    ],
    [
      'lowering a floor',
      'tags => [text; 2..]\nwider => !tags ^ { min_items: 1 }',
      /min_items 1 is below/,
    ],
    [
      'admitting void elements',
      'names => [text]\nv => !names ^ { voidable: true }',
      /voidable re-enables/,
    ],
    [
      'allowing duplicates',
      'u => !meta.array { element_type: text  unique_items: true }\nagain => !u ^ { unique_items: false }',
      /duplicate items/,
    ],
    [
      'changing the order',
      'names => [text]\nu => !names ^ { ordered: false }',
      /only restates ordered/,
    ],
    [
      'another element type',
      'names => [text]\nids => !names ^ { element_type: uuid }',
      /only restates element_type/,
    ],
  ])('refuses %s (§5.7)', (_what, body, message) => {
    expect(loadError(body, META)).toMatch(message);
  });

  it('a restated element type names the entry the source’s reaches, through any alias, declared before or after (§8.3)', () => {
    for (const body of [
      'label => text\nlabels => [label]\nshort => !labels ^ { element_type: text  max_items: 3 }',
      'labels => [text]\nshort => !labels ^ { element_type: label  max_items: 3 }\nlabel => text',
      'a => text\nb => a\nlabels => [text]\nshort => !labels ^ { element_type: b }',
    ]) {
      expect(loadError(body)).toBeUndefined();
    }
    // The resolved value states the slot as the source wrote it.
    const linked = load(
      'label => text\nlabels => [label]\nshort => !labels ^ { element_type: text }',
    );
    expect((linked.entries.get('short') as ArrayBody).elementType).toMatchObject({ name: 'label' });
  });

  it('an alias of another type restates nothing: it is another element type (§8.3)', () => {
    expect(
      loadError('other => uuid\ntags => [text]\nids => !tags ^ { element_type: other }'),
    ).toMatch(/element_type other replaces the source's own text/);
  });

  it('a value read against the refinement meets its narrowed facets (§7.2)', () => {
    const linked = load('tags => [text]\nfew => !tags ^ { max_items: 2 }');
    expect(textCodes(linked, 'few', '!few [a b]')).toEqual([]);
    expect(textCodes(linked, 'few', '!few [a b c]')).not.toEqual([]);
  });
});

describe('§5.7 a map type refined by its facets', () => {
  it('narrows its bounds and restates its slots through aliases', () => {
    const linked = load(
      'key => text\nindex => {text => int32}\nsmall => !index ^ { key_type: key  max_items: 4 }',
    );
    const small = linked.entries.get('small') as MapBody;
    expect(small).toMatchObject({ kind: 'map', maxItems: 4n });
    expect(small.keyType).toMatchObject({ name: 'text' });
    expect(supertypesIn(small)).toEqual(['index']);
  });

  it('refuses another key type', () => {
    expect(loadError('index => {text => int32}\nbyid => !index ^ { key_type: uuid }')).toMatch(
      /key_type uuid replaces the source's own text/,
    );
  });
});

describe('§5.7 a namespace type, built by a constructor IS-A meta.map, refined as a map is (item 120)', () => {
  const api = 'api => !meta.namespace { key_type: meta.identifier  value_type: text }';

  it('adds a ceiling and stays a namespace type beneath its source', () => {
    const linked = load(`${api}\nsmall => !api ^ { max_items: 2 }`, META);
    expect(linked.entries.get('small')).toMatchObject({ kind: 'namespace', maxItems: 2n });
    expect(supertypesIn(linked.entries.get('small') as NamespaceBody)).toEqual(['api']);
  });

  it('restates the pinned voidable at its pin and refuses any other value (§5.2, §5.7)', () => {
    expect(
      loadError(`${api}\nsame => !api ^ { voidable: false  ordered: false }`, META),
    ).toBeUndefined();
    expect(loadError(`${api}\ngappy => !api ^ { voidable: true }`, META)).toMatch(
      /'voidable' is fixed at false by 'meta.namespace'/,
    );
  });

  it('refuses a field its constructor does not declare (§5.5)', () => {
    expect(loadError(`${api}\nd => !api ^ { unique_items: true }`, META)).toMatch(
      /'unique_items' is no field of the constructor 'meta.namespace'/,
    );
  });

  it('a value of the refinement stands where its source is wanted, and is read as itself (§7.2)', () => {
    const holder = `${api}\nsmall => !api ^ { max_items: 2 }\nholder => { held: api }\n`;
    expect(loadError(`${holder}h => !holder { held: !small { a => "x" } }`, META)).toBeUndefined();
    expect(
      loadError(`${holder}h => !holder { held: !small { a => "x"  b => "y"  c => "z" } }`, META),
    ).toMatch(/more than the maximum 2/);
  });
});

describe('§5.7, §8.3 an enum’s name_type is restated by the entry it reaches (item 121)', () => {
  it('an alias of the source’s name type restates it, and the value states the source’s spelling', () => {
    const linked = load(
      'ident => meta.identifier\ncolour => !enum [RED ORANGE BLUE]\nwarm => !colour ^ { name_type: ident  members: [RED ORANGE] }',
      META,
    );
    expect(linked.entries.get('warm')).toMatchObject({
      kind: 'enum',
      nameType: 'meta.identifier',
      members: ['RED', 'ORANGE'],
    });
  });
});

describe('§5.5, §5.7 net.uuid_type’s version is settable once (item 112)', () => {
  const net = '!!import:"https://tson.io/2026/40/m/net.tn"';

  it('a refinement may set a version its source left unset', () => {
    expect(loadError('v4 => !uuid ^ { version: 4 }', net)).toBeUndefined();
  });

  it('a refinement changing a set version is refused: the versions are disjoint layouts', () => {
    expect(loadError('v4 => !uuid ^ { version: 4 }\nv7 => !v4 ^ { version: 7 }', net)).toMatch(
      /version 7 replaces the source's own 4/,
    );
    expect(
      loadError('v4 => !uuid ^ { version: 4 }\nagain => !v4 ^ { version: 4 }', net),
    ).toBeUndefined();
  });
});
