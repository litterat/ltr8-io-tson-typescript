import { describe, expect, it } from 'vitest';
import { TsonLexError } from '../src/core/errors.js';
import { fromBytes, fromString, runSync } from '../src/io/bytes.js';
import {
  createJsonLexer,
  currentJsonToken,
  type JsonToken,
  type JsonTokenType,
} from '../src/json/lexer.js';

/** Drives a lexer to completion over already-complete input, collecting every token including `eof`. */
function scanBytes(bytes: Uint8Array): JsonToken[] {
  const lexer = createJsonLexer(fromBytes(bytes));
  const tokens: JsonToken[] = [];
  for (;;) {
    const type = runSync(lexer.nextToken());
    tokens.push(currentJsonToken(lexer, type));
    if (type === 'eof') return tokens;
  }
}

function scan(text: string): JsonToken[] {
  return scanBytes(new TextEncoder().encode(text));
}

function types(text: string): JsonTokenType[] {
  return scan(text).map((t) => t.type);
}

/** The one token a source holds, `eof` aside. */
function only(text: string): JsonToken {
  const tokens = scan(text);
  expect(tokens).toHaveLength(2);
  expect(tokens[1]?.type).toBe('eof');
  const token = tokens[0];
  if (token === undefined) throw new Error('unreachable');
  return token;
}

function refused(text: string): TsonLexError {
  try {
    scan(text);
  } catch (e) {
    expect(e).toBeInstanceOf(TsonLexError);
    return e as TsonLexError;
  }
  throw new Error(`expected a TsonLexError, but scanning '${text}' succeeded`);
}

describe('§3.1 structure', () => {
  it('the six structural characters each lex to their own kind', () => {
    expect(types('{}[]:,')).toEqual([
      'begin-object',
      'end-object',
      'begin-array',
      'end-array',
      'name-separator',
      'value-separator',
      'eof',
    ]);
  });

  it('an empty document is just end of input', () => {
    expect(types('')).toEqual(['eof']);
  });

  it('whitespace is the four characters RFC 8259 names and no others', () => {
    expect(types(' \t\r\n[ \t\r\n] \t\r\n')).toEqual(['begin-array', 'end-array', 'eof']);
  });

  it('a non-JSON whitespace character between tokens is refused', () => {
    // U+00A0 NO-BREAK SPACE is Pattern_White_Space to the TSON lexer and nothing at all to this one.
    expect(refused('[\u00a01]').message).toContain('not the start of any JSON value');
  });

  it('nothing structural is read here, so a stray closer lexes clean', () => {
    expect(types('] : ,')).toEqual(['end-array', 'name-separator', 'value-separator', 'eof']);
  });
});

describe('§3.1 literals', () => {
  it('the three literal names lex whole', () => {
    expect(types('true false null')).toEqual(['true', 'false', 'null', 'eof']);
    expect(only('null').text).toBe('null');
  });

  it('a misspelled literal names the literal it was reaching for', () => {
    expect(refused('nul').message).toContain("'null'");
    expect(refused('True').message).toContain('not the start of any JSON value');
    expect(refused('fasle').message).toContain("'false'");
  });

  it('a misspelled literal reports at its own start, not at the letter that broke it', () => {
    const e = refused('[1, nul]');
    expect(e.position).toEqual({ line: 1, column: 5, offset: 4 });
  });
});

