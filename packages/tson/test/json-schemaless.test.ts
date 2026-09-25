import { describe, expect, it } from 'vitest';
import { collector, throwing, type Diagnostic } from '../src/core/diagnostic.js';
import {
  TsonLexError,
  TsonLimitRefusedError,
  TsonParseError,
  TsonReadError,
} from '../src/core/errors.js';
import { runSync } from '../src/io/bytes.js';
import { createJsonStream } from '../src/json/stream.js';
import { readJsonDocument } from '../src/json/schemalessTree.js';
import { equalJsonValue, jsonArray, jsonNumber, jsonObject, jsonString } from '../src/json/tree.js';
import { jsonValueToText } from '../src/json/write.js';
import { parseJson, parseJsonAsync, parseJsonCollecting } from '../src/json/index.js';

describe('parseJson (front door)', () => {
  it('parses every RFC 8259 value kind into the matching JsonValue', () => {
    expect(
      equalJsonValue(
        parseJson('{"a": [1, "x", true, false, null]}'),
        jsonObject(
          new Map([
            [
              'a',
              jsonArray([
                jsonNumber('1'),
                jsonString('x'),
                { kind: 'boolean', value: true },
                { kind: 'boolean', value: false },
                { kind: 'null' },
              ]),
            ],
          ]),
        ),
      ),
    ).toBe(true);
  });

  it('accepts a plain string, encoding it as UTF-8 at this one boundary', () => {
    expect(equalJsonValue(parseJson('"café"'), jsonString('café'))).toBe(true);
  });

  it('accepts raw bytes directly', () => {
    const bytes = new TextEncoder().encode('[1,2,3]');
    expect(
      equalJsonValue(
        parseJson(bytes),
        jsonArray([jsonNumber('1'), jsonNumber('2'), jsonNumber('3')]),
      ),
    ).toBe(true);
  });

  it('throws TsonLexError for malformed JSON text (invalid UTF-8, ill-formed strings) -- [TSON-JSON] §9.4', () => {
    expect(() => parseJson(new Uint8Array([0x22, 0xc3, 0x28, 0x22]))).toThrow(TsonLexError);
  });

  it('throws TsonParseError for a structural grammar violation -- [TSON-JSON] §9.4', () => {
    expect(() => parseJson('[1] 2')).toThrow(TsonParseError);
    expect(() => parseJson('{"a": }')).toThrow(TsonParseError);
  });

  it('throws TsonLimitRefusedError, distinct from a syntax error, past the nesting bound', () => {
    const deeplyNested = '['.repeat(65) + '1' + ']'.repeat(65);
    let error: unknown;
    try {
      parseJson(deeplyNested);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TsonLimitRefusedError);
    expect(error).not.toBeInstanceOf(TsonParseError);
  });

  it('throws TsonReadError at a §3.1 duplicate member, naming and locating the repeat (JsonTest)', () => {
    let error: unknown;
    try {
      parseJson('{"a": 1, "a": 2}');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TsonReadError);
    const diagnostic = (error as TsonReadError).diagnostic;
    expect(diagnostic.code).toBe('DUPLICATE_FIELD');
    expect(diagnostic.message).toContain("'a' is already a member");
    expect(diagnostic.path).toBe('/a');
  });

  it('member order is preserved although nothing reads it (§6.1.6, JsonTest)', () => {
    const value = parseJson('{"z":1,"a":2,"m":3}');
    if (value.kind !== 'object') throw new Error(`expected an object, got '${value.kind}'`);
    expect([...value.members.keys()]).toEqual(['z', 'a', 'm']);
  });

  it('duplicates in sibling objects are not duplicates (JsonTest)', () => {
    const value = parseJson('[{"a": 1}, {"a": 2}]');
    if (value.kind !== 'array') throw new Error(`expected an array, got '${value.kind}'`);
    expect(value.elements).toHaveLength(2);
  });

  it('bytes and a string parse alike, and bytes are where the UTF-8 rules bite (JsonTest#bytes_and_a_string_parse_alike_and_bytes_are_where_the_utf8_rules_bite)', () => {
    const source = '{"é": [1, true, null]}';
    expect(equalJsonValue(parseJson(source), parseJson(new TextEncoder().encode(source)))).toBe(
      true,
    );
    // A string has no route to malformed UTF-8 at all -- a JS string is UTF-16 already -- so the
    // half of this case that actually exercises the lexer's own UTF-8 decoding only has a bytes
    // route: a lone lead byte (0xC3 wants one continuation byte) between two quotes.
    let error: unknown;
    try {
      parseJson(new Uint8Array([0x22, 0xc3, 0x22]));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TsonLexError);
    expect((error as TsonLexError).message).toContain('UTF-8');
  });

  it('the nesting bound reaches parse and refuses before any reducer descends, and a raised bound admits a deeper document (JsonTest)', () => {
    const deep = '['.repeat(200) + '1' + ']'.repeat(200);
    expect(() => parseJson(deep)).toThrow(TsonLimitRefusedError);
    expect(parseJson(deep, { maxNestingDepth: 256 }).kind).toBe('array');
  });
});

describe('parseJsonAsync', () => {
  it('agrees with parseJson over an async byte source', async () => {
    const source = '{"a": [1, 2, 3], "b": "text"}';
    async function* chunks(): AsyncGenerator<Uint8Array> {
      const bytes = new TextEncoder().encode(source);
      for (const byte of bytes) {
        await Promise.resolve(); // a genuine microtask boundary between chunks, not just a shape
        yield new Uint8Array([byte]);
      }
    }
    const value = await parseJsonAsync(chunks());
    expect(equalJsonValue(value, parseJson(source))).toBe(true);
  });
});

