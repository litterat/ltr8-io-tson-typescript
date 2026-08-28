/**
 * `classifyDocument` ([TSON-DATA] §2.2's kind dispatch, §7.1's "classify a document from its
 * opening bytes").
 *
 * The interesting assertions here are the negative ones: that a body is never read. A
 * classification that happened to be right because it parsed the whole document would pass every
 * positive case below and still be the wrong function.
 */
import { describe, expect, it } from 'vitest';

import { classifyDocument } from '../src/facade/classify.js';
import { TsonLexError, TsonParseError } from '../src/core/errors.js';
import { CORE_TN, META_KERNEL_TN, META_TN } from '../src/stdlib/index.js';

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
    expect(classifyDocument(bytesOf('{ a: 1 }'))).toEqual({ kind: 'data' });
  });

  it('an !!id followed by a value is a data document, and the id comes back', () => {
    expect(classifyDocument(bytesOf('!!id:"https://example.com/d.tn"\n{ a: 1 }'))).toEqual({
      kind: 'data',
      id: 'https://example.com/d.tn',
    });
  });

  it('an !!schema directive is still a data document -- only !!meta makes a schema', () => {
    expect(classifyDocument(bytesOf('!!schema:"https://example.com/s.tn"\n{ a: 1 }'))).toEqual({
      kind: 'data',
    });
  });

  it('an !!meta directive makes it a schema document, and its argument comes back', () => {
    expect(classifyDocument(bytesOf('!!meta:"https://example.com/m.tn"\n{}\n'))).toEqual({
      kind: 'schema',
      meta: 'https://example.com/m.tn',
    });
  });

  it('reads !!id then !!meta -- the two directives of lookahead §2.2 allows, and no more', () => {
    const header = '!!id:"https://example.com/s.tn"\n!!meta:"https://example.com/m.tn"\n';
    expect(classifyDocument(bytesOf(`${header}!!import:"https://example.com/i.tn"\n{}\n`))).toEqual(
      {
        kind: 'schema',
        id: 'https://example.com/s.tn',
        meta: 'https://example.com/m.tn',
      },
    );
  });

  it('classifies the absent sentinel as data -- §2.2’s own pure-metadata document', () => {
    expect(classifyDocument(bytesOf('!!id:"https://example.com/reserved.tn"\n_\n'))).toEqual({
      kind: 'data',
      id: 'https://example.com/reserved.tn',
    });
  });

  it('classifies an empty document as data', () => {
    // No header at all: the first token is EOF, which is not `!!`, so §2.2's dispatch falls
    // through to data. Whether the *body* is then valid is a question for the parser.
    expect(classifyDocument(bytesOf(''))).toEqual({ kind: 'data' });
  });
});

describe('the body is never read', () => {
  it('classifies a document whose body will not parse', () => {
    // The entire point of a header-only classifier. `parse` throws for this input.
    expect(classifyDocument(bytesOf('!!meta:"https://example.com/m.tn"\n{ ][ }}}'))).toMatchObject({
      kind: 'schema',
    });
  });

  it('classifies a document whose body is not valid UTF-8 past the dispatch token', () => {
    // The dispatch reads exactly one token past the last header directive -- it has to, since
    // that token is what decides between `!!meta` and a value. Malformed bytes after that token
    // are never reached.
    const header = bytesOf('!!id:"https://example.com/d.tn"\n{ a: ');
    const document = new Uint8Array([...header, 0xc3, 0x28, 0x80]);
    expect(classifyDocument(document)).toEqual({ kind: 'data', id: 'https://example.com/d.tn' });
  });

  it('does report malformed bytes standing where the dispatch token belongs', () => {
    // The honest boundary: those bytes are the token classification turns on, so they cannot be
    // skipped, and claiming "data" without having read them would be a guess.
    const document = new Uint8Array([...bytesOf('!!id:"https://example.com/d.tn"\n'), 0xc3, 0x28]);
    expect(() => classifyDocument(document)).toThrow(TsonLexError);
  });

  it('consumes only the chunks the header needs from a stream', async () => {
    // A sniffer classifying an incoming stream must not pull the whole body through. This counts
    // the chunks actually requested rather than trusting that it stops.
    let chunksRead = 0;
    const body = `{ padding: "${'x'.repeat(50_000)}" }`;
    async function* counted(): AsyncGenerator<Uint8Array> {
      for await (const chunk of chunksOf(`!!id:"https://example.com/d.tn"\n${body}`, 64)) {
        chunksRead++;
        yield chunk;
      }
    }
    const result = await classifyDocument(counted());
    expect(result).toEqual({ kind: 'data', id: 'https://example.com/d.tn' });
    expect(chunksRead).toBeLessThan(5);
  });

  it('reads identically over a chunked async source', async () => {
    const text = '!!id:"https://example.com/s.tn"\n!!meta:"https://example.com/m.tn"\n{}\n';
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

  it('does not check the argument’s URI syntax, which the parser owns', () => {
    // Deliberate: a caller asking "which kind of document is this" gains nothing from a URI
    // check here, and `parse`/`parseSchemaDocument` reject it anyway.
    expect(classifyDocument(bytesOf('!!id:"not a uri"\n1'))).toEqual({
      kind: 'data',
      id: 'not a uri',
    });
  });
});

describe('against the real bundled schemas', () => {
  it.each([
    ['meta-kernel.tn', META_KERNEL_TN],
    ['meta.tn', META_TN],
    ['core.tn', CORE_TN],
  ])('%s classifies as a schema document', (_file, text) => {
    expect(classifyDocument(bytesOf(text)).kind).toBe('schema');
  });
});
