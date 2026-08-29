import { describe, expect, it } from 'vitest';
import { TsonLexError } from '../src/core/errors.js';
import { fromString, runSync, type Task } from '../src/io/bytes.js';
import { createLexer } from '../src/lexer/lexer.js';

const LRM = '‎';
const RLM = '‏';

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

// §7.2 rule 1 / §7.4's `ws`/`ws1`/`ignorable-format`: LRM (U+200E) and RLM (U+200F) are
// bidirectional marks, not horizontal space. They are consumed and contribute nothing, and are
// legal only where a token boundary already exists — a run standing where the surrounding
// characters would otherwise continue one unquoted token is a lexer error.

describe.each([
  ['LRM', LRM],
  ['RLM', RLM],
])('%s is an ignorable format control, not horizontal space (§7.2 rule 1)', (_name, mark) => {
  it('inside an array between two digits is a lexer error, not two elements', () => {
    // Was a two-element array under the old flat Pattern_White_Space treatment.
    expect(() => lexAll(`[1${mark}2]`)).toThrow(TsonLexError);
  });

  it('between two unquoted-token halves is a lexer error, not two tokens', () => {
    // Was `ad` and `min` as two separate tokens under the old treatment.
    expect(() => lexAll(`ad${mark}min`)).toThrow(TsonLexError);
  });

  it('names the offending character and its position in the error', () => {
    let error: TsonLexError | undefined;
    try {
      lexAll(`ad${mark}min`);
    } catch (e) {
      error = e as TsonLexError;
    }
    expect(error).toBeInstanceOf(TsonLexError);
    expect(error?.message).toContain(mark === LRM ? 'U+200E' : 'U+200F');
    expect(error?.position.line).toBe(1);
    expect(error?.position.column).toBe(3); // the mark itself, right after "ad"
  });

  it('between two tokens already separated by real whitespace is fine', () => {
    // A boundary already exists (adjacent to horizontal space), so the run is legal.
    expect(lexAll(`foo ${mark} bar`)).toEqual(['unquoted-token:foo', 'unquoted-token:bar']);
  });

  it('adjacent to horizontal space on only one side is still fine', () => {
    expect(lexAll(`foo ${mark}bar`)).toEqual(['unquoted-token:foo', 'unquoted-token:bar']);
    expect(lexAll(`foo${mark} bar`)).toEqual(['unquoted-token:foo', 'unquoted-token:bar']);
  });

  it('adjacent to a line terminator is fine', () => {
    expect(lexAll(`foo\n${mark}bar`)).toEqual(['unquoted-token:foo', 'unquoted-token:bar']);
    expect(lexAll(`foo${mark}\nbar`)).toEqual(['unquoted-token:foo', 'unquoted-token:bar']);
  });

  it('between a token and a structural delimiter is fine — the delimiter is already a boundary', () => {
    expect(lexAll(`[1${mark}]`)).toEqual(['lbracket:[', 'unquoted-token:1', 'rbracket:]']);
    expect(lexAll(`{${mark}}`)).toEqual(['lbrace:{', 'rbrace:}']);
  });

  it('between a token and a special token is fine', () => {
    expect(lexAll(`1${mark}@a x`)).toEqual([
      'unquoted-token:1',
      'at:@',
      'unquoted-token:a',
      'unquoted-token:x',
    ]);
  });

  it('at the very start of the document is fine — no preceding token exists', () => {
    expect(lexAll(`${mark}foo`)).toEqual(['unquoted-token:foo']);
  });

  it('at the very end of the document is fine — no following token exists', () => {
    expect(lexAll(`foo${mark}`)).toEqual(['unquoted-token:foo']);
  });

  it('immediately before ".." is fine: the range token already terminates the number', () => {
    // §7.2 rule 3 terminates an unquoted token before consecutive dots regardless of the mark.
    expect(lexAll(`1${mark}..2`)).toEqual([
      'unquoted-token:1',
      'range-token:..',
      'unquoted-token:2',
    ]);
  });

  it('a run of only the mark, with no real separator anywhere, is still a lexer error', () => {
    expect(() => lexAll(`ad${mark}${mark}min`)).toThrow(TsonLexError);
  });

  it('consumed silently is never emitted as, or folded into, a token', () => {
    // The boundary case: text either side of a legal occurrence lexes to exactly the tokens the
    // mark's absence would produce, with the mark itself contributing nothing to either token's text.
    expect(lexAll(`foo ${mark}bar ${mark}baz`)).toEqual([
      'unquoted-token:foo',
      'unquoted-token:bar',
      'unquoted-token:baz',
    ]);
  });
});

describe('a run mixing LRM/RLM with real whitespace is legal regardless of internal order', () => {
  it('a control preceding a real space in one run', () => {
    expect(lexAll(`ad${LRM} min`)).toEqual(['unquoted-token:ad', 'unquoted-token:min']);
  });

  it('a control following a real space in one run', () => {
    expect(lexAll(`ad ${LRM}min`)).toEqual(['unquoted-token:ad', 'unquoted-token:min']);
  });

  it('both marks around a real space', () => {
    expect(lexAll(`ad${LRM} ${RLM}min`)).toEqual(['unquoted-token:ad', 'unquoted-token:min']);
  });
});
