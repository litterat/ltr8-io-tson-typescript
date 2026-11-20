/**
 * A JSON value read through an extern ([TSON-JSON] §8.6, [TSON-SCHEMA] §7.9): the `$type` leading the object, or its
 * wrapper, in the scope that holds it, and every other name in the value in the foreign schema's, at every position
 * an extern types. Each refusal is the text encoding's, by code and data path.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { mapSchemaSource, type Tson } from '../src/config.js';
import type { Diagnostic } from '../src/core/diagnostic.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema, type JsonCompiledSchema } from '../src/json/schema/compile.js';
import { jsonValueToText } from '../src/json/write.js';
import type { LinkedSchema } from '../src/link/link.js';
import { standardLibrary } from '../src/stdlib/index.js';

const CORE = 'https://tson.io/2026/40/m/core.tn';
const ORDER_1 = 'https://example.test/order-1.tn';
const ORDER_2 = 'https://example.test/order-2.tn';
const LIB = 'https://example.test/lib.tn';
const SHIPPING = 'https://example.test/shipping.tn';
const THIRD = 'https://example.test/third.tn';
const MID = 'https://example.test/mid.tn';
const OUTER = 'https://example.test/outer.tn';
const EXPRESS = 'https://example.test/express.tn';
const IMPORTER = 'https://example.test/importer.tn';
const A1 = 'https://example.test/a1.tn';
const A2 = 'https://example.test/a2.tn';
const ENV = 'https://example.test/env.tn';

const DOCUMENTS = new Map<string, string>();

function schema(id: string, body: string, ...imports: string[]): void {
  const header = [`!!id:"${id}"`, `!!import:"${CORE}"`, ...imports.map((i) => `!!import:"${i}"`)];
  DOCUMENTS.set(id, `${header.join('\n')}\n!schema {\n${body}\n}\n`);
}

function extern(entry: string, from: string, type: string): string {
  return `${entry} => !meta.extern { schema: "${from}"  type: ${type} }\n`;
}

schema(ORDER_1, 'order => { id: text  payment: card }\ncard  => { number: text }');
schema(
  ORDER_2,
  'order => { ref: text  lines: [line]  payment: card }\nrush  => order & { by: text }\n' +
    'line  => { sku: text  qty: int32 }\ncard  => { pan: text }',
);
schema(
  LIB,
  `rec       => { a: text  memo?: memo }
memo      => { note: text }
pet       => abstract { name: text }
dog       => pet & { barks: boolean }
shape     => abstract { kind: text =?  size: int32 }
circle    => shape & { kind?: = "circle" }
count     => !integer ^ { min: 0 }
colour    => !enum [red green]
either    => (text | int32)
names     => [text]
lookup    => { text => int32 }
pair      => [text, int32]
rec_alias => rec
holder    => { any: meta.declared }
label     => text
contact   => (email | uri)
${extern('ext_card', ORDER_1, 'card')}`,
  ORDER_1,
);
schema(
  SHIPPING,
  extern('order_v1', ORDER_1, 'order') +
    extern('order_v2', ORDER_2, 'order') +
    extern('rush_v2', ORDER_2, 'rush') +
    extern('rec_x', LIB, 'rec') +
    extern('pet_x', LIB, 'pet') +
    extern('dog_x', LIB, 'dog') +
    extern('shape_x', LIB, 'shape') +
    extern('circle_x', LIB, 'circle') +
    extern('count_x', LIB, 'count') +
    extern('colour_x', LIB, 'colour') +
    extern('either_x', LIB, 'either') +
    extern('names_x', LIB, 'names') +
    extern('lookup_x', LIB, 'lookup') +
    extern('pair_x', LIB, 'pair') +
    extern('alias_x', LIB, 'rec_alias') +
    extern('holder_x', LIB, 'holder') +
    extern('card_x', LIB, 'ext_card') +
    extern('contact_x', LIB, 'contact') +
    extern('email_x', LIB, 'email') +
    `oa       => order_v1
memo     => { other: int32 }
page     => <T> { items: [T] }
paged    => page<rec_x>
envelope => { id: text  body: (order_v1 | order_v2) }
single   => { o: order_v2 }
rushed   => { o: rush_v2 }
all      => {
  r?: rec_x  p?: pet_x  s?: shape_x  c?: count_x  col?: colour_x  e?: either_x  n?: names_x
  l?: lookup_x  t?: pair_x  a?: alias_x  k?: card_x  h?: holder_x  oa?: oa
  els?: [rec_x]  m?: { text => rec_x }  keys?: { count_x => text }  tup?: [rec_x, text]
  dis?: (rec_x | int32)  any?: meta.declared  pg?: page<rec_x>  pd?: paged  ct?: contact_x
}`,
);
schema(THIRD, 'thing => { t: text }\nmemo => { third: text }');
schema(
  MID,
  `${extern('thing_x', THIRD, 'thing')}holder => { th: thing_x  any?: meta.declared }\nmemo => { mid: text }`,
);
schema(
  OUTER,
  `${extern('holder_x', MID, 'holder')}outer => { h: holder_x }\nmemo => { outer: text }`,
);
schema(EXPRESS, 'express => order & { at: text }', ORDER_2);
schema(IMPORTER, `${extern('o2', ORDER_2, 'order')}holder => { o: o2 }`, EXPRESS);
schema(
  A1,
  `order    => abstract { id: text }
rush     => order & { by: text }
standard => order & { note?: text }
parcel   => { id: text }
bulky    => parcel & { weight: text }
card     => { number: text }
left     => { l: text }
right    => { r: text }
both     => left & right
shape    => abstract { name: text }
circle   => shape & { radius: text }
item     => ( text | shape )
sides    => ( left | right )`,
);
schema(
  A2,
  `order    => abstract { ref: text }
rush     => order & { due: text }
parcel   => { id: text }
bulky    => parcel & { crane: text }`,
);
schema(
  ENV,
  extern('order_v1', A1, 'order') +
    extern('order_v2', A2, 'order') +
    extern('rush_v1', A1, 'rush') +
    extern('rush_v2', A2, 'rush') +
    extern('rush_again', A1, 'rush') +
    extern('parcel_v1', A1, 'parcel') +
    extern('parcel_v2', A2, 'parcel') +
    extern('bulky_v1', A1, 'bulky') +
    extern('bulky_v2', A2, 'bulky') +
    extern('card_v1', A1, 'card') +
    extern('left_v1', A1, 'left') +
    extern('right_v1', A1, 'right') +
    extern('both_v1', A1, 'both') +
    extern('shape_v1', A1, 'shape') +
    extern('circle_v1', A1, 'circle') +
    extern('item_v1', A1, 'item') +
    extern('sides_v1', A1, 'sides') +
    `r1       => rush_v1
envelope => {
  id:      text
  body?:   ( order_v1 | order_v2 )
  box?:    ( parcel_v1 | parcel_v2 )
  named?:  ( order_v1 | rush_v1 )
  side?:   ( left_v1 | right_v1 )
  thing?:  ( text | shape_v1 )
  item?:   item_v1
  sides?:  sides_v1
}`,
);

let tson: Tson;
const linked = new Map<string, LinkedSchema>();
const compiled = new Map<string, JsonCompiledSchema>();

beforeAll(async () => {
  const encoded: Record<string, Uint8Array> = {};
  for (const [id, text] of DOCUMENTS) encoded[id] = encodeUtf8(text);
  tson = standardLibrary({ schemaSource: mapSchemaSource(encoded) });
  for (const [id, text] of DOCUMENTS) linked.set(id, await tson.loadSchema(text));
});

/** `id`'s JSON compile, a value reaching a schema neither foreign schema holds read in the registry's. */
function jsonSchema(id: string): JsonCompiledSchema {
  let found = compiled.get(id);
  if (found === undefined) {
    const schemaOf = linked.get(id);
    if (schemaOf === undefined) throw new Error(`no schema '${id}'`);
    found = compileJsonSchema(schemaOf, {
      foreignSchema: (identity) => tson.schemas.get(identity),
    });
    compiled.set(id, found);
  }
  return found;
}

