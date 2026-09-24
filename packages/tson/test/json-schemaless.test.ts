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

  it('throws TsonReadError at a §3.1 duplicate member', () => {
    let error: unknown;
    try {
      parseJson('{"a": 1, "a": 2}');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TsonReadError);
    expect((error as TsonReadError).diagnostic.code).toBe('DUPLICATE_FIELD');
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
  it('collects every duplicate-member problem in one pass rather than stopping at the first', () => {
    const result = parseJsonCollecting('{"a": 1, "a": 2, "b": 3, "b": 4}');
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.every((d) => d.code === 'DUPLICATE_FIELD')).toBe(true);
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
  it(
    'name identity is the NFC-normalized decoded string, per Part 3 §3.1 -- the reading this ' +
      'port follows where the Java reference compares undecoded, un-normalized names',
    () => {
      // "é" (precomposed é) and "é" (e + combining acute) are one name under NFC.
      const result = parseJsonCollecting('{"é": 1, "é": 2}');
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
