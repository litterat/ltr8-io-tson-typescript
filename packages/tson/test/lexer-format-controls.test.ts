import { describe, expect, it } from 'vitest';
import { fromString, runSync, type Task } from '../src/io/bytes.js';
import { createLexer } from '../src/lexer/lexer.js';
import { TsonLexError } from '../src/core/errors.js';

/** Drains every token, so an error raised on a later token is not missed. */
function lexAll(source: string): string[] {
  const lexer = createLexer(fromString(source));
  return runSync(
    (function* (): Task<string[]> {
      const kinds: string[] = [];
      for (;;) {
        const type = yield* lexer.nextToken();
        if (type === 'eof') return kinds;
        kinds.push(`${type}:${lexer.text}`);
        if (kinds.length > 32) return kinds;
      }
    })(),
  );
}

describe('format controls are not identifier characters (§7.1, §9.4)', () => {
  // ZWNJ and ZWJ are XID_Continue from Unicode 16, so nothing about the property tables keeps
  // them out. §7.1 subtracts them deliberately: they are invisible, so they are confusable and
  // spoofing surface. A name whose orthography needs them must be quoted.

  it.each([
    ['ZWNJ', '‌'],
    ['ZWJ', '‍'],
  ])('rejects %s inside an unquoted token', (_name, control) => {
    expect(() => lexAll(`a${control}b`)).toThrow(TsonLexError);
  });

  it.each([
    ['ZWNJ', '‌'],
    ['ZWJ', '‍'],
  ])('rejects %s at the start of an unquoted token', (_name, control) => {
    expect(() => lexAll(`${control}ab`)).toThrow(TsonLexError);
  });

  it.each([
    ['ZWNJ', '‌'],
    ['ZWJ', '‍'],
  ])('accepts %s inside a quoted token, which is how such a name is written', (_name, control) => {
    const kinds = lexAll(`"a${control}b"`);
    expect(kinds).toHaveLength(1);
    expect(kinds[0]).toBe(`single-line-token:a${control}b`);
  });

  it('still lexes an ordinary unquoted token', () => {
    expect(lexAll('abc')).toEqual(['unquoted-token:abc']);
  });
});
