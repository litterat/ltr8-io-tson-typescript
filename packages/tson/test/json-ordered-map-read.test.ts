/**
 * [TSON-JSON] §6.4: a map with `ordered: true` is delivered in the order it was read, in the
 * object form and the pairs form alike, and its order is part of its identity where a container
 * compares values ([TSON-DATA] §6.1.4, [TSON-SCHEMA] §5.3). An unordered map is the same document
 * read the same way and compared without regard to order.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { compile } from '../src/compiler/compile.js';
import { validate as validateText } from '../src/facade/tree.js';
import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { jsonValueToText } from '../src/json/write.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const LINKED = resolveUserSchema(`
!!id:"https://example.test/json-ordered-1.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  ranked    => !map { key_type: text  value_type: int32  ordered: true }
  loose     => { text => int32 }
  point     => { x: int32  y: int32 }
  ranked_by_point => !map { key_type: point  value_type: text  ordered: true }
  loose_by_point  => { point => text }
  rankings  => set<ranked>
  groupings => set<loose>
}
`);
const JSON_SCHEMA = compileJsonSchema(LINKED);
const TEXT_SCHEMA = compile(LINKED);

function accepted(root: string, source: string): string {
  const result = validateJson(source, { schema: JSON_SCHEMA, root });
  expect(result.diagnostics).toEqual([]);
  if (result.value === undefined) throw new Error('accepted a read with no value');
  return jsonValueToText(result.value);
}

function problems(root: string, source: string): readonly Diagnostic[] {
  return validateJson(source, { schema: JSON_SCHEMA, root }).diagnostics;
}

describe('§6.4 an ordered map is delivered in the order read', () => {
  it('object form: the members come out in the order the document wrote them', () => {
    expect(accepted('ranked', '{"z": 1, "a": 2, "m": 3}')).toBe('{"z":1,"a":2,"m":3}');
  });

  it('pairs form: the entries come out in the order the document wrote them', () => {
    const doc = '[[{"x": 2, "y": 0}, "second"], [{"x": 1, "y": 0}, "first"]]';
    expect(accepted('ranked_by_point', doc)).toBe(
      '[[{"x":2,"y":0},"second"],[{"x":1,"y":0},"first"]]',
    );
  });

  it('an unordered map reads the same way: nothing is reordered either', () => {
    expect(accepted('loose', '{"z": 1, "a": 2}')).toBe('{"z":1,"a":2}');
  });

  it('a repeated key is still the duplicate error, and keeps the first entry’s slot', () => {
    const found = problems('ranked', '{"a": 1, "b": 2, "a": 3}');
    expect(found.map((d) => d.code)).toEqual(['DUPLICATE_MAP_KEY']);
  });
});

describe('§6.4, §6.1.4 order is part of an ordered map’s value identity', () => {
  it('two ordered maps with the same entries in a different order are two set elements', () => {
    expect(problems('rankings', '[{"a": 1, "b": 2}, {"b": 2, "a": 1}]')).toEqual([]);
  });

  it('the same sequence twice is a repeated set element', () => {
    expect(problems('rankings', '[{"a": 1, "b": 2}, {"a": 1, "b": 2}]').map((d) => d.code)).toEqual(
      ['TYPE_MISMATCH'],
    );
  });

  it('two unordered maps with the same entries in a different order are one value', () => {
    expect(
      problems('groupings', '[{"a": 1, "b": 2}, {"b": 2, "a": 1}]').map((d) => d.code),
    ).toEqual(['TYPE_MISMATCH']);
  });

  it('the text encoding agrees on all three', () => {
    const text = (root: string, body: string): readonly string[] =>
      validateText(new TextEncoder().encode(body), { schema: TEXT_SCHEMA, root }).diagnostics.map(
        (d) => d.code,
      );
    expect(text('rankings', '[{ "a" => 1  "b" => 2 } { "b" => 2  "a" => 1 }]')).toEqual([]);
    expect(text('rankings', '[{ "a" => 1  "b" => 2 } { "a" => 1  "b" => 2 }]')).toEqual([
      'TYPE_MISMATCH',
    ]);
    expect(text('groupings', '[{ "a" => 1  "b" => 2 } { "b" => 2  "a" => 1 }]')).toEqual([
      'TYPE_MISMATCH',
    ]);
  });
});
