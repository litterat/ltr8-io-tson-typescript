import { describe, expect, it } from 'vitest';
import { fromString, runSync } from '../src/io/bytes.js';
import { parseDocument } from '../src/compiler/dataParser.js';
import { writeDataValue, writeDocument } from '../src/write/astWriter.js';
import type { Document } from '../src/ast/value.js';

/**
 * `write/astWriter.ts` -- the syntax-preserving writer (§2, §3, §7.4), ported from
 * `AstWriter.java`. `parse(text)` below is a thin wrapper over the real Tier 3 parser
 * (`compiler/dataParser.ts`, over the real lexer and event stream), matching this repo's own
 * "drive against real source text" test convention rather than hand-building AST fixtures.
 */

function parse(text: string): Document {
  return runSync(parseDocument(fromString(text))).document;
}

/** Parse, write, and return the written text -- the round-trip shape every test here checks. */
function roundTrip(text: string): string {
  return writeDocument(parse(text));
}

describe('§7.4 core-value shapes -- byte-identical round trip, since the AST preserves source exactly', () => {
  it.each([
    'null',
    'true',
    'false',
    '42',
    '-3.5',
    '0xFF',
    '"a quoted string"',
    'unquoted_token',
    '_',
    '{}',
    '{ x: 1 y: 2 }',
    '{ "a" => 1 "b" => 2 }',
    '[ 1 2 3 ]',
    '[]',
  ])('%s', (text) => {
    expect(roundTrip(text)).toBe(text);
  });
});

describe('§2.4/§4.4 token form is preserved, not reinterpreted', () => {
  it('a quoted token that looks like a number stays quoted', () => {
    expect(roundTrip('"42"')).toBe('"42"');
  });

  it('a quoted token that looks like null stays quoted', () => {
    expect(roundTrip('"null"')).toBe('"null"');
  });

  it('an unquoted token is never re-quoted', () => {
    expect(roundTrip('hello')).toBe('hello');
  });
});

describe('§3.1 annotations -- order, repeats, and value framing preserved', () => {
  it('a valueless annotation round-trips', () => {
    expect(roundTrip('@deprecated null')).toBe('@deprecated null');
  });

  it('a valued annotation round-trips with its own value nested', () => {
    expect(roundTrip('@doc:"hi" 42')).toBe('@doc:"hi" 42');
  });

  it('repeated annotations on one value keep their order', () => {
    expect(roundTrip('@a @b:1 @c 42')).toBe('@a @b:1 @c 42');
  });
});

describe('§3.2 type annotations', () => {
  it('a root type-ref round-trips', () => {
    expect(roundTrip('!uuid "01234567-89ab-cdef-0123-456789abcdef"')).toBe(
      '!uuid "01234567-89ab-cdef-0123-456789abcdef"',
    );
  });

  it('a nested type-ref round-trips independently of its parent', () => {
    expect(roundTrip('{ x: !int32 1 }')).toBe('{ x: !int32 1 }');
  });
});

describe('§3.3 directives', () => {
  it('a document !!id round-trips ahead of the root value', () => {
    const text = '!!id:"https://example.com/doc.tn"\nnull';
    expect(roundTrip(text)).toBe(text);
  });

  it('!!id and every !!import round-trip in order (§2.2)', () => {
    const text =
      '!!id:"https://example.com/doc.tn"\n!!import:"https://example.com/schema.tn"\n' +
      '!!import:"https://example.com/other.tn"\n42';
    expect(roundTrip(text)).toBe(text);
  });

  it('a reference in a value round-trips as the unquoted token its qualified name is (§4.1, §7.4)', () => {
    expect(roundTrip('{ t: geo.address }')).toBe('{ t: geo.address }');
  });

  it('an application or a sibling mark is no data value, so the grammar never reaches the writer with one (§4.1)', () => {
    expect(() => parse('{ t: map<text list<int32>> }')).toThrow();
    expect(() => parse('{ v: kind! }')).toThrow();
  });

  it('a directive written at a value position would not read back: the writer has no way to put one there (§2.2, §3.3)', () => {
    // The data grammar is closed: a directive stands in the header alone, so the AST has no node
    // that could carry one at a field value, an entry value or an element.
    expect(() => parse('{ x: !!import:"https://example.com/s.tn" 1 }')).toThrow();
  });
});

describe('§7.2.3 multi-line tokens round-trip through the real lexer/writer pair', () => {
  it('a simple multi-line value comes back byte-identical when already written at column-0 indent', () => {
    const text = '"""\nline one\nline two\n"""\n';
    expect(roundTrip(text)).toBe(text);
  });

  it('an indented multi-line value round-trips to its own decoded value, re-spelled at column 0', () => {
    // §7.2.3: common indentation is stripped on read, so the decoded value has none left to
    // write back -- the *value* round-trips, the exact source bytes do not, which is exactly
    // what this port's own value-preserving round trip needs.
    const written = writeDataValue(parse('"""\n  line one\n  line two\n  """').root);
    expect(written).toBe('"""\nline one\nline two\n"""\n');
    // And that written form reads back to the identical decoded value.
    expect(parse(written).root).toEqual(parse('"""\n  line one\n  line two\n  """').root);
  });
});

describe('writeDataValue -- the bare data-value entry point, with no document header', () => {
  it('writes just the root value, ignoring any header the source declared', () => {
    const document = parse('!!id:"https://example.com/doc.tn"\n{ x: 1 }');
    expect(writeDataValue(document.root)).toBe('{ x: 1 }');
  });
});
