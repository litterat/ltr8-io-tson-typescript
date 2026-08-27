import { describe, expect, it } from 'vitest';
import {
  TsonAtomParseError,
  TsonAtomValidationError,
  TsonAtomTypeError,
  TsonError,
  TsonLexError,
  TsonParseError,
} from '../src/core/errors.js';
import { TsonRegexSyntaxError } from '../src/regex/errors.js';

const POSITION = { line: 3, column: 12, offset: 47 };

describe('atom errors carry a structured expected (§8.1)', () => {
  // `expected` is the machine-readable half of the failure and reaches Diagnostic.expected
  // verbatim. It is required rather than optional precisely so that thirty-three parsers cannot
  // each decide to skip it — a constraint recoverable only by re-reading the prose message is
  // one the reader would have to parse back out of a sentence.

  it('requires expected on a parse failure, as a grammar fragment', () => {
    const error = new TsonAtomParseError('base64', 'not a base64 encoding', 'a base64 encoding');
    expect(error.typeRef).toBe('base64');
    expect(error.expected).toBe('a base64 encoding');
    expect(error.message).toBe('not a base64 encoding');
  });

  it('requires expected on a validation failure, as an operator-form bound', () => {
    const error = new TsonAtomValidationError('int32', 'value overflows int32', '<= 2147483647');
    expect(error.typeRef).toBe('int32');
    expect(error.expected).toBe('<= 2147483647');
  });

  it('shares one base, so a reader can catch both and reach expected', () => {
    // AtomTypeReader catches the pair and builds a diagnostic from (message, expected, tokenText).
    // That is only possible if both reach `expected` through a common type.
    const errors: TsonAtomTypeError[] = [
      new TsonAtomParseError('uuid', 'malformed', 'an RFC 9562 UUID'),
      new TsonAtomValidationError('uuid', 'out of range', 'one of (v4, v7)'),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(TsonAtomTypeError);
      expect(error).toBeInstanceOf(TsonError);
      expect(typeof error.expected).toBe('string');
      expect(error.expected.length).toBeGreaterThan(0);
    }
  });

  it('keeps the two categories distinguishable, which the suite asserts separately', () => {
    const parse = new TsonAtomParseError('date', 'unparseable', 'an RFC 3339 date');
    const validation = new TsonAtomValidationError('date', 'before minimum', '>= 2020-01-01');
    expect(parse).not.toBeInstanceOf(TsonAtomValidationError);
    expect(validation).not.toBeInstanceOf(TsonAtomParseError);
    expect(parse.name).toBe('TsonAtomParseError');
    expect(validation.name).toBe('TsonAtomValidationError');
  });
});

describe('structural errors carry expected/actual (§8.1)', () => {
  it('carries the pair when the failure names a substitution', () => {
    // The four-argument shape the event stream uses: "expected X, found Y".
    const error = new TsonParseError('expected a value, found }', POSITION, {
      expected: 'a value',
      actual: '}',
    });
    expect(error.expected).toBe('a value');
    expect(error.actual).toBe('}');
    expect(error.position).toEqual(POSITION);
  });

  it('omits both when the failure states a rule rather than a substitution', () => {
    // An adjacency violation or a trailing separator has no substitution to name. The pair is
    // all-or-nothing: no throw site invents one to fill the other.
    const error = new TsonParseError('a separator may not trail its sequence', POSITION);
    expect(error.expected).toBeUndefined();
    expect(error.actual).toBeUndefined();
    expect(error.position).toEqual(POSITION);
  });

  it('leaves the lexer unchanged, which carries message and position only', () => {
    // The reference implementation's LexException carries no expected/actual, and this port
    // deliberately matches it rather than inventing a wider contract.
    const error = new TsonLexError('unterminated token', POSITION);
    expect(error.position).toEqual(POSITION);
    expect(error).toBeInstanceOf(TsonError);
  });
});

describe('the I-Regexp error stays inside the regex leaf', () => {
  // regex/ imports nothing outside itself — an enforced zone — so its error cannot extend
  // TsonError. This is deliberate and matches the reference implementation, where
  // TsonRegexSyntaxException extends RuntimeException rather than any TSON base.

  it('is an Error but deliberately not a TsonError', () => {
    const error = new TsonRegexSyntaxError('bad quantifier', 'a{2,1}', 3);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(TsonRegexSyntaxError);
    expect(error instanceof TsonError).toBe(false);
  });

  it('carries the pattern and the code-point position that failed', () => {
    const error = new TsonRegexSyntaxError('bad quantifier', 'a{2,1}', 3);
    expect(error.pattern).toBe('a{2,1}');
    expect(error.position).toBe(3);
    expect(error.message).toContain('a{2,1}');
    expect(error.message).toContain('3');
  });

  it('counts the position in code points, not UTF-16 units', () => {
    // A pattern containing an astral character would otherwise report a position no reader can
    // count to. The engine supplies the index; this pins what the index means.
    const pattern = '\u{1F600}{2,1}';
    const error = new TsonRegexSyntaxError('bad quantifier', pattern, 1);
    expect(error.position).toBe(1);
    expect(Array.from(pattern)[0]).toBe('\u{1F600}');
  });

  it('keeps a working prototype chain across subclassing', () => {
    class Narrower extends TsonRegexSyntaxError {}
    const error = new Narrower('x', 'y', 0);
    expect(error).toBeInstanceOf(Narrower);
    expect(error).toBeInstanceOf(TsonRegexSyntaxError);
  });
});