describe('§3.1 numbers', () => {
  it('a number keeps its exact source lexeme', () => {
    // §5.3: digits and scale are preserved, so `199.90` must not become `199.9`.
    expect(only('199.90').text).toBe('199.90');
    expect(only('6.02e23').text).toBe('6.02e23');
    expect(only('-0.0').text).toBe('-0.0');
    expect(only('1E+2').text).toBe('1E+2');
  });

  it('arbitrary precision survives because nothing funnels it through binary64', () => {
    const digits = '1234567890123456789012345678901234567890.12345678901234567890';
    expect(only(digits).text).toBe(digits);
    expect(only('9007199254740993').text).toBe('9007199254740993');
  });

  it('the forms RFC 8259 admits', () => {
    expect(only('0').type).toBe('number');
    expect(only('-0').type).toBe('number');
    expect(only('0.5').type).toBe('number');
    expect(only('1e-7').type).toBe('number');
  });

  it('a leading zero is refused where it stands, rather than left to the grammar', () => {
    expect(refused('01').message).toContain("single '0' or starts with a nonzero digit");
  });

  it('the forms RFC 8259 does not admit', () => {
    expect(refused('+1').message).toContain('not the start of any JSON value');
    expect(refused('.5').message).toContain('not the start of any JSON value');
    expect(refused('5.').message).toContain('fraction needs at least one digit');
    expect(refused('1e').message).toContain('exponent needs at least one digit');
    expect(refused('1e+').message).toContain('exponent needs at least one digit');
    expect(refused('-').message).toContain('at least one digit');
  });

  it('the special values have no number spelling here', () => {
    // §5.4 puts `.nan`/the infinities in *strings*, and only at approximate positions.
    expect(refused('NaN').message).toContain('not the start of any JSON value');
    expect(refused('Infinity').message).toContain('not the start of any JSON value');
    expect(refused('-Infinity').message).toContain('at least one digit');
    // `0x1F` lexes the `0` -- a whole, legal number -- and stops; `x` is then refused on its own.
    expect(refused('0x1F').message).toContain("'x' is not the start of any JSON value");
  });
});

describe('§3.1 strings', () => {
  it('a string carries its decoded content', () => {
    expect(only('"hello"').text).toBe('hello');
    expect(only('""').text).toBe('');
  });

  it('every escape RFC 8259 defines decodes, including the solidus TSON text dropped', () => {
    // [TSON-DATA] §7.2.2 dropped `\/`; it is JSON's escape and it stays here.
    expect(only('"\\" \\\\ \\/ \\b \\f \\n \\r \\t"').text).toBe('" \\ / \b \f \n \r \t');
  });

  it('a \\u escape names a code unit', () => {
    expect(only('"\\u0041"').text).toBe('A');
    expect(only('"\\u00e9"').text).toBe('\u00e9');
  });

  it('a well-formed surrogate pair is one character', () => {
    const decoded = only('"\\uD83D\\uDE00"').text;
    expect(Array.from(decoded).length).toBe(1);
    expect(decoded.codePointAt(0)).toBe(0x1f600);
  });

  it('an escape that would decode to a lone surrogate is refused, not repaired', () => {
    expect(refused('"\\uD83D"').message).toContain('no \\u escape after it');
    expect(refused('"\\uDE00"').message).toContain('no high surrogate before it');
    expect(refused('"\\uD83Dx"').message).toContain('no \\u escape after it');
    expect(refused('"\\uD83D\\u0041"').message).toContain('is not a low surrogate');
    expect(refused('"\\uD83D\\n"').message).toContain('is not \\u');
  });

  it('an unknown escape is refused', () => {
    expect(refused('"\\x"').message).toContain('not a JSON escape character');
    expect(refused('"\\u00G0"').message).toContain('four hexadecimal digits');
    expect(refused('"\\u00"').message).toContain('four hexadecimal digits');
  });

  it('a raw control character inside a string is refused', () => {
    expect(refused('"a\nb"').message).toContain('U+000A');
    expect(refused('"a\u0000b"').message).toContain('U+0000');
    expect(refused('"a\tb"').message).toContain('U+0009');
  });

  it('an unterminated string reports at the opening quote', () => {
    const e = refused('{"a": "unterminated}');
    expect(e.message).toContain('ends inside a string');
    expect(e.position).toEqual({ line: 1, column: 7, offset: 6 });
  });

  it('content needing a multi-line token in TSON text is ordinary escaped content here', () => {
    expect(only('"line\\none \\"quoted\\""').text).toBe('line\none "quoted"');
  });
});