function read(id: string, root: string, json: string) {
  return validateJson(json, { schema: jsonSchema(id), root });
}

function shown(problems: readonly Diagnostic[]): string[] {
  return problems.map((d) => `${d.code} ${d.path ?? ''}: ${d.message}`);
}

function refusals(problems: readonly Diagnostic[]): string[] {
  return problems.map((d) => `${d.code} ${d.path ?? ''}`);
}

/** The text document's diagnostics, as code and data path, for the parity of a refusal. */
function textRefusals(id: string, text: string): string[] {
  return refusals(tson.validateDocument(encodeUtf8(`!!import:"${id}"\n${text}`)).diagnostics);
}

/** `json` reads clean, writes back, and the written document reads to the same tree. */
function readsBack(id: string, root: string, json: string): void {
  const first = read(id, root, json);
  expect(shown(first.diagnostics), json).toEqual([]);
  if (first.value === undefined) throw new Error('no value');
  const written = jsonValueToText(first.value);
  const again = read(id, root, written);
  expect(shown(again.diagnostics), written).toEqual([]);
  expect(again.value).toEqual(first.value);
}

describe('§8.6 the boundary’s $type is the enclosing scope’s, every other name the foreign schema’s', () => {
  it('§8.6’s example: order_v2 is the document’s name for the extern, and card the foreign schema’s', () => {
    const result = read(
      SHIPPING,
      'envelope',
      '{"id": "a", "body": {"$type": "order_v2", "ref": "r", "lines": [{"sku": "A", "qty": 1}], ' +
        '"payment": {"$type": "card", "pan": "4111"}}}',
    );
    expect(shown(result.diagnostics)).toEqual([]);
    if (result.value === undefined) throw new Error('no value');
    expect(jsonValueToText(result.value)).toBe(
      '{"id":"a","body":{"ref":"r","lines":[{"sku":"A","qty":1}],"payment":{"pan":"4111"}}}',
    );
  });

  it.each([
    [
      'single',
      '{"o": {"ref": "r", "lines": [{"$type": "line", "sku": "s", "qty": 1}], "payment": {"pan": "p"}}}',
    ],
    ['single', '{"o": {"$type": "order_v2", "ref": "r", "lines": [], "payment": {"pan": "p"}}}'],
    [
      'single',
      '{"o": {"$type": "order_v2", "$value": {"ref": "r", "lines": [], "payment": {"pan": "p"}}}}',
    ],
    ['all', '{"r": {"a": "x", "memo": {"$type": "memo", "note": "n"}}}'],
    ['all', '{"s": {"kind": "circle", "size": 3}}'],
    ['all', '{"s": {"$type": "circle_x", "kind": "circle", "size": 3}}'],
    ['all', '{"s": {"$type": "shape_x", "kind": "circle", "size": 3}}'],
    ['all', '{"c": 3}'],
    ['all', '{"c": {"$type": "count_x", "$value": 3}}'],
    ['all', '{"col": "green"}'],
    ['all', '{"e": 4}'],
    ['all', '{"e": {"$type": "either_x", "$value": 4}}'],
    ['all', '{"e": {"$type": "int32", "$value": 4}}'],
    ['all', '{"n": ["a", "b"]}'],
    ['all', '{"l": {"x": 1}}'],
    ['all', '{"l": {"$type": 1, "$value": 2}}'],
    ['all', '{"t": ["a", 1]}'],
    ['all', '{"a": {"a": "x"}}'],
    ['all', '{"a": {"$type": "alias_x", "a": "x"}}'],
    ['all', '{"k": {"number": "n"}}'],
    ['all', '{"oa": {"id": "x", "payment": {"number": "n"}}}'],
    ['all', '{"oa": {"$type": "oa", "id": "x", "payment": {"number": "n"}}}'],
    ['all', '{"oa": {"$type": "order_v1", "id": "x", "payment": {"number": "n"}}}'],
    ['all', '{"els": [{"a": "x"}, {"$type": "rec_x", "a": "y"}]}'],
    ['all', '{"m": {"k": {"a": "x"}}}'],
    ['all', '{"keys": {"3": "three"}}'],
    ['all', '{"tup": [{"a": "x"}, "t"]}'],
    ['all', '{"dis": {"a": "x"}}'],
    ['all', '{"dis": 3}'],
    ['all', '{"dis": {"$type": "rec_x", "a": "x"}}'],
    ['all', '{"pg": {"items": [{"a": "x"}]}}'],
    ['all', '{"pd": {"items": [{"a": "x"}]}}'],
    ['order_v1', '{"id": "x", "payment": {"number": "n"}}'],
    ['order_v1', '{"$type": "order_v1", "id": "x", "payment": {"number": "n"}}'],
    ['oa', '{"id": "x", "payment": {"number": "n"}}'],
    ['count_x', '3'],
    ['names_x', '["a", "b"]'],
    ['lookup_x', '{"$type": 1}'],
  ])('§8.6 a foreign value at %s reads and writes back: %s', (root, json) => {
    readsBack(SHIPPING, root, json);
  });

  it.each([
    [
      'envelope',
      '{"id": "a", "body": {"$type": "order_v1", "$value": {"id": "x", "payment": {"number": "n"}}}}',
    ],
    [
      'single',
      '{"o": {"$type": "rush_v2", "ref": "r", "lines": [], "payment": {"pan": "p"}, "by": "today"}}',
    ],
    ['all', '{"p": {"$type": "dog_x", "name": "rex", "barks": true}}'],
    ['all', '{"p": {"$type": "dog_x", "$value": {"name": "rex", "barks": true}}}'],
    ['all', '{"ct": {"$type": "email_x", "$value": "a@example.com"}}'],
    ['all', '{"h": {"any": {"$type": "memo", "note": "n"}}}'],
    ['all', '{"any": {"$type": "rec_x", "a": "x"}}'],
    ['all', '{"any": {"$type": "count_x", "$value": 3}}'],
    ['all', '{"any": {"$type": "lookup_x", "$value": {"x": 1}}}'],
  ])('§8.6 a foreign value naming its type reads at %s: %s', (root, json) => {
    expect(shown(read(SHIPPING, root, json).diagnostics), json).toEqual([]);
  });

  it('§8.6 scopes nest, each boundary read in the scope enclosing it', () => {
    expect(
      shown(
        read(OUTER, 'outer', '{"h": {"th": {"t": "x"}, "any": {"$type": "memo", "mid": "m"}}}')
          .diagnostics,
      ),
    ).toEqual([]);
    readsBack(OUTER, 'outer', '{"h": {"$type": "holder_x", "th": {"$type": "thing_x", "t": "x"}}}');
  });

  it.each([
    '{"o": {"$type": "order", "ref": "r", "lines": [], "payment": {"pan": "p"}}}',
    '{"o": {"$type": "rush", "ref": "r", "lines": [], "payment": {"pan": "p"}, "by": "b"}}',
    '{"o": {"$type": "express", "ref": "r", "lines": [], "payment": {"pan": "p"}, "at": "noon"}}',
  ])(
    '[TSON-SCHEMA] §7.9 a name the enclosing scope imports is admitted where it reaches the target or a subtype: %s',
    (json) => {
      expect(shown(read(IMPORTER, 'holder', json).diagnostics), json).toEqual([]);
    },
  );

  it('§8.6 a tree holds the foreign value with no tag of either scope', () => {
    const result = read(
      SHIPPING,
      'single',
      '{"o": {"$type": "rush_v2", "ref": "r", "lines": [], "payment": {"$type": "card", "pan": "p"}, "by": "b"}}',
    );
    expect(shown(result.diagnostics)).toEqual([]);
    if (result.value === undefined) throw new Error('no value');
    expect(jsonValueToText(result.value)).toBe(
      '{"o":{"ref":"r","lines":[],"payment":{"pan":"p"},"by":"b"}}',
    );
  });
});

