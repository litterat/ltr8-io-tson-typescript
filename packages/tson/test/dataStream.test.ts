import { describe, expect, it } from 'vitest';
import {
  TsonInternalError,
  TsonParseError,
  TsonUnsupportedDocumentError,
} from '../src/core/errors.js';
import { chunkInput, fromString, runAsync, runSync } from '../src/io/bytes.js';
import { createDataStream } from '../src/stream/dataStream.js';
import type { TsonEvent } from '../src/stream/event.js';

/** Drives an {@link EventSource} to completion over already-complete input. */
function events(text: string): TsonEvent[] {
  const source = createDataStream(fromString(text));
  const list: TsonEvent[] = [];
  for (;;) {
    const event = runSync(source.next());
    list.push(event);
    if (event.kind === 'document-end') return list;
  }
}

/** A compact, order-and-content-sensitive rendering of one event, for exact-shape assertions. */
function describeEvent(e: TsonEvent): string {
  switch (e.kind) {
    case 'document-start':
      return `DocumentStart(${e.id ?? ''}|${e.schema ?? ''})`;
    case 'document-end':
      return 'DocumentEnd';
    case 'record-start':
      return 'RecordStart';
    case 'field-name':
      return `FieldName(${e.name})`;
    case 'record-end':
      return 'RecordEnd';
    case 'map-start':
      return 'MapStart';
    case 'map-arrow':
      return 'MapArrow';
    case 'map-end':
      return 'MapEnd';
    case 'array-start':
      return 'ArrayStart';
    case 'array-end':
      return 'ArrayEnd';
    case 'annotation-start':
      return `AnnotationStart(${e.name})`;
    case 'annotation-end':
      return 'AnnotationEnd';
    case 'type-ref':
      return `TypeRef(${e.name})`;
    case 'schema-ref':
      return `SchemaRef(${e.uri})`;
    case 'token':
      return `Token(${e.text},${e.form})`;
    case 'absent':
      return 'Absent';
    case 'empty-brace':
      return 'EmptyBrace';
  }
}

function shape(text: string): string[] {
  return events(text).map(describeEvent);
}

function thrownBy(text: string): unknown {
  try {
    events(text);
  } catch (e) {
    return e;
  }
  throw new Error(`expected parsing '${text}' to throw, but it completed`);
}

// ── Bare core values as the whole document (§2.3, §7.4) ────────────────────

describe('a data value at the document root (§2.3, §7.4)', () => {
  it('an unquoted token is the whole document', () => {
    expect(shape('Alice')).toEqual(['DocumentStart(|)', 'Token(Alice,unquoted)', 'DocumentEnd']);
  });

  it('a quoted token is the whole document', () => {
    expect(shape('"has spaces"')).toEqual([
      'DocumentStart(|)',
      'Token(has spaces,single-line)',
      'DocumentEnd',
    ]);
  });

  it('the absent sentinel is the whole document (§2.9)', () => {
    expect(shape('_')).toEqual(['DocumentStart(|)', 'Absent', 'DocumentEnd']);
  });

  it('"{}" resolves to its own empty-brace event, not a record or map (§2.8)', () => {
    expect(shape('{}')).toEqual(['DocumentStart(|)', 'EmptyBrace', 'DocumentEnd']);
    expect(shape('{   }')).toEqual(['DocumentStart(|)', 'EmptyBrace', 'DocumentEnd']);
  });
});

// ── Document header (§2.2) ───────────────────────────────────────────────

