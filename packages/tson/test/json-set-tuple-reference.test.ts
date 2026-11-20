/**
 * Three spellings Revision 40 changes in [TSON-JSON]'s vocabulary without changing the wire form:
 * a set is described by its facets (§1.6 item 13, §6.2), a one-position tuple is declared (§6.3), and
 * a string at a reference holds a qualified name, so an application or a `kind!` in it is a string
 * outside the kind's grammar (§1.6 item 23, §5.6).
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { compile } from '../src/compiler/compile.js';
import { validate as validateText } from '../src/facade/tree.js';
import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const LINKED = resolveUserSchema(`
!!id:"https://example.test/json-set-tuple-reference.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  stock_id => !net.uuid_type {}
  box      => <T> { v: T }
  names    => set<text>
  faceted  => !meta.array { element_type: text  ordered: false  unique_items: true }
  bounded  => !meta.array { element_type: text  ordered: false  unique_items: true  min_items: 1 }
  one      => !meta.tuple { elements: [ { element_type: text } ] }
  maybe    => !meta.tuple { elements: [ { element_type: text  voidable: true } ] }
  holder   => {
    a: names
    b: faceted
    c?: bounded
    t?: one
    m?: maybe
    k?: meta.ref<net.uuid_type>
  }
}
`);
const JSON_SCHEMA = compileJsonSchema(LINKED);
const TEXT_SCHEMA = compile(LINKED);

function json(body: string): readonly Diagnostic[] {
  return validateJson(body, { schema: JSON_SCHEMA, root: 'holder' }).diagnostics;
}

function text(body: string): readonly Diagnostic[] {
  return validateText(new TextEncoder().encode(body), { schema: TEXT_SCHEMA, root: 'holder' })
    .diagnostics;
}

function codes(found: readonly Diagnostic[]): readonly string[] {
  return found.map((d) => `${d.code} ${d.path ?? ''}`);
}

describe('§6.2: a set is the array whose ordered is false and unique_items is true', () => {
  it('set<T> and the facets that describe it read alike: elements in a JSON array, a duplicate refused at the repeat', () => {
    expect(json('{"a": ["x","y"], "b": ["x","y"]}')).toEqual([]);
    const first = codes(json('{"a": ["x","x"], "b": []}'));
    const second = codes(json('{"a": [], "b": ["x","x"]}'));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.replace('/a/', '/')).toBe(second[0]?.replace('/b/', '/'));
  });

  it('a set may be empty, and states no bound of its own: min_items is a facet written beside the others', () => {
    expect(json('{"a": [], "b": []}')).toEqual([]);
    const found = json('{"a": [], "b": [], "c": []}');
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe('/c');
  });

  it('the two encodings agree on the duplicate and on the empty set', () => {
    const fromText = text('{ a: [ "x" "x" ]  b: [] }');
    const fromJson = json('{"a": ["x","x"], "b": []}');
    expect(fromText.map((d) => d.code)).toEqual(fromJson.map((d) => d.code));
    expect(text('{ a: []  b: [] }')).toEqual([]);
  });
});

describe('§6.3: a one-position tuple, declared, is a JSON array of exactly one element', () => {
  it('["a"] reads, and [], two elements and null at a position that is not voidable are refused', () => {
    expect(json('{"a": [], "b": [], "t": ["a"]}')).toEqual([]);
    expect(json('{"a": [], "b": [], "t": []}')).not.toEqual([]);
    expect(json('{"a": [], "b": [], "t": ["a","b"]}')).not.toEqual([]);
    expect(json('{"a": [], "b": [], "t": [null]}')).not.toEqual([]);
  });

  it('a voidable position’s void value is null in its slot', () => {
    expect(json('{"a": [], "b": [], "m": [null]}')).toEqual([]);
    expect(text('{ a: []  b: []  m: [ _ ] }')).toEqual([]);
  });
});

describe('§5.6: a string at a kind is a qualified name, and nothing else', () => {
  const kind = (name: string): readonly Diagnostic[] =>
    json(`{"a": [], "b": [], "k": ${JSON.stringify(name)}}`);

  it('a name of a member is admitted', () => {
    expect(kind('stock_id')).toEqual([]);
  });

  it('an application is outside the kind’s grammar, whether or not the closure closes it', () => {
    for (const written of ['set<text>', 'pair<box<text> int32>', 'box<text>']) {
      const found = kind(written);
      expect(found.length, written).toBe(1);
      expect(found[0]?.path, written).toBe('/k');
      expect(found[0]?.code, written).toBe('ATOM_FORM_INVALID');
    }
  });

  it('a kind! is outside the kind’s grammar too', () => {
    const found = kind('kind!');
    expect(found.length).toBe(1);
    expect(found[0]?.code).toBe('ATOM_FORM_INVALID');
  });

  it('the text encoding’s quoted token is judged as the JSON string is', () => {
    const quoted = text('{ a: []  b: []  k: "set<text>" }');
    expect(quoted.map((d) => d.code)).toEqual(['ATOM_FORM_INVALID']);
  });
});