describe('§3.1 UTF-8', () => {
  it('multi-byte characters decode and count one column each', () => {
    const token = only('"\u00e9\u4e2d\ud83d\ude00"');
    expect(token.text).toBe('\u00e9\u4e2d\ud83d\ude00');
    expect(token.end.column).toBe(6);
    expect(token.end.offset).toBe(11);
  });

  it('an invalid byte sequence is an error rather than a replacement character', () => {
    const e = refused0xFF([0x22, 0xc3, 0x28, 0x22]);
    expect(e.message).toContain('not valid UTF-8');
    expect(e.message).toContain('not a UTF-8 continuation byte');
  });

  it('the classic smuggling forms are refused', () => {
    expect(refused0xFF([0xc0, 0xaf]).message).toContain('shortest form');
    expect(refused0xFF([0xed, 0xa0, 0x80]).message).toContain('surrogate code point');
  });

  it('a truncated sequence at end of input is refused', () => {
    expect(refused0xFF([0xe4, 0xb8]).message).toContain('ends in the middle');
  });

  it('a malformed sequence reports the offset of its own first byte', () => {
    const source = new TextEncoder().encode('[1, ');
    const withBadByte = new Uint8Array([...source, 0xff]);
    let error: TsonLexError | undefined;
    try {
      scanBytes(withBadByte);
    } catch (e) {
      error = e as TsonLexError;
    }
    expect(error?.position.offset).toBe(4);
  });

  it('a single leading BOM is discarded and counts toward nothing', () => {
    const first = scan('\ufeff[1]')[0];
    expect(first?.type).toBe('begin-array');
    expect(first?.start).toEqual({ line: 1, column: 1, offset: 0 });
  });

  it('a BOM that is not leading is an ordinary character', () => {
    expect(only('"\ufeff"').text).toBe('\ufeff');
    expect(refused('[\ufeff1]').message).toContain('not the start of any JSON value');
  });

  function refused0xFF(bytes: number[]): TsonLexError {
    try {
      scanBytes(new Uint8Array(bytes));
    } catch (e) {
      return e as TsonLexError;
    }
    throw new Error('expected a TsonLexError');
  }
});

describe('§3.1 positions', () => {
  it('line, column and byte offset track together', () => {
    const tokens = scan('{\n  "a": 1\n}');
    expect(tokens[0]?.start).toEqual({ line: 1, column: 1, offset: 0 }); // {
    expect(tokens[1]?.start).toEqual({ line: 2, column: 3, offset: 4 }); // "a"
    expect(tokens[2]?.start).toEqual({ line: 2, column: 6, offset: 7 }); // :
    expect(tokens[3]?.start).toEqual({ line: 2, column: 8, offset: 9 }); // 1
    expect(tokens[4]?.start).toEqual({ line: 3, column: 1, offset: 11 }); // }
  });

  it('a CRLF pair is one line break', () => {
    const tokens = scan('[\r\n1\r\n]');
    expect(tokens[1]?.start.line).toBe(2);
    expect(tokens[2]?.start.line).toBe(3);
  });

  it('a lone CR is a line break of its own', () => {
    expect(scan('[\r1]')[1]?.start.line).toBe(2);
  });

  it('the line separators the TSON lexer counts are not line breaks here', () => {
    // U+2028/U+2029 are line terminators to [TSON-DATA] §7.2 and ordinary characters to RFC 8259.
    expect(only('"\u2028\u2029"').text).toBe('\u2028\u2029');
    expect(only('"\u2028\u2029"').end.line).toBe(1);
  });

  it('end of input reports the position after the last token', () => {
    const tokens = scan('[1]');
    expect(tokens.at(-1)?.start).toEqual({ line: 1, column: 4, offset: 3 });
  });
});

describe('token stream', () => {
  it('end of input repeats', () => {
    const lexer = createJsonLexer(fromString('1'));
    expect(runSync(lexer.nextToken())).toBe('number');
    expect(runSync(lexer.nextToken())).toBe('eof');
    expect(runSync(lexer.nextToken())).toBe('eof');
  });

  it('the accessors describe whichever token was produced last', () => {
    const lexer = createJsonLexer(fromString('  "ab"'));
    expect(runSync(lexer.nextToken())).toBe('string');
    expect(lexer.text).toBe('ab');
    expect(lexer.start).toEqual({ line: 1, column: 3, offset: 2 });
    expect(lexer.end).toEqual({ line: 1, column: 7, offset: 6 });
  });

  it('a document read from bytes and the same document read from a string lex alike', () => {
    const source = '{"\u00e9": [1, true, null]}';
    expect(scanBytes(new TextEncoder().encode(source))).toEqual(scan(source));
  });

  it('a document longer than the read buffer lexes whole', () => {
    const source = `"${'x'.repeat(4096)}"`;
    expect(only(source).text).toHaveLength(4096);
  });
});