describe('the document header (§2.2)', () => {
  it('carries an !!id directive, uninterpreted, on DocumentStart', () => {
    const es = events('!!id:"https://example.com/x.tn"\n_');
    const start = es[0];
    expect(start?.kind).toBe('document-start');
    expect(start).toMatchObject({ id: 'https://example.com/x.tn' });
    expect((start as { schema?: string }).schema).toBeUndefined();
  });

  it('carries !!id then !!schema, both uninterpreted, in one DocumentStart', () => {
    const es = events(
      '!!id:"https://example.com/orders/1042.tn"\n' +
        '!!schema:"https://example.com/order.tn"\n' +
        'Alice\n',
    );
    expect(es[0]).toMatchObject({
      kind: 'document-start',
      id: 'https://example.com/orders/1042.tn',
      schema: 'https://example.com/order.tn',
    });
    expect(es[1]).toEqual(expect.objectContaining({ kind: 'token', text: 'Alice' }));
  });

  it('!!schema is legal without a preceding !!id', () => {
    const es = events('!!schema:"https://example.com/order.tn" Alice');
    expect(es[0]).toMatchObject({
      kind: 'document-start',
      schema: 'https://example.com/order.tn',
    });
    expect((es[0] as { id?: string }).id).toBeUndefined();
  });

  it('syntax-checks the id/schema argument as a URI (§3.3)', () => {
    // The shared conformance vector parser/invalid/directive-argument-not-a-uri files this under
    // category: parser, so the check belongs at this tier and not a later one. Java validates
    // here too, via its atom-layer UriParser; this port has an atom layer to lean on and no zone
    // rule against reaching it, so it uses the same RFC 3986 grammar the !uri atom does.
    expect(() => events('!!schema:"not a uri at all" Alice')).toThrow(TsonParseError);
  });

  it('preserves a valid id/schema argument raw, uninterpreted', () => {
    // event.ts documents id/schema as "the raw URI arguments, uninterpreted". Checking that text
    // is a URI is not interpreting it: nothing is resolved, normalised, or rewritten, and the
    // event still carries exactly what was written.
    const es = events('!!schema:"HTTPS://Example.COM/../m.tn" Alice');
    expect(es[0]).toMatchObject({
      kind: 'document-start',
      schema: 'HTTPS://Example.COM/../m.tn',
    });
  });

  it('!!meta rejects the document as unsupported, not as malformed (§1.5, §2.2)', () => {
    expect(() => events('!!meta:"https://example.com/m.tn" { }')).toThrow(
      TsonUnsupportedDocumentError,
    );
  });

  it('!!id then !!meta is still rejected as a schema document', () => {
    expect(() =>
      events('!!id:"https://example.com/x.tn"\n!!meta:"https://example.com/m.tn" { }'),
    ).toThrow(TsonUnsupportedDocumentError);
  });

  it('a directive name outside its closed positional set is a parse error, not "null" (§3.3)', () => {
    // Deliberate divergence from the Java reference: when the token after "!!" is not even a
    // directive-name shape, Java's peekDirectiveName() returns null and the message embeds the
    // literal string "null". This port names the actual offending token instead.
    const error = thrownBy('!!"x":"y"');
    expect(error).toBeInstanceOf(TsonParseError);
    expect((error as Error).message).not.toContain('null');
    expect((error as Error).message).toContain("the quoted token 'x'");
  });

  it('a directive name that is not "id"/"schema"/"meta" in header position is a parse error', () => {
    expect(() => events('!!import:"https://example.com/x.tn" Alice')).toThrow(TsonParseError);
  });
});

describe('pulling past the document root rejects trailing content (§7.4, RootFrame)', () => {
  it('unexpected content after the root value is a parse error from the stream itself', () => {
    // The trap CLAUDE.md names: nothing fails if a caller simply stops reading early. Pulling
    // all the way through is what makes trailing content get rejected.
    const error = thrownBy('Alice Bob');
    expect(error).toBeInstanceOf(TsonParseError);
    expect((error as Error).message).toContain("unexpected content after the document's value");
  });

  it('a caller that stops before DocumentEnd never sees the trailing-content error', () => {
    const source = createDataStream(fromString('Alice Bob'));
    const first = runSync(source.next());
    expect(first.kind).toBe('document-start');
    const second = runSync(source.next());
    expect(second).toEqual(expect.objectContaining({ kind: 'token', text: 'Alice' }));
    // Stopping here (never pulling DocumentEnd) never throws.
  });
});

// ── Records (§2.5) ───────────────────────────────────────────────────────

