import { describe, expect, it } from 'vitest';
import { TsonLimitRefusedError, TsonParseError } from '../src/core/errors.js';
import { fromString, runSync } from '../src/io/bytes.js';
import { createJsonStream, type JsonEvent } from '../src/json/stream.js';

function render(event: JsonEvent): string {
  switch (event.kind) {
    case 'object-start':
      return '{';
    case 'object-end':
      return '}';
    case 'array-start':
      return '[';
    case 'array-end':
      return ']';
    case 'member-name':
      return `name(${event.name})`;
    case 'string':
      return `string(${event.value})`;
    case 'number':
      return `number(${event.literal})`;
    case 'boolean':
      return `boolean(${String(event.value)})`;
    case 'null':
      return 'null';
    case 'end-of-document':
      return 'end';
  }
}

function events(source: string, maxNestingDepth?: number): string[] {
  const stream = createJsonStream(
    fromString(source),
    maxNestingDepth === undefined ? undefined : { maxNestingDepth },
  );
  const rendered: string[] = [];
  for (;;) {
    const event = runSync(stream.next());
    rendered.push(render(event));
    if (event.kind === 'end-of-document') return rendered;
  }
}

function refused(source: string): TsonParseError {
  try {
    events(source);
  } catch (e) {
    expect(e).toBeInstanceOf(TsonParseError);
    return e as TsonParseError;
  }
  throw new Error(`expected a TsonParseError, but '${source}' streamed clean`);
}

describe('shapes', () => {
  it('a scalar document is one value and the end', () => {
    expect(events('1')).toEqual(['number(1)', 'end']);
    expect(events('"hi"')).toEqual(['string(hi)', 'end']);
    expect(events('true')).toEqual(['boolean(true)', 'end']);
    expect(events('null')).toEqual(['null', 'end']);
  });

  it('an object is a member name and its value events, in order', () => {
    expect(events('{"a": 1, "b": "x"}')).toEqual([
      '{',
      'name(a)',
      'number(1)',
      'name(b)',
      'string(x)',
      '}',
      'end',
    ]);
  });

  it('an array is its elements, in order', () => {
    expect(events('[1, false, null]')).toEqual([
      '[',
      'number(1)',
      'boolean(false)',
      'null',
      ']',
      'end',
    ]);
  });

  it('the empty container is its two events and nothing between', () => {
    expect(events('{}')).toEqual(['{', '}', 'end']);
    expect(events('[]')).toEqual(['[', ']', 'end']);
  });

  it('nesting is matched pairs and needs no other state', () => {
    expect(events('[{"a": [1]}, []]')).toEqual([
      '[',
      '{',
      'name(a)',
      '[',
      'number(1)',
      ']',
      '}',
      '[',
      ']',
      ']',
      'end',
    ]);
  });

  it('an escaped member name and the same name written plainly are one name', () => {
    expect(events('{"ab": 1}')).toEqual(events('{"\\u0061b": 1}'));
  });

  it('a number reaches the stream as its exact lexeme', () => {
    expect(events('[199.90, 6.02e23, -0.0]')).toEqual([
      '[',
      'number(199.90)',
      'number(6.02e23)',
      'number(-0.0)',
      ']',
      'end',
    ]);
  });

  it('nothing here interprets null, which is a JSON value at this layer', () => {
    expect(events('{"nickname": null}')).toEqual(['{', 'name(nickname)', 'null', '}', 'end']);
  });

  it('a duplicate member name passes the grammar untouched', () => {
    expect(events('{"a": 1, "a": 2}')).toEqual([
      '{',
      'name(a)',
      'number(1)',
      'name(a)',
      'number(2)',
      '}',
      'end',
    ]);
  });

  it('a reserved member name is an ordinary name here', () => {
    expect(events('{"$type": "cat"}')).toEqual(['{', 'name($type)', 'string(cat)', '}', 'end']);
  });
});

