import { describe, expect, it } from 'vitest';
import {
  TsonInternalError,
  TsonParseError,
  TsonUnsupportedDocumentError,
} from '../src/core/errors.js';
import { START } from '../src/core/position.js';
import {
  chunkInput,
  fromString,
  NEED_INPUT,
  runAsync,
  runSync,
  type Task,
} from '../src/io/bytes.js';
import {
  parseAnnotation,
  parseCoreValue,
  parseDataValue,
  parseDocument,
  type ParsedDocument,
} from '../src/compiler/dataParser.js';
import { createDataStream } from '../src/stream/dataStream.js';
import type { EventSource, TsonEvent } from '../src/stream/event.js';
import type { CoreValue, Document, TokenValue } from '../src/ast/value.js';

function parse(text: string): ParsedDocument {
  return runSync(parseDocument(fromString(text)));
}

/** `noUncheckedIndexedAccess`-safe stand-in for `x!` — fails loudly instead of asserting past `undefined`. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a defined value');
  return value;
}

function doc(text: string): Document {
  return parse(text).document;
}

async function parseChunked(text: string, chunkSize: number): Promise<Document> {
  const input = chunkInput();
  const task = parseDocument(input);
  const bytes = new TextEncoder().encode(text);
  const pump = (async () => {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      input.push(bytes.slice(i, i + chunkSize));
      // Give the driver a chance to actually starve on a byte-at-a-time chunk feed.
      await Promise.resolve();
    }
    input.end();
  })();
  const [result] = await Promise.all([runAsync(task, input), pump]);
  return result.document;
}

describe('root value shapes (§2.3, §7.4)', () => {
  it('a bare unquoted token', () => {
    expect(doc('hello')).toEqual({
      root: { annotations: [], coreValue: { kind: 'token', text: 'hello', form: 'unquoted' } },
    });
  });

  it('a single-line quoted token', () => {
    expect(doc('"hi there"')).toEqual({
      root: {
        annotations: [],
        coreValue: { kind: 'token', text: 'hi there', form: 'single-line' },
      },
    });
  });

  it('a multi-line quoted token', () => {
    expect(doc('"""\n  hi\n  """')).toEqual({
      root: { annotations: [], coreValue: { kind: 'token', text: 'hi', form: 'multi-line' } },
    });
  });

  it('the absent sentinel (§2.9)', () => {
    expect(doc('_')).toEqual({ root: { annotations: [], coreValue: { kind: 'absent' } } });
  });

  it('empty braces (§2.8), left unresolved at this layer', () => {
    expect(doc('{}')).toEqual({ root: { annotations: [], coreValue: { kind: 'empty-brace' } } });
  });

  it('empty array', () => {
    expect(doc('[]')).toEqual({
      root: { annotations: [], coreValue: { kind: 'array', elements: [] } },
    });
  });

  it('a record (§2.5), field order preserved', () => {
    expect(doc('{ b: 2 a: 1 }')).toEqual({
      root: {
        annotations: [],
        coreValue: {
          kind: 'record',
          fields: [
            {
              name: 'b',
              value: {
                value: {
                  annotations: [],
                  coreValue: { kind: 'token', text: '2', form: 'unquoted' },
                },
              },
            },
            {
              name: 'a',
              value: {
                value: {
                  annotations: [],
                  coreValue: { kind: 'token', text: '1', form: 'unquoted' },
                },
              },
            },
          ],
        },
      },
    });
  });

  it('a map (§2.6), key is a full data-value', () => {
    expect(doc('{ WELCOME10 => "10%" }')).toEqual({
      root: {
        annotations: [],
        coreValue: {
          kind: 'map',
          entries: [
            {
              key: {
                annotations: [],
                coreValue: { kind: 'token', text: 'WELCOME10', form: 'unquoted' },
              },
              value: {
                value: {
                  annotations: [],
                  coreValue: { kind: 'token', text: '10%', form: 'single-line' },
                },
              },
            },
          ],
        },
      },
    });
  });

  it('an array (§2.7) of three whitespace-separated tokens', () => {
    expect(doc('[1 2 3]')).toEqual({
      root: {
        annotations: [],
        coreValue: {
          kind: 'array',
          elements: [
            {
              value: { annotations: [], coreValue: { kind: 'token', text: '1', form: 'unquoted' } },
            },
            {
              value: { annotations: [], coreValue: { kind: 'token', text: '2', form: 'unquoted' } },
            },
            {
              value: { annotations: [], coreValue: { kind: 'token', text: '3', form: 'unquoted' } },
            },
          ],
        },
      },
    });
  });

  it('nested records/maps/arrays reduce correctly', () => {
    const d = doc('{ items: [ { id: 1 } { id: 2 } ] }');
    const items = defined(
      (
        d.root.coreValue as {
          kind: 'record';
          fields: readonly { name: string; value: { value: { coreValue: unknown } } }[];
        }
      ).fields[0],
    ).value.value.coreValue;
    expect(items).toMatchObject({
      kind: 'array',
      elements: [
        { value: { coreValue: { kind: 'record', fields: [{ name: 'id' }] } } },
        { value: { coreValue: { kind: 'record', fields: [{ name: 'id' }] } } },
      ],
    });
  });
});

describe('annotations (§3.1)', () => {
  it('a valueless annotation', () => {
    expect(doc('@deprecated GOLD')).toEqual({
      root: {
        annotations: [{ name: 'deprecated' }],
        coreValue: { kind: 'token', text: 'GOLD', form: 'unquoted' },
      },
    });
  });

  it('an annotation with a value', () => {
    expect(doc('@expires:"2026-12-31" GOLD')).toEqual({
      root: {
        annotations: [
          {
            name: 'expires',
            value: {
              annotations: [],
              coreValue: { kind: 'token', text: '2026-12-31', form: 'single-line' },
            },
          },
        ],
        coreValue: { kind: 'token', text: 'GOLD', form: 'unquoted' },
      },
    });
  });

  it('a run of annotations before a type-ref', () => {
    const d = doc('@doc:"prose" @owner:{team:"platform"} @deprecated !gold{id:7}');
    expect(d.root.annotations.map((a) => a.name)).toEqual(['doc', 'owner', 'deprecated']);
    expect(d.root.typeRef).toBe('gold');
  });

  it("the spec's own example: an annotation's own value needs a full data-value, not another annotation alone (§3.1)", () => {
    expect(() => doc('{ x: @a:@b:val }')).toThrow(TsonParseError);
  });
});

describe('type references (§3.2)', () => {
  it('a bare type-ref before a record', () => {
    const d = doc('!person{name:Alice}');
    expect(d.root.typeRef).toBe('person');
    expect(d.root.coreValue.kind).toBe('record');
  });

  it('array-type brackets after "!" are rejected (schema syntax, not data syntax)', () => {
    expect(() => doc('![text] [ a b ]')).toThrow(TsonParseError);
  });

  it('the optional "?" suffix after a type-ref is rejected', () => {
    expect(() => doc('!person? { name: Alice }')).toThrow(TsonParseError);
  });

  it('type arguments after a type-ref are rejected', () => {
    expect(() => doc('!paged<order> { items: [ { id: "a" } ] }')).toThrow(TsonParseError);
  });

  it('"!" must be adjacent to the type name (§7.5)', () => {
    expect(() => doc('! person Alice')).toThrow(TsonParseError);
  });
});

describe('document header (§2.2)', () => {
  it('both !!id and !!schema', () => {
    const d = doc(
      '!!id:"https://example.com/orders/1042.tn"\n!!schema:"https://example.com/order.tn"\nAlice\n',
    );
    expect(d.id).toBe('https://example.com/orders/1042.tn');
    expect(d.schema).toBe('https://example.com/order.tn');
    expect(d.root.coreValue).toEqual({ kind: 'token', text: 'Alice', form: 'unquoted' });
  });

  it('neither directive: id/schema are absent, never empty strings', () => {
    const d = doc('Alice');
    expect(d.id).toBeUndefined();
    expect(d.schema).toBeUndefined();
    expect('id' in d).toBe(false);
    expect('schema' in d).toBe(false);
  });

  it('a schema-directive on a record field, not the document header', () => {
    const d = doc('{ x: !!schema:"https://example.com/s.tn" !t 1 }');
    const field = defined(
      (d.root.coreValue as { kind: 'record'; fields: readonly { value: { schemaRef?: string } }[] })
        .fields[0],
    );
    expect(field.value.schemaRef).toBe('https://example.com/s.tn');
  });

  it('!!meta routes through TsonUnsupportedDocumentError, never reaching this layer as a Document', () => {
    expect(() => doc('!!meta:"https://example.com/m.tn"\n{}')).toThrow(
      TsonUnsupportedDocumentError,
    );
  });

  it('a directive argument that is not a URI is rejected (§3.3)', () => {
    expect(() => doc('!!id:"not a uri"\n_')).toThrow(TsonParseError);
  });
});

describe('requireDocumentEnd: pulling past the root value is what rejects trailing content (§7.1)', () => {
  it('a second root-level value after a record is a parse error, not a silently-ignored tail', () => {
    expect(() => doc('{ x: 1 } junk')).toThrow(TsonParseError);
  });

  it('a second bare token after a token root is trailing content, not a second value', () => {
    expect(() => doc('42 43')).toThrow(TsonParseError);
  });

  it(
    'the trap itself: reducing only up to the root value (never asking the stream for one more ' +
      'event) does NOT reject trailing content on its own — parseDocument only rejects it because ' +
      'it pulls past the root, all the way to document-end',
    () => {
      const source = createDataStream(fromString('42 43'));
      runSync(source.next()); // document-start
      const root = runSync(parseDataValue(source));
      // The reducer alone happily returns the first value and never even looks at what follows.
      expect(root).toEqual({
        annotations: [],
        coreValue: { kind: 'token', text: '42', form: 'unquoted' },
      });
      // It is the *next* pull — exactly what parseDocument performs before returning — that is
      // where '§7.1: trailing content is an error' actually gets enforced.
      expect(() => runSync(source.next())).toThrow(TsonParseError);
    },
  );

  it('a trailing comma before a closing brace is rejected (§2.4)', () => {
    expect(() => doc('{ x: 1, }')).toThrow(TsonParseError);
  });

  it('two array elements with no separator between them is rejected (§2.4)', () => {
    expect(() => doc('[{a:1}{b:2}]')).toThrow(TsonParseError);
  });
});

describe('positions are identity-keyed, never structural (WeakMap<CoreValue, Position>)', () => {
  it('two structurally-identical tokens at different occurrences get two distinct positions', () => {
    const { document, positions } = parse('[42 42]');
    const array = document.root.coreValue as {
      kind: 'array';
      elements: readonly { value: { coreValue: CoreValue } }[];
    };
    const [first, second] = array.elements;
    const firstValue = defined(first).value.coreValue;
    const secondValue = defined(second).value.coreValue;

    // Same content, but two different object occurrences.
    expect(firstValue).toEqual(secondValue);
    expect(firstValue).not.toBe(secondValue);

    const firstPos = positions.get(firstValue);
    const secondPos = positions.get(secondValue);
    expect(firstPos).toBeDefined();
    expect(secondPos).toBeDefined();
    // toBe, not toEqual: an identity-keyed lookup returning a shared Position object for two
    // distinct occurrences would still pass a toEqual-only check on offsets, which is exactly
    // the bug a structural (non-identity) map would hide.
    expect(firstPos).not.toBe(secondPos);
    expect(firstPos?.offset).toBe(1);
    expect(secondPos?.offset).toBe(4);
  });

  it('a value that was never produced by this parse has no recorded position at all', () => {
    const { document, positions } = parse('42');
    const lookalike: TokenValue = { kind: 'token', text: '42', form: 'unquoted' };
    // Structurally identical to the real root, but never built by this parser run.
    expect(lookalike).toEqual(document.root.coreValue);
    expect(positions.get(lookalike)).toBeUndefined();
    expect(positions.get(document.root.coreValue)).toBeDefined();
  });

  it('only CoreValue occurrences are recorded — Document/DataValue/Annotation/ScopedValue carry no position of their own', () => {
    const { positions } = parse('@deprecated { x: 1 }');
    const otherSource = createDataStream(fromString('{ x: 1 }'));
    runSync(otherSource.next()); // document-start
    const record = runSync(parseCoreValue(otherSource));
    // parseCoreValue on a *different* run necessarily built different objects; the point here is
    // only that the type system gives CoreValue (not DataValue/Annotation/Document) as the key.
    expect(positions.get(record)).toBeUndefined();
  });
});

describe('the absent sentinel is a value, not a missing key (§2.9)', () => {
  it('a record field explicitly holding "_" is structurally distinct from having no such field', () => {
    const d = doc('{ x: _ }');
    const record = d.root.coreValue as {
      kind: 'record';
      fields: readonly { name: string; value: { value: { coreValue: CoreValue } } }[];
    };
    expect(record.fields).toHaveLength(1);
    expect(defined(record.fields[0]).value.value.coreValue).toEqual({ kind: 'absent' });
  });

  it('"{}" is its own empty-brace core-value, never an empty record with zero fields', () => {
    const empty = doc('{}').root.coreValue;
    expect(empty).toEqual({ kind: 'empty-brace' });
    expect(empty).not.toEqual({ kind: 'record', fields: [] });
  });

  it('"_" is structurally permitted in map-key position at this layer (§2.9: rejecting it is a resolver-layer rule)', () => {
    const d = doc('{ _ => 1 }');
    const map = d.root.coreValue as {
      kind: 'map';
      entries: readonly { key: { coreValue: CoreValue } }[];
    };
    expect(defined(map.entries[0]).key.coreValue).toEqual({ kind: 'absent' });
  });
});

describe('shared reduction entry points (parseDataValue/parseCoreValue/parseAnnotation)', () => {
  it('parseAnnotation reduces one full "@name[:value]" off a raw EventSource', () => {
    const source = createDataStream(fromString('@expires:"2026-12-31" GOLD'));
    runSync(source.next()); // document-start
    const annotation = runSync(parseAnnotation(source));
    expect(annotation).toEqual({
      name: 'expires',
      value: {
        annotations: [],
        coreValue: { kind: 'token', text: '2026-12-31', form: 'single-line' },
      },
    });
    // The stream cursor is left exactly after the annotation, ready for the value that follows.
    const rest = runSync(parseDataValue(source));
    expect(rest).toEqual({
      annotations: [],
      coreValue: { kind: 'token', text: 'GOLD', form: 'unquoted' },
    });
  });

  it('an internal-invariant guard fires on an event no valid document can produce at core-value position', () => {
    // A hand-built EventSource, never reachable from real input, standing in for "the event
    // stream produced something the grammar cannot" — TsonInternalError guards a bug in this
    // library, never a malformed document (a malformed document is always a TsonParseError,
    // raised by Tier 2 before Tier 3 ever sees an event for it).
    const bogusEvent: TsonEvent = { kind: 'document-start', position: START };
    function* bogus(): Task<TsonEvent> {
      if (false as boolean) yield NEED_INPUT; // never taken: keeps this a real Task<T> generator
      return bogusEvent;
    }
    const source: EventSource = { next: bogus, peek: bogus };
    expect(() => runSync(parseCoreValue(source))).toThrow(TsonInternalError);
  });
});

describe('streaming: identical result whether input arrives whole or one byte at a time', () => {
  it('a nested document parses the same over runAsync/chunkInput as over runSync/fromString', async () => {
    const text = '@doc:"x" !order { id: 7 items: [1 2 { sku: "a" qty: 3 }] note: _ }';
    const sync = doc(text);
    const chunked = await parseChunked(text, 1);
    expect(chunked).toEqual(sync);
  });
});