describe('records (§2.5)', () => {
  it('one field', () => {
    expect(shape('{ name: Alice }')).toEqual([
      'DocumentStart(|)',
      'RecordStart',
      'FieldName(name)',
      'Token(Alice,unquoted)',
      'RecordEnd',
      'DocumentEnd',
    ]);
  });

  it('no separator is required around the braces themselves (§2.4)', () => {
    expect(shape('{name:Alice}')).toEqual(shape('{ name: Alice }'));
  });

  it('fields may mix comma and whitespace separators', () => {
    expect(shape('{ a: 1, b: 2 c: 3 }')).toEqual([
      'DocumentStart(|)',
      'RecordStart',
      'FieldName(a)',
      'Token(1,unquoted)',
      'FieldName(b)',
      'Token(2,unquoted)',
      'FieldName(c)',
      'Token(3,unquoted)',
      'RecordEnd',
      'DocumentEnd',
    ]);
  });

  it('a field name may be a quoted token (§2.5 field-name = token)', () => {
    const es = events('{ "name": Alice }');
    expect(es[2]).toEqual(expect.objectContaining({ kind: 'field-name', name: 'name' }));
  });

  it('field order and duplicates are preserved, not deduplicated -- a resolver-layer concern (§1.2)', () => {
    expect(shape('{ x: 1 x: 2 }')).toEqual([
      'DocumentStart(|)',
      'RecordStart',
      'FieldName(x)',
      'Token(1,unquoted)',
      'FieldName(x)',
      'Token(2,unquoted)',
      'RecordEnd',
      'DocumentEnd',
    ]);
  });

  it('nests', () => {
    expect(shape('{ customer: { name: Alice } }')).toEqual([
      'DocumentStart(|)',
      'RecordStart',
      'FieldName(customer)',
      'RecordStart',
      'FieldName(name)',
      'Token(Alice,unquoted)',
      'RecordEnd',
      'RecordEnd',
      'DocumentEnd',
    ]);
  });

  it('a field value may be the absent sentinel', () => {
    expect(shape('{ x: _ }')).toEqual([
      'DocumentStart(|)',
      'RecordStart',
      'FieldName(x)',
      'Absent',
      'RecordEnd',
      'DocumentEnd',
    ]);
  });

  it('a trailing comma before "}" is a parse error (§2.4)', () => {
    expect(() => events('{ x: 1, }')).toThrow(TsonParseError);
  });

  it('zero-width separation between fields is a parse error (§2.4)', () => {
    expect(() => events('{ a: "x"b: "y" }')).toThrow(TsonParseError);
  });

  it('an annotated value cannot stand as a field name (§2.5: field names are bare tokens)', () => {
    expect(() => events('{ @deprecated x: 1 }')).toThrow(TsonParseError);
  });

  it('a typed value cannot stand as a field name', () => {
    expect(() => events('{ !string x: 1 }')).toThrow(TsonParseError);
  });

  it('a mismatch names the construct and carries expected/actual structurally', () => {
    // The frozen TsonParseError contract: message, position, and an { expected, actual } pair
    // for a throw site that names a substitution rather than a rule.
    const error = thrownBy('{ a: 1  b 2 }') as TsonParseError;
    expect(error).toBeInstanceOf(TsonParseError);
    expect(error.message).toContain("expected a record field's ':', found '2'");
    expect(error.expected).toBe("a record field's ':'");
    expect(error.actual).toBe("'2'");
  });

  it('a rule violation (not a substitution) carries no expected/actual pair', () => {
    const error = thrownBy('{ x: 1, }') as TsonParseError;
    expect(error.expected).toBeUndefined();
    expect(error.actual).toBeUndefined();
  });
});

// ── Maps (§2.6) ──────────────────────────────────────────────────────────

describe('maps (§2.6)', () => {
  it('one entry', () => {
    expect(shape('{ WELCOME10 => "10%" }')).toEqual([
      'DocumentStart(|)',
      'MapStart',
      'Token(WELCOME10,unquoted)',
      'MapArrow',
      'Token(10%,single-line)',
      'MapEnd',
      'DocumentEnd',
    ]);
  });

  it('multiple entries', () => {
    expect(shape('{ WELCOME10 => "10%" loyalty => _ }')).toEqual([
      'DocumentStart(|)',
      'MapStart',
      'Token(WELCOME10,unquoted)',
      'MapArrow',
      'Token(10%,single-line)',
      'Token(loyalty,unquoted)',
      'MapArrow',
      'Absent',
      'MapEnd',
      'DocumentEnd',
    ]);
  });

  it('a trailing comma before "}" is a parse error', () => {
    expect(() => events('{ a => 1, }')).toThrow(TsonParseError);
  });
});

