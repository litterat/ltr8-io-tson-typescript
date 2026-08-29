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

describe('the joining controls ZWNJ/ZWJ are ordinary token content at the lexer layer (§7.1)', () => {
  // Both are XID_Continue — UAX #31 made them default identifier characters when it withdrew its
  // former contextual requirement, relocating the safety rule to UTS #39 — and §7.1 states the
  // token profile as the property union with no subtraction, so the lexer admits them
  // unconditionally. What constrains a joiner is a *name* rule at naming positions (§7.7 rule 2),
  // layered on top by the identifier grammar — out of the lexer's own scope entirely.

  it.each([
    ['ZWNJ', '‌'],
    ['ZWJ', '‍'],
  ])('lexes %s inside an unquoted token as ordinary continuation content', (_name, control) => {
    const kinds = lexAll(`a${control}b`);
    expect(kinds).toEqual([`unquoted-token:a${control}b`]);
  });

  it.each([
    ['ZWNJ', '‌'],
    ['ZWJ', '‍'],
  ])('rejects %s at the start of an unquoted token', (_name, control) => {
    // Neither is XID_Start, so unquoted-start still refuses it regardless of the continuation
    // change — this is unaffected by the revision.
    expect(() => lexAll(`${control}ab`)).toThrow(TsonLexError);
  });

  it.each([
    ['ZWNJ', '‌'],
    ['ZWJ', '‍'],
  ])('accepts %s inside a quoted token, as before', (_name, control) => {
    const kinds = lexAll(`"a${control}b"`);
    expect(kinds).toHaveLength(1);
    expect(kinds[0]).toBe(`single-line-token:a${control}b`);
  });

  it('still lexes an ordinary unquoted token', () => {
    expect(lexAll('abc')).toEqual(['unquoted-token:abc']);
  });
});