describe('grammar', () => {
  it('an empty document is not a JSON text', () => {
    expect(refused('').message).toContain('a JSON document is one value');
    expect(refused('   ').message).toContain('a JSON document is one value');
  });

  it('trailing content is refused because the end is pulled', () => {
    expect(refused('[1] 2').message).toContain('this one is complete');
    expect(refused('{} {}').message).toContain('this one is complete');
    expect(refused('1 2').message).toContain('this one is complete');
    expect(refused('"a" "b"').message).toContain('this one is complete');
  });

  it('JSON admits no trailing comma and says so', () => {
    expect(refused('[1,]').message).toContain('an element is due');
    expect(refused('{"a": 1,}').message).toContain('no trailing comma');
  });

  it('a member name must be a quoted string', () => {
    expect(refused('{1: 2}').message).toContain('a member name is a quoted string');
    expect(refused('{true: 1}').message).toContain('a member name is a quoted string');
    expect(refused('{[]: 1}').message).toContain('a member name is a quoted string');
  });

  it('an unquoted name of letters is refused by the lexer, not by this layer', () => {
    // `a` starts no JSON token at all, so `json/lexer.ts` refuses it first -- a TsonLexError, not
    // the TsonParseError every other case in this file's `refused` helper expects.
    expect(() => events('{a: 1}')).toThrow(/'a' is not the start of any JSON value/u);
  });

  it('a member needs its name separator', () => {
    expect(refused('{"a" 1}').message).toContain("':' separates a member name");
    expect(refused('{"a", 1}').message).toContain("':' separates a member name");
  });

  it('a missing separator between members or elements is refused', () => {
    expect(refused('[1 2]').message).toContain("',' or ']' follows an element");
    expect(refused('{"a": 1 "b": 2}').message).toContain("',' or '}' follows a member's value");
  });

  it('an unclosed container ends at the end of the document', () => {
    expect(refused('[1').message).toContain("',' or ']' follows an element");
    expect(refused('{"a":').message).toContain("a member's value is due");
    expect(refused('{').message).toContain('a member name is due');
    expect(refused('[').message).toContain("an element or ']' is due");
  });

  it('a mismatched closer is refused', () => {
    expect(refused('[1}').message).toContain("',' or ']' follows an element");
    expect(refused('{"a": 1]').message).toContain("',' or '}' follows a member's value");
    expect(refused(']').message).toContain('a JSON document is one value');
  });

  it('a message names the construct the position admits, not the token class', () => {
    const message = refused('{true: 1}').message;
    expect(message).toContain('a member name is due');
    expect(message).toContain("'true'");
  });

  it('an error reports at the offending token', () => {
    expect(refused('[1, ]').position).toEqual({ line: 1, column: 5, offset: 4 });
    expect(refused('{\n  "a" 1}').position).toEqual({ line: 2, column: 7, offset: 8 });
  });
});

describe('depth bound (§10.1)', () => {
  const nested = (depth: number) => '['.repeat(depth) + '1' + ']'.repeat(depth);

  it('a document at the bound reads and one past it is refused', () => {
    expect(events(nested(64))).toHaveLength(64 * 2 + 2);
    let error: TsonLimitRefusedError | undefined;
    try {
      events(nested(65));
    } catch (e) {
      error = e as TsonLimitRefusedError;
    }
    expect(error).toBeInstanceOf(TsonLimitRefusedError);
    expect(error?.configuredThreshold).toBe(64);
    expect(error?.message).toContain('nests deeper than');
  });

  it('a refusal is not a parse error and is not typed as one', () => {
    let error: unknown;
    try {
      events(nested(65));
    } catch (e) {
      error = e;
    }
    expect(error).not.toBeInstanceOf(TsonParseError);
  });

  it('the bound is configurable, and objects count the same as arrays', () => {
    expect(events('{"a": {"b": 1}}')).toEqual([
      '{',
      'name(a)',
      '{',
      'name(b)',
      'number(1)',
      '}',
      '}',
      'end',
    ]);
    expect(() => events('{"a": {"b": 1}}', 1)).toThrow(TsonLimitRefusedError);
  });

  it('a document deeper than the frame array starts at reads when the bound allows', () => {
    expect(events(nested(200), 256)).toHaveLength(200 * 2 + 2);
  });
});

describe('source contract', () => {
  it('peek does not consume and repeats', () => {
    const stream = createJsonStream(fromString('[1]'));
    const peeked = runSync(stream.peek());
    expect(runSync(stream.peek())).toBe(peeked);
    expect(runSync(stream.next())).toBe(peeked);
    expect(runSync(stream.next()).kind).toBe('number');
  });

  it('a document read from bytes streams alike', () => {
    const source = '{"é": [1, true, null]}';
    expect(events(source)).toEqual(events(source));
  });
});

describe('positions', () => {
  it('every event carries the position of the token that produced it', () => {
    const stream = createJsonStream(fromString('{\n  "a": [1]\n}'));
    expect(runSync(stream.next()).position).toEqual({ line: 1, column: 1, offset: 0 }); // {
    expect(runSync(stream.next()).position).toEqual({ line: 2, column: 3, offset: 4 }); // "a"
    expect(runSync(stream.next()).position).toEqual({ line: 2, column: 8, offset: 9 }); // [
    expect(runSync(stream.next()).position).toEqual({ line: 2, column: 9, offset: 10 }); // 1
    expect(runSync(stream.next()).position).toEqual({ line: 2, column: 10, offset: 11 }); // ]
    expect(runSync(stream.next()).position).toEqual({ line: 3, column: 1, offset: 13 }); // }
  });

  it('a lexical failure still surfaces through the stream', () => {
    const stream = createJsonStream(fromString('[1, +2]'));
    runSync(stream.next());
    runSync(stream.next());
    expect(() => runSync(stream.next())).toThrow(/'\+'/u);
  });
});