// ── The "{}" record/map lookahead (§2.8) ────────────────────────────────

describe('brace disambiguation (§2.8): at most two tokens of lookahead', () => {
  it('a key starting with an annotation can only ever be a map', () => {
    expect(shape('{ @deprecated key => 1 }')).toEqual([
      'DocumentStart(|)',
      'MapStart',
      'AnnotationStart(deprecated)',
      'AnnotationEnd',
      'Token(key,unquoted)',
      'MapArrow',
      'Token(1,unquoted)',
      'MapEnd',
      'DocumentEnd',
    ]);
  });

  it('a key may carry both annotations and a type-ref before the map is known', () => {
    expect(shape('{ @deprecated !string key => 1 }')).toEqual([
      'DocumentStart(|)',
      'MapStart',
      'AnnotationStart(deprecated)',
      'AnnotationEnd',
      'TypeRef(string)',
      'Token(key,unquoted)',
      'MapArrow',
      'Token(1,unquoted)',
      'MapEnd',
      'DocumentEnd',
    ]);
  });

  it('a key starting with a type-ref can only ever be a map', () => {
    expect(shape('{ !int 5 => 1 }')).toEqual([
      'DocumentStart(|)',
      'MapStart',
      'TypeRef(int)',
      'Token(5,unquoted)',
      'MapArrow',
      'Token(1,unquoted)',
      'MapEnd',
      'DocumentEnd',
    ]);
  });

  it('a key starting with a nested record can only ever be a map', () => {
    expect(shape('{ { a: 1 } => "x" }')).toEqual([
      'DocumentStart(|)',
      'MapStart',
      'RecordStart',
      'FieldName(a)',
      'Token(1,unquoted)',
      'RecordEnd',
      'MapArrow',
      'Token(x,single-line)',
      'MapEnd',
      'DocumentEnd',
    ]);
  });

  it('a key starting with an array can only ever be a map', () => {
    expect(shape('{ [1 2] => x }')).toEqual([
      'DocumentStart(|)',
      'MapStart',
      'ArrayStart',
      'Token(1,unquoted)',
      'Token(2,unquoted)',
      'ArrayEnd',
      'MapArrow',
      'Token(x,unquoted)',
      'MapEnd',
      'DocumentEnd',
    ]);
  });

  it('the absent sentinel as a key parses structurally -- rejecting it is a resolver-layer concern (§2.9)', () => {
    expect(shape('{ _ => 1 }')).toEqual([
      'DocumentStart(|)',
      'MapStart',
      'Absent',
      'MapArrow',
      'Token(1,unquoted)',
      'MapEnd',
      'DocumentEnd',
    ]);
  });

  it('a malformed annotated-key still commits to a map, surfacing the mismatch at "=>" (§2.8 first bullet)', () => {
    const error = thrownBy('{ @deprecated key : 1 }');
    expect(error).toBeInstanceOf(TsonParseError);
    expect((error as TsonParseError).expected).toBe("a map entry's '=>'");
  });

  it('a value inside braces followed by neither ":" nor "=>" is a parse error', () => {
    expect(() => events('{ key key2 }')).toThrow(TsonParseError);
  });
});

// ── Arrays (§2.7) ────────────────────────────────────────────────────────

