/**
 * `classifyDocument` ([TSON-DATA] §2.2's kind dispatch, §7.1's "classify a document from its
 * opening bytes"): a document is a schema document exactly when its root is tagged `!schema`,
 * read past the root's leading annotations.
 *
 * The interesting assertions here are the negative ones: that a root's value is never read. A
 * classification that happened to be right because it parsed the whole document would pass every
 * positive case below and still be the wrong function.
 */
import { describe, expect, it } from 'vitest';

import { classifyDocument } from '../src/facade/classify.js';
import { TsonLexError, TsonParseError } from '../src/core/errors.js';
import {
  CORE_TN,
  META_TN,
  NET_TN,
  NUMERIC_TN,
  POLICY_TN,
  TEMPORAL_TN,
} from '../src/stdlib/index.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

async function* chunksOf(text: string, size: number): AsyncGenerator<Uint8Array> {
  const bytes = bytesOf(text);
  await Promise.resolve();
  for (let i = 0; i < bytes.length; i += size) {
    yield bytes.subarray(i, i + size);
  }
}

describe('kind dispatch (§2.2)', () => {
  it('a bare value is a data document', () => {
    expect(classifyDocument(bytesOf('{ a: 1 }'))).toEqual({ kind: 'data', imports: [] });
  });

  it('an !!id followed by a value is a data document, and the id comes back', () => {
    expect(classifyDocument(bytesOf('!!id:"https://example.com/d.tn"\n{ a: 1 }'))).toEqual({
      kind: 'data',
      id: 'https://example.com/d.tn',
      imports: [],
    });
  });

  it('an !!import directive is a data document too -- the header does not say what a document is', () => {
    expect(
      classifyDocument(bytesOf('!!import:"https://example.com/s.tn"\n!order { a: 1 }')),
    ).toEqual({
      kind: 'data',
      imports: ['https://example.com/s.tn'],
    });
  });

  it("a root tagged '!schema' is a schema document, whatever it imports", () => {
    expect(classifyDocument(bytesOf('!schema {}\n'))).toEqual({ kind: 'schema', imports: [] });
    expect(
      classifyDocument(bytesOf('!!import:"https://example.com/m.tn"\n!schema { a => text }\n')),
    ).toEqual({ kind: 'schema', imports: ['https://example.com/m.tn'] });
  });

  it('reads the id and every import in header order', () => {
    const header = '!!id:"https://example.com/s.tn"\n!!import:"https://example.com/a.tn"\n';
    expect(
      classifyDocument(bytesOf(`${header}!!import:"https://example.com/b.tn"\n!schema {}\n`)),
    ).toEqual({
      kind: 'schema',
      id: 'https://example.com/s.tn',
      imports: ['https://example.com/a.tn', 'https://example.com/b.tn'],
    });
  });

  it("reads past the root's leading annotations to its tag (§2.2)", () => {
    expect(classifyDocument(bytesOf('@doc:"a schema" @note !schema {}')).kind).toBe('schema');
    expect(classifyDocument(bytesOf('@doc:{ k: v } !schema {}')).kind).toBe('schema');
    expect(classifyDocument(bytesOf('@doc:"x" { a: 1 }')).kind).toBe('data');
  });

  it("'!meta.schema' does not classify (§2.2)", () => {
    expect(classifyDocument(bytesOf('!meta.schema {}')).kind).toBe('data');
  });

  it('a root of any other tag is a data document', () => {
    expect(classifyDocument(bytesOf('!person { name: Ada }')).kind).toBe('data');
  });

  it('classifies the void sentinel as data -- §2.2’s own pure-metadata document', () => {
    expect(classifyDocument(bytesOf('!!id:"https://example.com/reserved.tn"\n_\n'))).toEqual({
      kind: 'data',
      id: 'https://example.com/reserved.tn',
      imports: [],
    });
  });

  it('classifies an empty document as data', () => {
    // No header at all: the first token is EOF, which is no `!!` and no tag, so §2.2's dispatch
    // falls through to data. Whether the *body* is then valid is a question for the parser.
    expect(classifyDocument(bytesOf(''))).toEqual({ kind: 'data', imports: [] });
  });
});

