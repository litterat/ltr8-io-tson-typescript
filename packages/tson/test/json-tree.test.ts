import { describe, expect, it } from 'vitest';
import {
  asBigInt,
  asBoolean,
  asDouble,
  asInt,
  asList,
  asMap,
  asString,
  at,
  EMPTY_JSON_ARRAY,
  EMPTY_JSON_OBJECT,
  equalJsonValue,
  get,
  jsonArray,
  jsonBoolean,
  jsonNull,
  jsonNumber,
  jsonObject,
  jsonString,
  toBigDecimal,
  tryAt,
  tryGet,
  tryValue,
  TsonJsonValueError,
} from '../src/json/tree.js';
import { jsonValueToDisplayString, jsonValueToText, quoteJsonString } from '../src/json/write.js';
import { parseJson } from '../src/json/index.js';

describe('navigation', () => {
  const root = parseJson('{"a": {"b": [10, 20]}, "n": null}');

  it('get chains across objects and arrays with no cast between steps', () => {
    expect(asInt(at(get(get(root, 'a'), 'b'), 1))).toBe(20);
  });

  it('get throws and names what is actually there', () => {
    expect(() => get(root, 'missing')).toThrow(TsonJsonValueError);
    expect(() => get(root, 'missing')).toThrow(/has no member 'missing'/u);
    expect(() => at(root, 0)).toThrow(/an object has no elements/u);
    expect(() => at(get(get(root, 'a'), 'b'), 5)).toThrow(/has 2 elements, so index 5/u);
    expect(() => get(get(root, 'n'), 'x')).toThrow(/null has no members/u);
  });

  it('tryGet/tryAt are the non-throwing peers at every shape', () => {
    expect(tryGet(root, 'missing')).toBeUndefined();
    expect(tryAt(root, 0)).toBeUndefined();
    expect(tryGet(get(root, 'n'), 'x')).toBeUndefined();
    expect(tryAt(get(get(root, 'a'), 'b'), 0)).toEqual(jsonNumber('10'));
  });

  it('tryValue is undefined for null and the value itself for everything else', () => {
    expect(tryValue(get(root, 'n'))).toBeUndefined();
    expect(tryValue(get(root, 'a'))).toEqual(get(root, 'a'));
    expect(tryValue(parseJson('false'))).toEqual(jsonBoolean(false));
  });
});

describe('conversion', () => {
  it('each conversion answers only for its own kind', () => {
    expect(asString(jsonString('x'))).toBe('x');
    expect(asBoolean(jsonBoolean(true))).toBe(true);
    expect(asList(EMPTY_JSON_ARRAY)).toEqual([]);
    expect(asMap(EMPTY_JSON_OBJECT)).toEqual(new Map());
    expect(() => asInt(jsonString('1'))).toThrow(/this value is a string, not a number/u);
    expect(() => asString(jsonNull())).toThrow(TsonJsonValueError);
    expect(() => asList(jsonNumber('1'))).toThrow(TsonJsonValueError);
  });

  it('a narrowing conversion errors rather than rounding', () => {
    // §3.1: "an implementation that cannot represent the digits MUST error, never round silently."
    expect(asInt(jsonNumber('42'))).toBe(42);
    expect(asBigInt(jsonNumber('42'))).toBe(42n);
    // `asInt` delegates to `asBigInt`, whose own "not an integer" message covers the fractional case.
    expect(() => asInt(jsonNumber('1.5'))).toThrow(/not an integer/u);
    expect(() => asBigInt(jsonNumber('1.5'))).toThrow(/not an integer/u);
    expect(() => asInt(jsonNumber('99999999999999999999999'))).toThrow(
      /not exactly representable/u,
    );
    expect(asBigInt(jsonNumber('9007199254740993'))).toBe(9007199254740993n);
  });

  it('asDouble is the one conversion allowed to lose', () => {
    expect(asDouble(jsonNumber('0.1'))).toBe(0.1);
    expect(asDouble(jsonNumber('1e300'))).toBe(1e300);
  });

  it('an exponent too large to represent exactly errors rather than rounding -- §3.1', () => {
    // Not `Number('99999999999999999999')`, which would round to `100000000000000000000` and
    // silently misstate the exponent by one; not `Infinity` for a 400-digit exponent either.
    expect(() => toBigDecimal(jsonNumber('1e99999999999999999999'))).toThrow(TsonJsonValueError);
    expect(() => toBigDecimal(jsonNumber(`1e${'9'.repeat(400)}`))).toThrow(TsonJsonValueError);
    // The same guarantee holds through every caller built on `parseJsonNumberLiteral`, not just
    // the direct one -- `asBigInt` must not leak a raw `RangeError` from `BigInt(Infinity)`.
    expect(() => asBigInt(jsonNumber(`1e${'9'.repeat(400)}`))).toThrow(TsonJsonValueError);
    expect(() => asInt(jsonNumber(`1e${'9'.repeat(400)}`))).toThrow(TsonJsonValueError);
  });

  it('a safe-but-huge exponent is refused before it is ever materialised as a bigint', () => {
    // 8 bytes of input must not be allowed to demand a ~100-million-digit `bigint`: `asBigInt`
    // refuses on the exponent's magnitude alone, without computing `10n ** BigInt(exponent)`.
    expect(() => asBigInt(jsonNumber('1e100000000'))).toThrow(TsonJsonValueError);
    expect(() => asBigInt(jsonNumber('1e100000000'))).toThrow(/too large to materialise/u);
    // The same bound applies to a negative exponent, which the divisor branch would materialise
    // just as unboundedly.
    expect(() => asBigInt(jsonNumber('1e-100000000'))).toThrow(TsonJsonValueError);
    // `toBigDecimal` never materialises `10n ** exponent` at all, so the same magnitude is fine
    // there -- it is only exact-integer narrowing that pays that cost.
    expect(toBigDecimal(jsonNumber('1e100000000'))).toEqual({ unscaled: 1n, exponent: 100000000 });
  });

  it('full precision is one call away', () => {
    expect(toBigDecimal(jsonNumber('1234567890123456789012345.6789'))).toEqual({
      unscaled: 12345678901234567890123456789n,
      exponent: -4,
    });
    expect(toBigDecimal(jsonNumber('1e1'))).toEqual({ unscaled: 1n, exponent: 1 });
  });

  it('a number keeps its digits and its scale through the tree', () => {
    // §5.3: `199.90` is not `199.9`, and digits are the promise.
    expect(jsonValueToText(parseJson('199.90'))).toBe('199.90');
    expect(jsonValueToText(parseJson('6.02e23'))).toBe('6.02e23');
    expect(jsonValueToText(parseJson('-0.0'))).toBe('-0.0');
  });

  it('jsonNumber validates its lexeme rather than trusting a hand-built caller', () => {
    expect(jsonNumber('42').literal).toBe('42');
    expect(jsonNumber('-0.5e10').literal).toBe('-0.5e10');
    expect(() => jsonNumber('NaN')).toThrow(/not a well-formed RFC 8259 number/u);
    expect(() => jsonNumber('0x10')).toThrow(/not a well-formed RFC 8259 number/u);
    expect(() => jsonNumber('abc')).toThrow(/not a well-formed RFC 8259 number/u);
    expect(() => jsonNumber('01')).toThrow(/not a well-formed RFC 8259 number/u); // no leading zero
    expect(() => jsonNumber('1.')).toThrow(/not a well-formed RFC 8259 number/u); // fraction needs a digit
    expect(() => jsonNumber('.5')).toThrow(/not a well-formed RFC 8259 number/u); // integer part required
  });

  it('a malformed literal handed to jsonValueToText fails at construction, not at write time', () => {
    expect(() => jsonValueToText(jsonArray([jsonNumber('NaN')]))).toThrow(
      /not a well-formed RFC 8259 number/u,
    );
  });

  it('number equality is over the lexeme because a value space needs a type', () => {
    expect(equalJsonValue(parseJson('1'), parseJson('1.0'))).toBe(false);
    expect(equalJsonValue(parseJson('100'), parseJson('1e2'))).toBe(false);
  });
});

