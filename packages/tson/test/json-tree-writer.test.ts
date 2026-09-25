/**
 * Ported from the Java reference's `JsonTreeWriterTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/JsonTreeWriterTest.java`) -- the write side's whole
 * claim, that it is the exact inverse of the read side, checked as equality of *text* (RFC 8259
 * has six kinds and one spelling each, where TSON text spells one value several ways).
 *
 * **No `JsonTreeWriter` class here at all, and nothing to port `TheSinks`/the "derived, not
 * configured" case to.** `json/write.ts` is a pair of plain functions (`jsonValueToText`,
 * `jsonValueToDisplayString`), not a stateful writer with a `write(value, sink)` overload set:
 * there is no mutable configuration (an indent, a target sink) for a "derived writer" to carry
 * independently of another one, so there is nothing for `TheSinks`'/that case's own assertions to
 * be about. A caller who wants bytes reaches for `io/utf8.ts`'s
 * `encodeUtf8(jsonValueToText(value))` (`json/write.ts`'s own top note), which is one composition
 * rather than three sink overloads to test.
 */
import { describe, expect, it } from 'vitest';

import { jsonNumber, jsonObject, jsonArray, jsonString, type JsonValue } from '../src/json/tree.js';
import { jsonValueToDisplayString, jsonValueToText } from '../src/json/write.js';
import { parseJson } from '../src/json/index.js';
import { tryParseNumber } from '../src/base/numberGrammar.js';
import { toExactDecimal } from '../src/base/numberNarrowing.js';

describe('the round trip', () => {
  it('returns every shape as the text it was read from', () => {
    const sources = [
      '{}',
      '[]',
      '0',
      '-1',
      '""',
      '"a"',
      'true',
      'false',
      'null',
      '{"a":1}',
      '{"a":1,"b":2}',
      '[1,2,3]',
      '[[],[[]]]',
      '{"a":[1,{"b":null}],"c":{},"d":[]}',
      '[true,false,null,"",0]',
    ];
    for (const source of sources) {
      expect(jsonValueToText(parseJson(source)), source).toBe(source);
    }
  });

  it('keeps the digits and the scale a number was written with (§5.3)', () => {
    const literals = ['199.90', '1.0', '0.10', '1e10', '1E+10', '1.000000000000001'];
    for (const literal of literals) {
      expect(jsonValueToText(parseJson(literal)), literal).toBe(literal);
    }
    // The Java case's own second half: read the round-tripped text back and check the *decoded*
    // value still carries its original scale (§5.3: the tree preserves the literal, and the
    // literal is what a decimal decode's scale comes from -- `199.90`'s two decimal digits, not
    // `199.9`'s canonicalised one). `toExactDecimal`'s own `exponent` is scale's negation.
    const roundTripped = jsonValueToText(parseJson('199.90'));
    const form = tryParseNumber(roundTripped);
    if (form === undefined) throw new Error('expected a number form');
    if (form.kind !== 'float') throw new Error(`expected a float form, got '${form.kind}'`);
    const decimal = toExactDecimal(form);
    expect(decimal.unscaled).toBe(19990n);
    expect(-decimal.exponent).toBe(2); // scale
  });

  it('keeps the content of a string across the escape boundary', () => {
    const roundTrip = (s: string): string => {
      const value = jsonValueToText(jsonString(s));
      const read = parseJson(value);
      if (read.kind !== 'string') throw new Error(`expected a string, got '${read.kind}'`);
      return read.value;
    };
    expect(roundTrip('a\nb')).toBe('a\nb');
    expect(roundTrip('"\\')).toBe('"\\');
    expect(roundTrip('é☃')).toBe('é☃');
    expect(roundTrip('')).toBe('');
  });

  it('keeps a member name that needs an escape', () => {
    const value: JsonValue = jsonObject(new Map([['a"b', jsonNumber('1')]]));
    expect(jsonValueToText(value)).toBe('{"a\\"b":1}');
    expect(jsonValueToText(parseJson(jsonValueToText(value)))).toBe(jsonValueToText(value));
  });

  it('keeps member order', () => {
    expect(jsonValueToText(parseJson('{"z":1,"a":2,"m":3}'))).toBe('{"z":1,"a":2,"m":3}');
  });
});

describe('the indented form', () => {
  it('reads back to the same value', () => {
    const value = parseJson('{"a":[1,2],"b":{"c":"d"}}');
    expect(jsonValueToText(parseJson(jsonValueToDisplayString(value)))).toBe(
      jsonValueToText(value),
    );
  });

  it('leaves an empty container on one line', () => {
    expect(jsonValueToDisplayString(parseJson('{"a":{},"b":[]}'))).toBe(
      '{\n  "a": {},\n  "b": []\n}',
    );
  });

  it('honours a custom indent', () => {
    const value = parseJson('{"a":1}');
    expect(jsonValueToDisplayString(value, '    ')).toBe('{\n    "a": 1\n}');
  });

  it("the indent is the caller's (JsonTest#the_indent_is_the_callers)", () => {
    expect(jsonValueToDisplayString(parseJson('[1]'), '\t')).toBe('[\n\t1\n]');
  });

  it('a scalar displays as itself (JsonTest#a_scalar_displays_as_itself)', () => {
    expect(jsonValueToDisplayString(parseJson('1'))).toBe('1');
    expect(jsonValueToDisplayString(parseJson('null'))).toBe('null');
  });
});

describe('hand-built values', () => {
  it('write as readily as parsed ones', () => {
    const value = jsonObject(
      new Map<string, JsonValue>([
        ['n', jsonNumber('1.50')],
        ['xs', jsonArray([jsonString('a')])],
      ]),
    );
    expect(jsonValueToText(value)).toBe('{"n":1.50,"xs":["a"]}');
  });
});
