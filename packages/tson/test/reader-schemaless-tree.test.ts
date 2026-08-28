import { describe, expect, it } from 'vitest';
import { runSync } from '../src/io/bytes.js';
import { schemalessTreeReader } from '../src/reader/schemaless/tree.js';
import { bodyContextOver, collectingContextOver } from './reader-tree-helpers.js';
import type { ArrayNode, AtomNode, MapNode, RecordNode, Value } from '../src/tree/nodes.js';
import type { Uuid } from '../src/value/types.js';

/**
 * `reader/schemaless/tree.ts` -- ported from `reader/SchemalessTreeReader.java`, the schemaless
 * (Class 1) tree-producing reader, and `reader/TypeRefCheck.java`'s rules as this reader applies
 * them. Driven against a real event stream (`stream/dataStream.ts`) over real document text, per
 * `CLAUDE.md`'s "never index a JS string by UTF-16 unit" and this project's own established test
 * style (`reader-tree-helpers.ts`).
 */

function readFail(text: string): Value {
  return runSync(schemalessTreeReader().read(bodyContextOver(text)));
}

function readCollect(text: string, options?: Parameters<typeof schemalessTreeReader>[0]) {
  const { ctx, diagnostics } = collectingContextOver(text);
  const value = runSync(schemalessTreeReader(options).read(ctx));
  return { value, diagnostics: diagnostics.diagnostics };
}

describe('schemalessTreeReader -- base type resolution leaves (§4, no type-ref)', () => {
  it('null resolves to the absent node', () => {
    expect(readFail('null')).toEqual({ kind: 'absent', annotations: { values: [] } });
  });

  it('true/false resolve to boolean atoms', () => {
    expect((readFail('true') as AtomNode).value).toBe(true);
    expect((readFail('false') as AtomNode).value).toBe(false);
  });

  it('an integer token always narrows to bigint, regardless of magnitude -- untyped values never narrow to a fixed width', () => {
    expect((readFail('5') as AtomNode).value).toBe(5n);
    expect((readFail('-5') as AtomNode).value).toBe(-5n);
  });

  it('a based-integer token narrows through the same exact bigint path', () => {
    expect((readFail('0xFF') as AtomNode).value).toBe(255n);
  });

  it('a float token narrows to the exact TsonDecimal shape', () => {
    expect((readFail('3.5') as AtomNode).value).toEqual({ unscaled: 35n, exponent: -1 });
  });

  it('.nan/.inf/-.inf narrow to a JS number, the one case with no exact intermediate', () => {
    expect((readFail('.nan') as AtomNode).value).toBeNaN();
    expect((readFail('.inf') as AtomNode).value).toBe(Infinity);
    expect((readFail('-.inf') as AtomNode).value).toBe(-Infinity);
  });

  it('a quoted token is always a string, even one that looks like null/a number (§4.4)', () => {
    expect((readFail('"null"') as AtomNode).value).toBe('null');
    expect((readFail('"42"') as AtomNode).value).toBe('42');
  });

  it('an unquoted token matching none of null/boolean/number is a string', () => {
    expect((readFail('hello') as AtomNode).value).toBe('hello');
  });
});