describe('§8.6 refusals at the boundary, each the text encoding’s', () => {
  it('the foreign schema’s own name is refused at the boundary', () => {
    const got = read(
      SHIPPING,
      'single',
      '{"o": {"$type": "order", "ref": "r", "lines": [], "payment": {"pan": "p"}}}',
    ).diagnostics;
    expect(shown(got)).toEqual([
      "UNKNOWN_TYPE_REF /o: 'order' names no type of the enclosing scope, and a tag at a 'order_v2' position, " +
        `which is an extern of 'order' in '${ORDER_2}', is read there: the foreign schema's own names are not, ` +
        'and a tag is admitted where it reaches the target, a subtype of it, or a variant of it ' +
        '(order_v2 | rush_v2) ([TSON-SCHEMA] §7.9)',
    ]);
    expect(refusals(got)).toEqual(
      textRefusals(SHIPPING, '!single { o: !order { ref: r  lines: []  payment: { pan: p } } }'),
    );
  });

  it('a name of the enclosing scope only is refused inside, the diagnostic naming the foreign scope', () => {
    const got = read(
      SHIPPING,
      'all',
      '{"r": {"a": "x", "memo": {"$type": "holder_x", "any": {"$type": "memo", "note": "n"}}}}',
    ).diagnostics;
    expect(got).toHaveLength(1);
    const [only] = got;
    expect(only?.path).toBe('/r/memo');
    expect(only?.message).toContain('holder_x');
    expect(only?.message).toMatch(
      /\(read in the scope of example\.test\/lib\.tn, through the extern 'rec_x' of example\.test\/shipping\.tn; \[TSON-SCHEMA\] §7\.9\)$/,
    );
    expect(only?.schemaId).toBe('example.test/lib.tn');
  });

  it('a tag of another extern is refused', () => {
    const got = read(
      SHIPPING,
      'single',
      '{"o": {"$type": "order_v1", "id": "x", "payment": {"number": "n"}}}',
    ).diagnostics;
    expect(shown(got)).toHaveLength(1);
    expect(shown(got)[0]).toMatch(
      /^TYPE_MISMATCH \/o: 'order_v1' is not admissible at a 'order_v2' position/,
    );
    expect(refusals(got)).toEqual(
      textRefusals(SHIPPING, '!single { o: !order_v1 { id: x  payment: { number: n } } }'),
    );
  });

  it('a name of the enclosing scope reaching another type is refused', () => {
    const got = read(
      IMPORTER,
      'holder',
      '{"o": {"$type": "line", "sku": "s", "qty": 1}}',
    ).diagnostics;
    expect(shown(got)).toEqual([
      "TYPE_MISMATCH /o: 'line' is not admissible at a 'o2' position, which is an extern of 'order' in " +
        `'${ORDER_2}': the tag is read in the enclosing scope, where 'line' reaches another type, and a tag is ` +
        'admitted where it reaches the target, a subtype of it, or a variant of it (order | rush | express | o2) ' +
        '([TSON-SCHEMA] §7.9)',
    ]);
    expect(refusals(got)).toEqual(
      textRefusals(IMPORTER, '!holder { o: !line { sku: s  qty: 1 } }'),
    );
  });

  it('a supertype’s extern is refused at a subtype’s position', () => {
    const got = read(
      SHIPPING,
      'rushed',
      '{"o": {"$type": "order_v2", "ref": "r", "lines": [], "payment": {"pan": "p"}}}',
    ).diagnostics;
    expect(shown(got)).toHaveLength(1);
    expect(shown(got)[0]).toMatch(/^TYPE_MISMATCH \/o: 'order_v2' is not admissible/);
  });

  it('an untagged value at an abstract target with no selectors is refused', () => {
    const got = read(SHIPPING, 'all', '{"p": {"name": "rex"}}').diagnostics;
    expect(got).toHaveLength(1);
    expect(got[0]?.message).toContain('by a name of the enclosing scope, one of (dog_x)');
    expect(refusals(got)).toEqual(textRefusals(SHIPPING, '!all { p: { name: rex } }'));
  });

  it('§3.3, §8.6 an $import inside a foreign value is refused, as at every position but the top', () => {
    const inside = read(
      SHIPPING,
      'all',
      '{"r": {"a": "x", "memo": {"$import": ["https://example.test/lib.tn"], "note": "n"}}}',
    ).diagnostics;
    expect(refusals(inside)).toEqual(['SCOPE_NOT_ADMITTED /r/memo/$import']);
    const boundary = read(
      SHIPPING,
      'all',
      '{"r": {"$import": ["https://example.test/lib.tn"], "$type": "rec_x", "a": "x"}}',
    ).diagnostics;
    expect(refusals(boundary)).toEqual(['SCOPE_NOT_ADMITTED /r/$import']);
    expect(boundary[0]?.message).toMatch(/whose value is read in the scope its schema states/);
  });

  it('an untagged value at a choice of externs is refused', () => {
    const got = read(
      SHIPPING,
      'envelope',
      '{"id": "a", "body": {"id": "x", "payment": {"number": "n"}}}',
    ).diagnostics;
    expect(refusals(got)).toEqual(['TYPE_MISMATCH /body']);
  });

  it('a diagnostic inside a foreign value names the foreign schema, its pointer and the extern', () => {
    const got = read(
      SHIPPING,
      'single',
      '{"o": {"ref": "r", "lines": [{"sku": "s", "qty": 1, "extra": 2}], "payment": {"pan": "p"}}}',
    ).diagnostics;
    expect(got).toHaveLength(1);
    const [only] = got;
    expect(only?.schemaId).toBe('example.test/order-2.tn');
    expect(only?.path).toBe('/o/lines/0/extra');
    expect(only?.schemaPointer?.startsWith('/order')).toBe(true);
    expect(only?.message).toMatch(
      /\(read in the scope of example\.test\/order-2\.tn, through the extern 'order_v2' of example\.test\/shipping\.tn; \[TSON-SCHEMA\] §7\.9\)$/,
    );
    expect(refusals(got)).toEqual(
      textRefusals(
        SHIPPING,
        '!single { o: { ref: r  lines: [{ sku: s  qty: 1  extra: 2 }]  payment: { pan: p } } }',
      ),
    );
  });

  it('a diagnostic in a nested scope names every boundary crossed', () => {
    const got = read(OUTER, 'outer', '{"h": {"th": {"t": 1}}}').diagnostics;
    expect(got).toHaveLength(1);
    expect(got[0]?.schemaId).toBe('example.test/third.tn');
    expect(got[0]?.message).toMatch(
      /\(read in the scope of example\.test\/third\.tn, through the extern 'thing_x' of example\.test\/mid\.tn, within 'holder_x' of example\.test\/outer\.tn; \[TSON-SCHEMA\] §7\.9\)$/,
    );
  });

  it.each([
    [
      'single',
      '/o',
      '{"o": {"$type": "order_v2", "$value": {"$type": "rush", "ref": "r", "lines": [], "payment": {"pan": "p"}, "by": "b"}}}',
    ],
    [
      'single',
      '/o',
      '{"o": {"$type": "order_v2", "$value": {"$type": "rush_v2", "ref": "r", "lines": [], "payment": {"pan": "p"}, "by": "b"}}}',
    ],
    [
      'envelope',
      '/body',
      '{"id": "a", "body": {"$type": "order_v1", "$value": {"$type": "order", "id": "x", "payment": {"number": "n"}}}}',
    ],
    ['all', '/e', '{"e": {"$type": "either_x", "$value": {"$type": "int32", "$value": 4}}}'],
  ])(
    '§3.3, §8.6 one value, one type name: a $type inside a wrapper’s $value is refused at the boundary (%s)',
    (root, path, json) => {
      const got = read(SHIPPING, root, json).diagnostics;
      expect(refusals(got), json).toEqual([`UNKNOWN_TYPE_REF ${path}/$value/$type`]);
      expect(got[0]?.schemaId).toBe('example.test/shipping.tn');
      expect(got[0]?.message).toMatch(
        /^'\$value' is the annotated value itself, and no annotation object/,
      );
    },
  );

  it('a wrapper naming an abstract target is refused whatever its value holds', () => {
    const got = read(
      SHIPPING,
      'all',
      '{"p": {"$type": "pet_x", "$value": {"$type": "dog", "name": "rex", "barks": true}}}',
    ).diagnostics;
    expect(refusals(got)).toEqual(['TYPE_MISMATCH /p']);
    expect(refusals(got)).toEqual(textRefusals(SHIPPING, '!all { p: !pet_x { name: rex } }'));
  });

  it('§9.4 name hygiene runs inside a foreign value, each name judged in the scope that reads it', () => {
    const member = read(
      SHIPPING,
      'single',
      '{"o": {"ref": "r", "lines": [], "pаyment": {"pan": "p"}}}',
    ).diagnostics;
    expect(
      member.some((d) => d.code === 'RESTRICTED_SCRIPT' || d.code === 'CONFUSABLE_NAMES'),
      JSON.stringify(member),
    ).toBe(true);
    expect(member.some((d) => d.code === 'UNRECOGNIZED_FIELD')).toBe(false);
    const boundary = read(
      SHIPPING,
      'single',
      '{"o": {"$type": "orderĲv2", "ref": "r", "lines": [], "payment": {"pan": "p"}}}',
    ).diagnostics;
    expect(boundary.map((d) => d.code)).toEqual(['RESTRICTED_CHARACTER']);
  });
});