describe('arrays (§2.7)', () => {
  it('empty', () => {
    expect(shape('[]')).toEqual(['DocumentStart(|)', 'ArrayStart', 'ArrayEnd', 'DocumentEnd']);
    expect(shape('[   ]')).toEqual(['DocumentStart(|)', 'ArrayStart', 'ArrayEnd', 'DocumentEnd']);
  });

  it('elements', () => {
    expect(shape('[1 2 3]')).toEqual([
      'DocumentStart(|)',
      'ArrayStart',
      'Token(1,unquoted)',
      'Token(2,unquoted)',
      'Token(3,unquoted)',
      'ArrayEnd',
      'DocumentEnd',
    ]);
  });

  it('comma-separated is equivalent to whitespace-separated', () => {
    expect(shape('[1, 2, 3]')).toEqual(shape('[1 2 3]'));
  });

  it('the absent sentinel occupies a positional slot (§2.9)', () => {
    expect(shape('[1 _ 3]')).toEqual([
      'DocumentStart(|)',
      'ArrayStart',
      'Token(1,unquoted)',
      'Absent',
      'Token(3,unquoted)',
      'ArrayEnd',
      'DocumentEnd',
    ]);
  });

  it('nests with records', () => {
    expect(shape('[ { sku: A-100 } { sku: B-205 } ]')).toEqual([
      'DocumentStart(|)',
      'ArrayStart',
      'RecordStart',
      'FieldName(sku)',
      'Token(A-100,unquoted)',
      'RecordEnd',
      'RecordStart',
      'FieldName(sku)',
      'Token(B-205,unquoted)',
      'RecordEnd',
      'ArrayEnd',
      'DocumentEnd',
    ]);
  });

  it('a trailing comma before "]" is a parse error', () => {
    expect(() => events('[1, 2, 3,]')).toThrow(TsonParseError);
  });

  it('zero-width separation between elements is a parse error', () => {
    expect(() => events('[{a:1}{b:2}]')).toThrow(TsonParseError);
  });

  it('an element may carry its own !!schema directive, scoped to that element alone (§2.7, §3.3)', () => {
    expect(shape('[ !!schema:"https://example.com/s.tn" 1 2 ]')).toEqual([
      'DocumentStart(|)',
      'ArrayStart',
      'SchemaRef(https://example.com/s.tn)',
      'Token(1,unquoted)',
      'Token(2,unquoted)',
      'ArrayEnd',
      'DocumentEnd',
    ]);
  });

  it('a directive other than !!schema is not permitted at an element position (§3.3)', () => {
    expect(() => events('[ !!import:"https://example.com/x.tn" 1 ]')).toThrow(TsonParseError);
  });
});

describe('unterminated structures fail fast rather than looping (bounded 2-token lookahead)', () => {
  it('an unterminated array is a parse error', () => {
    expect(() => events('[1, 2, 3')).toThrow(TsonParseError);
  });

  it('an unterminated record is a parse error', () => {
    expect(() => events('{ x: 1')).toThrow(TsonParseError);
  });

  it('an unterminated nested structure is a parse error', () => {
    expect(() => events('{ x: [1 2')).toThrow(TsonParseError);
  });
});

// ── Type annotations (§3.2) ──────────────────────────────────────────────

describe('type annotations (§3.2)', () => {
  it('may prefix the root value', () => {
    expect(shape('!uuid 9f1c8e2a-4b7d-4e6f-9a3b-2c5d8e7f1a09')).toEqual([
      'DocumentStart(|)',
      'TypeRef(uuid)',
      'Token(9f1c8e2a-4b7d-4e6f-9a3b-2c5d8e7f1a09,unquoted)',
      'DocumentEnd',
    ]);
  });

  it('needs no separating whitespace before a structural delimiter', () => {
    expect(shape('!person{name:Alice}')).toEqual([
      'DocumentStart(|)',
      'TypeRef(person)',
      'RecordStart',
      'FieldName(name)',
      'Token(Alice,unquoted)',
      'RecordEnd',
      'DocumentEnd',
    ]);
  });

  it('missing whitespace before a non-delimiter token is a parse error', () => {
    expect(() => events('!int32"5"')).toThrow(TsonParseError);
  });

  it('"!" not adjacent to the type name is a parse error (§7.5)', () => {
    expect(() => events('! person Alice')).toThrow(TsonParseError);
  });

  it('the array-type form "![...]" is schema syntax, rejected in a data value (§3.2)', () => {
    expect(() => events('![text] Alice')).toThrow(TsonParseError);
  });

  it('type arguments "<...>" are schema syntax, rejected in a data value', () => {
    expect(() => events('!box<text> Alice')).toThrow(TsonParseError);
  });

  it('the optional suffix "?" is schema syntax, rejected in a data value', () => {
    expect(() => events('!int32? Alice')).toThrow(TsonParseError);
  });
});

// ── Annotations (§3.1) ────────────────────────────────────────────────────