describe('parseJsonCollecting', () => {
  it('collects every duplicate-member problem in one pass rather than stopping at the first (JsonTest)', () => {
    const result = parseJsonCollecting('{"a": 1, "a": 2, "b": 3, "b": 4}');
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.every((d) => d.code === 'DUPLICATE_FIELD')).toBe(true);
    expect(result.diagnostics.map((d) => d.path)).toEqual(['/a', '/b']);
  });

  it('returns the value when nothing was reported', () => {
    const result = parseJsonCollecting('{"a": 1}');
    expect(result.diagnostics).toEqual([]);
    expect(result.value).toBeDefined();
  });

  it(
    'a base-syntax failure after an already-collected diagnostic throws, dropping what was ' +
      'collected -- a deliberate divergence from the reference, whose own collecting read keeps ' +
      'the earlier value-level problems through a later syntax failure',
    () => {
      // One duplicate is reported first, then the document turns out malformed past that point.
      // Everything past a base-syntax failure is unreachable by construction (`json/index.ts`'s
      // own top note on `parseJsonCollecting`), so this throws rather than returning a partial
      // `JsonParseResult` with the duplicate already found.
      expect(() => parseJsonCollecting('{"a": 1, "a": 2, "b": }')).toThrow(TsonParseError);
    },
  );
});

describe('§3.1 duplicate-member identity', () => {
  it('a duplicate is judged by decoded name, not by spelling (JsonTest#a_duplicate_is_judged_by_decoded_name_not_by_spelling)', () => {
    // The Java reference already decodes escapes before comparing -- \\u0061 is 'a', so this is
    // the same name written two ways -- which this port's own `readJsonDocument` matches exactly:
    // both parse the member name's escapes first (§3.1's own grammar) and compare the result.
    expect(() => parseJson('{"ab": 1, "\\u0061b": 2}')).toThrow(TsonReadError);
  });

  it(
    'name identity is additionally NFC-normalized, per Part 3 §3.1 -- a real divergence from the ' +
      'Java reference, which decodes escapes (above) but does not NFC-normalize the result',
    () => {
      // "é" (precomposed é) and "é" (e + combining acute) are one name under NFC; the Java
      // reference has no `Normalizer` call anywhere in its own JSON tree-reading path, so the
      // same two source strings are two distinct names there.
      const result = parseJsonCollecting('{"é": 1, "é": 2}');
      expect(result.value).toBeUndefined();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe('DUPLICATE_FIELD');
    },
  );
});

describe('readJsonDocument -- the schemaless engine directly', () => {
  it('a fail-fast receiver throws at the first duplicate and stops there', () => {
    const receiver = throwing((d: Diagnostic) => new TsonReadError(d));
    expect(() =>
      runSync(readJsonDocument(createJsonStream(byteInput('{"a": 1, "a": 2}')), receiver)),
    ).toThrow(TsonReadError);
  });

  it(
    'reports a duplicate member at the repeated name, not wherever its value happens to end ' +
      '-- §3.1, [TSON-DATA] §2.6',
    () => {
      const document = '{"a":1,\n"a":\n[1,\n2]}';
      const problems = collector();
      runSync(readJsonDocument(createJsonStream(byteInput(document)), problems));
      expect(problems.diagnostics).toHaveLength(1);
      const diagnostic = problems.diagnostics[0];
      // The repeated `"a"` starts at line 2, column 1 -- not at the `]` that closes its value
      // (line 4), which is what a report deferred until after the value was read would name.
      expect(diagnostic?.dataPosition).toEqual({ line: 2, column: 1, offset: 8 });
    },
  );

  it(
    'keeps every member under its own exact decoded spelling -- NFC decides identity for the ' +
      'duplicate rule but never rewrites what the tree stores (§3.1)',
    () => {
      const precomposed = 'café'; // "café", precomposed é
      const combining = 'café'; // "café", e + combining acute -- one NFC identity, two spellings
      const document = `{"${precomposed}": 1, "${combining}": 2}`;
      const problems = collector();
      const value = runSync(readJsonDocument(createJsonStream(byteInput(document)), problems));
      expect(problems.diagnostics).toHaveLength(1);
      expect(problems.diagnostics[0]?.code).toBe('DUPLICATE_FIELD');
      // Both spellings survive in the tree, each under its own exact key -- neither was rewritten
      // to the other's or to a third, normalized spelling.
      expect(value.kind).toBe('object');
      const members = value.kind === 'object' ? value.members : new Map();
      expect(members.size).toBe(2);
      expect(members.has(precomposed)).toBe(true);
      expect(members.has(combining)).toBe(true);
      // And the writer round-trips exactly what was read, unrewritten (compact form: no spaces).
      expect(jsonValueToText(value)).toBe(`{"${precomposed}":1,"${combining}":2}`);
    },
  );

  it('a same-spelling duplicate still overwrites under Map.set -- last value wins', () => {
    const problems = collector();
    const value = runSync(
      readJsonDocument(createJsonStream(byteInput('{"a": 1, "a": 2}')), problems),
    );
    expect(problems.diagnostics).toHaveLength(1);
    expect(value).toEqual(jsonObject(new Map([['a', jsonNumber('2')]])));
  });
});

function byteInput(text: string) {
  const bytes = new TextEncoder().encode(text);
  let index = 0;
  return {
    ensure: () => index < bytes.length,
    read(): number {
      const b = bytes[index];
      if (b === undefined) throw new Error('read() past end');
      index += 1;
      return b;
    },
    get ended() {
      return true;
    },
  };
}