describe('§8.1, §8.6 a $type at a choice of externs, or at an extern of a choice', () => {
  function json(fields: string): readonly Diagnostic[] {
    return read(ENV, 'envelope', `{"id": "e", ${fields}}`).diagnostics;
  }
  function text(fields: string): readonly Diagnostic[] {
    return tson.validateDocument(encodeUtf8(`!!import:"${ENV}"\n!envelope { id: e  ${fields} }`))
      .diagnostics;
  }

  it.each([
    ['"body": {"$type": "rush_v1", "id": "x", "by": "y"}', 'body: !rush_v1 { id: x  by: y }'],
    [
      '"body": {"$type": "rush_v1", "$value": {"id": "x", "by": "y"}}',
      'body: !rush_v1 { id: x  by: y }',
    ],
    ['"body": {"$type": "rush_v2", "ref": "x", "due": "y"}', 'body: !rush_v2 { ref: x  due: y }'],
    ['"body": {"$type": "rush_again", "id": "x", "by": "y"}', 'body: !rush_again { id: x  by: y }'],
    ['"body": {"$type": "r1", "id": "x", "by": "y"}', 'body: !r1 { id: x  by: y }'],
    [
      '"box": {"$type": "bulky_v1", "id": "x", "weight": "w"}',
      'box: !bulky_v1 { id: x  weight: w }',
    ],
    ['"box": {"$type": "bulky_v2", "id": "x", "crane": "c"}', 'box: !bulky_v2 { id: x  crane: c }'],
    ['"box": {"$type": "parcel_v2", "id": "x"}', 'box: !parcel_v2 { id: x }'],
    ['"named": {"$type": "rush_v1", "id": "x", "by": "y"}', 'named: !rush_v1 { id: x  by: y }'],
    [
      '"thing": {"$type": "circle_v1", "name": "n", "radius": "r"}',
      'thing: !circle_v1 { name: n  radius: r }',
    ],
    ['"thing": "plain"', 'thing: plain'],
    [
      '"item": {"$type": "circle_v1", "name": "n", "radius": "r"}',
      'item: !circle_v1 { name: n  radius: r }',
    ],
  ])('§5.4 a tag naming a variant or a type IS-A exactly one selects it in both: %s', (j, t) => {
    expect(shown(text(t)), t).toEqual([]);
    expect(shown(json(j)), j).toEqual([]);
  });

  it('the value is read against the entry its tag reaches, in its own scope, in both', () => {
    const got = json('"body": {"$type": "rush_v2", "ref": "x", "due": "y", "by": "z"}');
    expect(got).toHaveLength(1);
    expect(got[0]?.code).toBe('UNRECOGNIZED_FIELD');
    expect(got[0]?.path).toBe('/body/by');
    expect(got[0]?.schemaId).toBe('example.test/a2.tn');
    const fromText = text('body: !rush_v2 { ref: x  due: y  by: z }');
    expect(got.map((d) => `${d.code} ${d.path ?? ''} ${d.schemaId ?? ''}`)).toEqual(
      fromText.map((d) => `${d.code} ${d.path ?? ''} ${d.schemaId ?? ''}`),
    );
  });

  it.each([
    ['"body": {"$type": "card_v1", "number": "n"}', 'body: !card_v1 { number: n }'],
    ['"side": {"$type": "both_v1", "l": "a", "r": "b"}', 'side: !both_v1 { l: a  r: b }'],
    ['"body": {"$type": "rush", "id": "x", "by": "y"}', 'body: !rush { id: x  by: y }'],
    ['"sides": {"$type": "both_v1", "l": "a", "r": "b"}', 'sides: !both_v1 { l: a  r: b }'],
    ['"body": {"$type": "order_v1", "id": "x"}', 'body: !order_v1 { id: x }'],
  ])('§5.4 a tag selecting no variant is refused on one rule in both: %s', (j, t) => {
    const fromText = text(t).map((d) => d.code);
    expect(fromText).not.toEqual([]);
    expect(json(j).map((d) => d.code)).toEqual(fromText);
  });

  it('an unresolved tag and one selecting none are their own refusals', () => {
    expect(json('"body": {"$type": "rush", "id": "x", "by": "y"}').map((d) => d.code)).toEqual([
      'UNKNOWN_TYPE_REF',
    ]);
    const none = shown(json('"side": {"$type": "both_v1", "l": "a", "r": "b"}'));
    expect(none).toHaveLength(1);
    expect(none[0]).toMatch(
      /^TYPE_MISMATCH \/side\/\$type: '\$type' names 'both_v1', a subtype of more than one variant/,
    );
  });
});