describe('annotations (§3.1)', () => {
  it('may be valueless, requiring trailing whitespace', () => {
    expect(shape('@deprecated GOLD')).toEqual([
      'DocumentStart(|)',
      'AnnotationStart(deprecated)',
      'AnnotationEnd',
      'Token(GOLD,unquoted)',
      'DocumentEnd',
    ]);
  });

  it('may carry a value after an adjacent ":"', () => {
    expect(shape('@expires:"2026-12-31" GOLD')).toEqual([
      'DocumentStart(|)',
      'AnnotationStart(expires)',
      'Token(2026-12-31,single-line)',
      'AnnotationEnd',
      'Token(GOLD,unquoted)',
      'DocumentEnd',
    ]);
  });

  it('preserve source order when repeated (§3.1 Multiplicity)', () => {
    expect(shape('@a @b value')).toEqual([
      'DocumentStart(|)',
      'AnnotationStart(a)',
      'AnnotationEnd',
      'AnnotationStart(b)',
      'AnnotationEnd',
      'Token(value,unquoted)',
      'DocumentEnd',
    ]);
  });

  it('a value may itself be a container', () => {
    expect(shape('@meta:{k: v} value')).toEqual([
      'DocumentStart(|)',
      'AnnotationStart(meta)',
      'RecordStart',
      'FieldName(k)',
      'Token(v,unquoted)',
      'RecordEnd',
      'AnnotationEnd',
      'Token(value,unquoted)',
      'DocumentEnd',
    ]);
  });

  it('§3.1\'s worked example: "@a:@b:val target extra" -- a\'s value is the data-value "@b:val target"', () => {
    // @a's value is the data-value `@b:val target`: core value `target`, annotated by `@b` (whose
    // own value is `val`); `extra` belongs to the surrounding data-value (here, the document root's
    // own core value, since @a is the root's only annotation).
    expect(shape('@a:@b:val target extra')).toEqual([
      'DocumentStart(|)',
      'AnnotationStart(a)',
      'AnnotationStart(b)',
      'Token(val,unquoted)',
      'AnnotationEnd',
      'Token(target,unquoted)',
      'AnnotationEnd',
      'Token(extra,unquoted)',
      'DocumentEnd',
    ]);
  });

  it('§3.1\'s contrasting example: "@a:@b val target" -- no colon on @b makes it valueless', () => {
    // Here @b is a valueless annotation on the core value `val`, so @a's value is `@b val` and
    // `target` belongs to the surrounding context -- complete as written.
    expect(shape('@a:@b val target')).toEqual([
      'DocumentStart(|)',
      'AnnotationStart(a)',
      'AnnotationStart(b)',
      'AnnotationEnd',
      'Token(val,unquoted)',
      'AnnotationEnd',
      'Token(target,unquoted)',
      'DocumentEnd',
    ]);
  });

  it('an annotation is never itself a value (§3.1): "@a:@b:val" alone leaves a\'s core-value unfilled', () => {
    const error = thrownBy('{ x: @a:@b:val }');
    expect(error).toBeInstanceOf(TsonParseError);
    expect((error as Error).message).toContain('expected a value');
  });

  it('"@" not adjacent to the annotation name is a parse error (§7.5)', () => {
    expect(() => events('@ deprecated GOLD')).toThrow(TsonParseError);
  });

  it('no whitespace and no ":" after the annotation name is a parse error', () => {
    expect(() => events('@deprecated:')).toThrow(); // malformed either way; smoke-checks the branch
    expect(() => events('@a"x"')).toThrow(TsonParseError);
  });
});

// ── peek() does not consume (frozen EventSource contract) ────────────────

describe('peek() vs next() (frozen EventSource contract)', () => {
  it('peek() repeated with no intervening next() yields the same event', () => {
    const source = createDataStream(fromString('Alice'));
    const first = runSync(source.peek());
    const second = runSync(source.peek());
    expect(first).toEqual(second);
    expect(first.kind).toBe('document-start');
  });

  it('next() after peek() returns the peeked event and advances past it', () => {
    const source = createDataStream(fromString('Alice'));
    const peeked = runSync(source.peek());
    const pulled = runSync(source.next());
    expect(pulled).toEqual(peeked);
    const following = runSync(source.peek());
    expect(following).toEqual(expect.objectContaining({ kind: 'token', text: 'Alice' }));
  });

  it('pulling past DocumentEnd is a caller misuse, not a document condition', () => {
    const source = createDataStream(fromString('Alice'));
    for (;;) {
      const event = runSync(source.next());
      if (event.kind === 'document-end') break;
    }
    expect(() => runSync(source.next())).toThrow(TsonInternalError);
  });
});

