import { describe, expect, it } from 'vitest';
import { fromString, runSync } from '../src/io/bytes.js';
import { createDataStream } from '../src/stream/dataStream.js';
import { createReadContext } from '../src/reader/context.js';
import { throwing } from '../src/core/diagnostic.js';
import { schemalessTreeReader } from '../src/reader/schemaless/tree.js';
import { TsonWriteError } from '../src/core/errors.js';
import {
  arrayNode,
  atomNode,
  missingNode,
  recordNode,
  tsonDocument,
  type TsonDocument,
  type Value,
} from '../src/tree/nodes.js';
import { writeTree, writeTreeValue } from '../src/write/treeWriter.js';

/**
 * `write/treeWriter.ts` -- the `tree/nodes.ts` writer (§2, §3, §5), ported from
 * `TsonTreeWriter.java`. Driven two ways: real schemaless-read trees (for the annotation/
 * type-ref-preserving cases only a real read produces) and hand-built nodes (for the
 * default-atom-framing cases a schemaless read can never itself produce -- a bare `!float32`
 * value, a hand-built `Uuid`/`Rational`/... with no type-ref at all).
 */

function readSchemaless(text: string): TsonDocument {
  const source = createDataStream(fromString(text));
  const ctx = createReadContext(
    source,
    throwing((d) => new Error(`${d.code}: ${d.message}`)),
  );
  const start = runSync(ctx.next());
  if (start.kind !== 'document-start')
    throw new Error(`expected document-start, got ${start.kind}`);
  const root = runSync(schemalessTreeReader().read(ctx));
  const end = runSync(ctx.next());
  if (end.kind !== 'document-end') throw new Error(`expected document-end, got ${end.kind}`);
  return tsonDocument(root, start.id, start.schema);
}

describe('value-preserving round trip through the real schemaless reader', () => {
  it.each([
    ['a plain record', '{ x: 1 y: "two" }'],
    ['a map with a compound key', '{ [1 2] => "pair" }'],
    ['an array', '[ 1 2 3 ]'],
    [
      "a built-in-typed atom, quoted and type-ref'd",
      '!uuid "01234567-89ab-cdef-0123-456789abcdef"',
    ],
    ["a numeric-family-typed atom, unquoted and type-ref'd", '!int32 42'],
    ['an untyped integer', '5'],
    ['an untyped float', '3.5'],
    ['a boolean', 'true'],
    ['a string', '"hello"'],
    ['absent', '_'],
  ])('%s', (_label, text) => {
    const document = readSchemaless(text);
    const written = writeTree(document);
    const reread = readSchemaless(written);
    expect(reread.root).toEqual(document.root);
  });
});

describe('§3.1 wire annotations are re-emitted, in order, repeats included', () => {
  it('a valueless and a valued annotation both survive a read/write/read cycle', () => {
    const document = readSchemaless('@a @b:1 42');
    const written = writeTree(document);
    expect(written).toBe('@a @b:1 42');
    expect(readSchemaless(written).root).toEqual(document.root);
  });
});

describe('§2.2 header directives', () => {
  it('!!id and !!schema round-trip, with the root keeping the type-ref the schema directive needs', () => {
    const text =
      '!!id:"https://example.com/doc.tn"\n!!schema:"https://example.com/s.tn"\n' +
      '!uuid "01234567-89ab-cdef-0123-456789abcdef"';
    const document = readSchemaless(text);
    const written = writeTree(document);
    const reread = readSchemaless(written);
    expect(reread.id).toBe(document.id);
    expect(reread.schema).toBe(document.schema);
    expect(reread.root).toEqual(document.root);
  });

  it('refuses to write a !!schema document whose root carries no type-ref', () => {
    const document = tsonDocument(atomNode(1n), undefined, 'https://example.com/s.tn');
    expect(() => writeTree(document)).toThrow(TsonWriteError);
  });
});

describe('a MissingNode is a navigation artifact, not a value', () => {
  it('refuses to write one', () => {
    expect(() => writeTreeValue(missingNode('/a/b'))).toThrow(TsonWriteError);
  });
});

describe('atomFraming.ts stage 1 -- a known type-ref formats through its own vocabulary atom', () => {
  it('a float32 value that is a whole number writes with an explicit fractional part, unlike an int32 one', () => {
    expect(writeTreeValue(atomNode(12, 'float32'))).toBe('!float32 12.0');
    expect(writeTreeValue(atomNode(12, 'int32'))).toBe('!int32 12');
  });

  it('rational/complex/date/uuid always write quoted', () => {
    expect(writeTreeValue(atomNode({ numerator: 1n, denominator: 2n }, 'rational'))).toBe(
      '!rational "1/2"',
    );
    expect(writeTreeValue(atomNode({ year: 2024, month: 1, day: 2 }, 'date'))).toBe(
      '!date "2024-01-02"',
    );
  });
});

describe('atomFraming.ts stage 2 -- default (untyped, or unrecognised-type-ref) shape dispatch', () => {
  it('a bigint writes bare, with no type-ref, regardless of magnitude', () => {
    expect(writeTreeValue(atomNode(123456789012345678901234567890n))).toBe(
      '123456789012345678901234567890',
    );
  });

  it('an exact decimal that is whole still writes with a fractional part, or a bare re-parse would narrow it to a bigint', () => {
    const written = writeTreeValue(atomNode({ unscaled: 12n, exponent: 0 }));
    expect(written).toBe('12.0');
  });

  it('a hand-built Uuid with no type-ref writes quoted with a synthesised !uuid', () => {
    const bytes = new Uint8Array([
      0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd,
      0xef,
    ]);
    const written = writeTreeValue(atomNode({ bytes }));
    expect(written).toBe('!uuid "01234567-89ab-cdef-0123-456789abcdef"');
  });

  it('a plain string writes quoted with no synthesised type-ref -- text/uri/email share this host shape', () => {
    expect(writeTreeValue(atomNode('plain text'))).toBe('"plain text"');
  });

  it("a type-ref the built-in vocabulary does not recognise is preserved, framed by the value's own shape", () => {
    expect(writeTreeValue(atomNode('USD', 'currency'))).toBe('!currency "USD"');
  });
});

describe('records/arrays keep child ordering and their own type-refs', () => {
  it('a typed record with typed children', () => {
    const fields = new Map<string, Value>([
      ['id', atomNode(1n)],
      ['tags', arrayNode([atomNode('a'), atomNode('b')])],
    ]);
    const node = recordNode(fields, 'item');
    expect(writeTreeValue(node)).toBe('!item { id: 1 tags: [ "a" "b" ] }');
  });
});