describe('the root value is never read', () => {
  it("classifies a schema document whose map will not parse as data: the root's value is never entered", () => {
    // The entire point of classifying by the tag. `parse` throws for this input.
    expect(classifyDocument(bytesOf('!schema { ][ }}}'))).toMatchObject({ kind: 'schema' });
  });

  it('classifies a document whose body is not valid UTF-8 past the dispatch token', () => {
    // The dispatch reads exactly one token past the header and annotations -- it has to, since
    // that token is what decides between a tag and a value. Malformed bytes after that token
    // are never reached.
    const header = bytesOf('!!id:"https://example.com/d.tn"\n{ a: ');
    const document = new Uint8Array([...header, 0xc3, 0x28, 0x80]);
    expect(classifyDocument(document)).toEqual({
      kind: 'data',
      id: 'https://example.com/d.tn',
      imports: [],
    });
  });

  it('does report malformed bytes standing where the dispatch token belongs', () => {
    // The honest boundary: those bytes are the token classification turns on, so they cannot be
    // skipped, and claiming "data" without having read them would be a guess.
    const document = new Uint8Array([...bytesOf('!!id:"https://example.com/d.tn"\n'), 0xc3, 0x28]);
    expect(() => classifyDocument(document)).toThrow(TsonLexError);
  });

  it('consumes only the chunks the header and the tag need from a stream', async () => {
    // A sniffer classifying an incoming stream must not pull the whole body through. This counts
    // the chunks actually requested rather than trusting that it stops.
    let chunksRead = 0;
    const body = `!schema { padding => "${'x'.repeat(50_000)}" }`;
    async function* counted(): AsyncGenerator<Uint8Array> {
      for await (const chunk of chunksOf(`!!id:"https://example.com/d.tn"\n${body}`, 64)) {
        chunksRead++;
        yield chunk;
      }
    }
    const result = await classifyDocument(counted());
    expect(result).toEqual({ kind: 'schema', id: 'https://example.com/d.tn', imports: [] });
    expect(chunksRead).toBeLessThan(5);
  });

  it('reads identically over a chunked async source', async () => {
    const text =
      '!!id:"https://example.com/s.tn"\n!!import:"https://example.com/m.tn"\n!schema {}\n';
    expect(await classifyDocument(chunksOf(text, 3))).toEqual(classifyDocument(bytesOf(text)));
  });
});

describe('the header itself is still checked', () => {
  it('rejects whitespace between !! and the directive name (§7.5)', () => {
    expect(() => classifyDocument(bytesOf('!! id:"https://example.com/d.tn"\n1'))).toThrow(
      TsonParseError,
    );
  });

  it('rejects a missing colon', () => {
    expect(() => classifyDocument(bytesOf('!!id "https://example.com/d.tn"\n1'))).toThrow(
      TsonParseError,
    );
  });

  it('rejects an unquoted directive argument (§3.3)', () => {
    expect(() => classifyDocument(bytesOf('!!id:example.com/d.tn\n1'))).toThrow(TsonParseError);
  });

  it('rejects a multi-line token as a directive argument (§3.3)', () => {
    expect(() => classifyDocument(bytesOf('!!id:"""\nx\n"""\n1'))).toThrow(TsonParseError);
  });

  it('rejects malformed UTF-8 in the header, rather than substituting U+FFFD (§7.1)', () => {
    expect(() => classifyDocument(new Uint8Array([0x21, 0x21, 0xc3, 0x28]))).toThrow(TsonLexError);
  });

  it('checks the argument as an IRI-reference, as the one header grammar does for every reader (§3.3)', () => {
    expect(() => classifyDocument(bytesOf('!!id:"not a uri"\n1'))).toThrow(TsonParseError);
  });

  it("refuses a retired '!!meta' or '!!schema', naming '!!import' (§3.3)", () => {
    expect(() => classifyDocument(bytesOf('!!meta:"https://example.com/m.tn"\n{}'))).toThrow(
      /!!import/,
    );
    expect(() => classifyDocument(bytesOf('!!schema:"https://example.com/m.tn"\n{}'))).toThrow(
      TsonParseError,
    );
  });
});

describe('against the real bundled schemas', () => {
  it.each([
    ['meta.tn', META_TN],
    ['numeric.tn', NUMERIC_TN],
    ['temporal.tn', TEMPORAL_TN],
    ['net.tn', NET_TN],
    ['core.tn', CORE_TN],
    ['policy.tn', POLICY_TN],
  ])('%s classifies as a schema document, by its root tag', (_file, text) => {
    expect(classifyDocument(bytesOf(text)).kind).toBe('schema');
  });
});