// ── Memory proportional to nesting depth: the frame stack, not the call stack ─

describe('the frame stack replaces recursion (CLAUDE.md: memory proportional to nesting depth)', () => {
  it('parses a deeply nested array without blowing the JS call stack', () => {
    const depth = 20_000;
    const nested = '['.repeat(depth) + '1' + ']'.repeat(depth);
    expect(() => events(nested)).not.toThrow();
  });

  it('a combined smoke test balances every container across many constructs at once', () => {
    const source = `
      !!id:"https://example.com/orders/1.tn"
      {
        customer: @verified !string "Alice"
        tags: [ premium _ "gold" ]
        discounts: { WELCOME10 => "10%" @deprecated legacy => "5%" }
        meta: {}
        nested: { @deprecated !int key => { a: 1 b: [1 2 3] } }
      }
    `;
    const es = events(source);
    expect(es[es.length - 1]?.kind).toBe('document-end');

    let depth = 0;
    for (const e of es) {
      if (e.kind === 'record-start' || e.kind === 'map-start' || e.kind === 'array-start')
        depth += 1;
      if (e.kind === 'record-end' || e.kind === 'map-end' || e.kind === 'array-end') depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});

// ── Real chunked/streaming input (CLAUDE.md: streaming is non-negotiable) ─

describe('driving over chunked input with runAsync (Task suspension)', () => {
  async function eventsAsync(text: string, chunkBytes: number): Promise<TsonEvent[]> {
    const bytes = new TextEncoder().encode(text);
    const input = chunkInput();
    const source = createDataStream(input);

    const feeding = (async (): Promise<void> => {
      for (let i = 0; i < bytes.length; i += chunkBytes) {
        input.push(bytes.slice(i, i + chunkBytes));
        await Promise.resolve();
      }
      input.end();
    })();

    const results: TsonEvent[] = [];
    for (;;) {
      const event = await runAsync(source.next(), input);
      results.push(event);
      if (event.kind === 'document-end') break;
    }
    await feeding;
    return results;
  }

  it('produces the identical event shape as the synchronous path, one byte at a time', async () => {
    const text = '{ customer: { name: Alice } tags: [1 2 3] }';
    const expected = shape(text);
    const es = await eventsAsync(text, 1);
    expect(es.map(describeEvent)).toEqual(expected);
  });

  it('suspends correctly mid multi-byte UTF-8 sequence and mid keyword', async () => {
    const text = '{ 名前: "Ålice", flag: true }';
    const expected = shape(text);
    const es = await eventsAsync(text, 1);
    expect(es.map(describeEvent)).toEqual(expected);
  });
});

describe('naming positions take the identifier grammar (§3.1, §3.2, §7.7)', () => {
  it('rejects a type name that is not an identifier, rather than deferring it to resolution', () => {
    expect(() => events('!42x 1')).toThrow(TsonParseError);
    expect(() => events('!42x 1')).toThrow(/not an identifier/);
  });

  it('rejects an annotation name that is not an identifier', () => {
    expect(() => events('@42x 1')).toThrow(TsonParseError);
    expect(() => events('@42x 1')).toThrow(/not an identifier/);
  });

  it("admits '-', which the identifier profile carries", () => {
    expect(() => events('!my-type 1')).not.toThrow();
    expect(() => events('@my-note 1')).not.toThrow();
  });

  it("refuses '.', which the profile reserves as a future separator", () => {
    expect(() => events('!my.type 1')).toThrow(TsonParseError);
  });
});

describe('a field name is not the multi-line form (§2.5, §7.4)', () => {
  it('rejects a triple-quoted field name', () => {
    expect(() => events('{\n"""\nname\n"""\n: 1\n}')).toThrow(TsonParseError);
  });

  it('still admits the single-line quoted form, which is what keeps JSON keys valid', () => {
    expect(() => events('{ "first name": 1 }')).not.toThrow();
  });

  it('still admits a triple-quoted map key, which is a value and keeps all three forms', () => {
    expect(() => events('{\n"""\nkey\n"""\n=> 1\n}')).not.toThrow();
  });
});