describe('schemalessTreeReader -- built-in vocabulary leaves (§5, TypeRefCheck rule 1)', () => {
  it('a built-in type-ref narrows the token through vocabulary.ts, carrying the wire name as typeRef', () => {
    const node = readFail('!uuid "01234567-89ab-cdef-0123-456789abcdef"') as AtomNode;
    expect(node.typeRef).toBe('uuid');
    expect((node.value as Uuid).bytes).toHaveLength(16);
  });

  it('reports ATOM_CONSTRAINT_VIOLATION and reads as absent when the token violates the atom', () => {
    const { value, diagnostics } = readCollect('!uuid "not-a-uuid"');
    expect(diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
    expect(value).toEqual({ kind: 'absent', typeRef: 'uuid', annotations: { values: [] } });
  });

  it('reports TYPE_MISMATCH (TypeRefCheck rule: built-ins are scalar) when a built-in name sits on a container, but still reads the container structurally', () => {
    const { value, diagnostics } = readCollect('!uuid { }');
    expect(diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
    expect(value.kind).toBe('record');
    expect((value as RecordNode).typeRef).toBe('uuid');
  });
});

describe('schemalessTreeReader -- unknown type-refs (TypeRefCheck rule 3)', () => {
  it('reports UNKNOWN_TYPE_REF and still reads the value through base type resolution', () => {
    const { value, diagnostics } = readCollect('!not_a_real_type 5');
    expect(diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
    expect(value).toEqual({
      kind: 'atom',
      value: 5n,
      typeRef: 'not_a_real_type',
      annotations: { values: [] },
    });
  });

  it('a built-in name is case-sensitive (§5.1) -- `!Uuid` is UNKNOWN_TYPE_REF, not `!uuid`', () => {
    const { diagnostics } = readCollect('!Uuid "x"');
    expect(diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
  });

  it('preserveUnknownTypeRefs keeps the marker on the node without reporting it', () => {
    const { value, diagnostics } = readCollect('!not_a_real_type 5', {
      preserveUnknownTypeRefs: true,
    });
    expect(diagnostics).toEqual([]);
    expect((value as AtomNode).typeRef).toBe('not_a_real_type');
  });
});

describe('schemalessTreeReader -- record (§2.5)', () => {
  it('reads named fields into a RecordNode', () => {
    const value = readFail('{ name: "Ada"  age: 36 }') as RecordNode;
    expect(value.kind).toBe('record');
    expect((value.fields.get('name') as AtomNode).value).toBe('Ada');
    expect((value.fields.get('age') as AtomNode).value).toBe(36n);
  });

  it('a container type-ref is checked the same as a leaf one (TypeRefCheck rule 3 applies uniformly) -- a non-built-in name is UNKNOWN_TYPE_REF but the record still reads', () => {
    const { value, diagnostics } = readCollect('!person { name: "Ada" }');
    expect(diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
    expect((value as RecordNode).typeRef).toBe('person');
    expect(((value as RecordNode).fields.get('name') as AtomNode).value).toBe('Ada');

    const preserved = readCollect('!person { name: "Ada" }', { preserveUnknownTypeRefs: true });
    expect(preserved.diagnostics).toEqual([]);
    expect((preserved.value as RecordNode).typeRef).toBe('person');
  });

  it('{} resolves to an empty record -- schemaless has no map/record ambiguity to defer', () => {
    const value = readFail('{}') as RecordNode;
    expect(value.kind).toBe('record');
    expect(value.fields.size).toBe(0);
  });

  it('reports DUPLICATE_FIELD and keeps the last value (§2.5)', () => {
    const { value, diagnostics } = readCollect('{ a: 1  a: 2 }');
    expect(diagnostics.map((d) => d.code)).toEqual(['DUPLICATE_FIELD']);
    expect(((value as RecordNode).fields.get('a') as AtomNode).value).toBe(2n);
  });
});

describe('schemalessTreeReader -- array (§2.7)', () => {
  it('reads elements into an ArrayNode -- schemaless never produces a TupleNode', () => {
    const value = readFail('[1 2 3]') as ArrayNode;
    expect(value.kind).toBe('array');
    expect(value.elements.map((e) => (e as AtomNode).value)).toEqual([1n, 2n, 3n]);
  });
});

describe('schemalessTreeReader -- map (§2.6)', () => {
  it('reads entries into a MapNode, keys as nodes of their own', () => {
    const value = readFail('{ "a" => 1  "b" => 2 }') as MapNode;
    expect(value.kind).toBe('map');
    expect(value.entries).toHaveLength(2);
    expect((value.entries[0]?.key as AtomNode).value).toBe('a');
    expect((value.entries[0]?.value as AtomNode).value).toBe(1n);
  });

  it('reports DUPLICATE_MAP_KEY comparing decoded values (§2.6) -- 0xFF and 255 are one key', () => {
    const { diagnostics } = readCollect('{ 0xFF => 1  255 => 2 }');
    expect(diagnostics.map((d) => d.code)).toEqual(['DUPLICATE_MAP_KEY']);
  });

  it('duplicate detection is structural, not reference equality -- two equal nested-array keys collide', () => {
    const { diagnostics } = readCollect('{ [1 2] => "x"  [1 2] => "y" }');
    expect(diagnostics.map((d) => d.code)).toEqual(['DUPLICATE_MAP_KEY']);
  });

  it('two different keys never collide', () => {
    const { diagnostics } = readCollect('{ [1 2] => "x"  [1 3] => "y" }');
    expect(diagnostics).toEqual([]);
  });
});

describe('schemalessTreeReader -- wire annotations (§3.1)', () => {
  it("captures a value's own leading annotations, valueless and valued alike", () => {
    const value = readFail('@deprecated @doc:"n" 5') as AtomNode;
    expect(value.annotations.values.map((a) => a.name)).toEqual(['deprecated', 'doc']);
    expect(value.annotations.values[1]?.value?.coreValue).toEqual({
      kind: 'token',
      text: 'n',
      form: 'single-line',
    });
  });

  it('captures annotations on a record field value', () => {
    const value = readFail('{ a: @doc:"n" 5 }') as RecordNode;
    const field = value.fields.get('a') as AtomNode;
    expect(field.annotations.values.map((a) => a.name)).toEqual(['doc']);
  });
});