describe('the value model', () => {
  it('equality is over content, so two parses of one document are equal', () => {
    expect(equalJsonValue(parseJson('{"a": [1, "x"]}'), parseJson('{"a":[1,"x"]}'))).toBe(true);
  });

  it('object equality is over the member set, not the order', () => {
    expect(equalJsonValue(parseJson('{"a":1,"b":2}'), parseJson('{"b":2,"a":1}'))).toBe(true);
    // ... and the order each was written in survives for re-emission.
    expect(jsonValueToText(parseJson('{"b":2,"a":1}'))).toBe('{"b":2,"a":1}');
  });

  it('a constructed value equals the parsed one', () => {
    expect(
      equalJsonValue(
        parseJson('{"a": [1, true]}'),
        jsonObject(new Map([['a', jsonArray([jsonNumber('1'), jsonBoolean(true)])]])),
      ),
    ).toBe(true);
  });

  it('the object builder copies defensively', () => {
    const members = new Map([['a', jsonNumber('1')]]);
    const built = jsonObject(members);
    members.set('a', jsonNumber('2'));
    expect(built.members.get('a')).toEqual(jsonNumber('1'));
  });
});

describe('quoteJsonString', () => {
  it('escapes what RFC 8259 requires and nothing more', () => {
    expect(quoteJsonString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(quoteJsonString('a/b')).toBe('"a/b"');
    expect(quoteJsonString('a\nb\tb')).toBe('"a\\nb\\tb"');
    expect(quoteJsonString('é☃')).toBe('"é☃"');
  });

  it('refuses a lone surrogate rather than writing text this package would refuse reading back -- §9.2, §4.3', () => {
    // A well-formed pair still writes fine.
    expect(quoteJsonString('😀')).toBe('"😀"');
    // A lone high surrogate, and a lone low surrogate, each half of a pair with no partner.
    expect(() => quoteJsonString('\ud800')).toThrow(/lone surrogate/u);
    expect(() => quoteJsonString('\udc00')).toThrow(/lone surrogate/u);
    expect(() => quoteJsonString('a\ud800b')).toThrow(/lone surrogate/u);
  });
});

describe('toDisplayString', () => {
  it('is an indented, multi-line rendering that reads back to the same value', () => {
    const value = parseJson('{"a":[1,{"b":null}],"c":{},"d":[]}');
    const displayed = jsonValueToDisplayString(value);
    expect(displayed).toContain('\n');
    expect(equalJsonValue(parseJson(displayed), value)).toBe(true);
  });

  it('leaves an empty container on one line', () => {
    expect(jsonValueToDisplayString(parseJson('{"a":{},"b":[]}'))).toBe(
      '{\n  "a": {},\n  "b": []\n}',
    );
  });
});