describe('§8.2 a choice holding an extern classifies it at its target', () => {
  const FOREIGN = 'https://example.test/json-nested-choice-foreign.tn';
  const SUBJECT = 'https://example.test/json-nested-choice-externs.tn';
  const documents: Record<string, string> = {
    [FOREIGN]: `!!id:"${FOREIGN}"\n!!import:"${CORE}"\n!schema {\n  narrow => ( int32 | text )\n  rec => { a: text }\n}`,
    [SUBJECT]:
      `!!id:"${SUBJECT}"\n!!import:"https://tson.io/2026/40/m/meta.tn"\n!!import:"${CORE}"\n!schema {\n` +
      `  narrow_x => !meta.extern { schema: "${FOREIGN}"  type: narrow }\n` +
      `  rec_x    => !meta.extern { schema: "${FOREIGN}"  type: rec }\n` +
      '  outer    => ( boolean | narrow_x )\n' +
      '  classed  => ( int32 | rec_x )\n' +
      '  h        => { o?: outer  c?: classed }\n}',
  };

  async function subject(): Promise<{ tson: Tson; schema: JsonCompiledSchema }> {
    const encoded: Record<string, Uint8Array> = {};
    for (const [id, text] of Object.entries(documents)) encoded[id] = encodeUtf8(text);
    const instance = standardLibrary({ schemaSource: mapSchemaSource(encoded) });
    const linkedSubject = await instance.loadSchema(documents[SUBJECT] ?? '');
    return { tson: instance, schema: compileJsonSchema(linkedSubject) };
  }

  it('§5.13 a tag naming an extern of a disjoint choice reads the value there, in both encodings', async () => {
    const { tson: instance, schema: compiledSubject } = await subject();
    expect(
      instance.validateDocument(encodeUtf8(`!!import:"${SUBJECT}"\n!h { o: !narrow_x 5 }`))
        .diagnostics,
    ).toEqual([]);
    const result = validateJson('{"o": {"$type": "narrow_x", "$value": 5}}', {
      schema: compiledSubject,
      root: 'h',
    });
    expect(result.diagnostics).toEqual([]);
    if (result.value === undefined) throw new Error('no value');
    expect(jsonValueToText(result.value)).toBe('{"o":5}');
  });

  it('§8.2 an untagged object at a disjoint choice selects the extern whose target is a record', async () => {
    const { schema: compiledSubject } = await subject();
    expect(
      validateJson('{"c": {"a": "x"}}', { schema: compiledSubject, root: 'h' }).diagnostics,
    ).toEqual([]);
    expect(validateJson('{"c": 4}', { schema: compiledSubject, root: 'h' }).diagnostics).toEqual(
      [],
    );
  });
});
