import { describe, expect, it } from 'vitest';
import { createEmitter, stringSink } from '../src/write/emitter.js';
import { TsonWriteError } from '../src/core/errors.js';

/**
 * `write/emitter.ts` -- the grammar-level writing primitives (§2.4, §2.5, §2.6, §2.7, §2.9, §3.1,
 * §3.2, §3.3, §7.2.2, §7.2.3), ported from `TsonDataEmitter.java`. Exercised directly, with no
 * value model above it, mirroring how `lexer.test.ts` exercises the lexer with no parser above it.
 */

function emit(build: (out: ReturnType<typeof createEmitter>) => void): string {
  const { sink, result } = stringSink();
  build(createEmitter(sink));
  return result();
}

describe('§2.5/§2.6/§2.7 separation -- a single space before every element, none required by a delimiter', () => {
  it('a record separates fields with a space, not a comma', () => {
    const text = emit((out) => {
      out.beginRecord();
      out.field('x');
      out.unquotedToken('1');
      out.field('y');
      out.unquotedToken('2');
      out.endRecord();
    });
    expect(text).toBe('{ x: 1 y: 2 }');
  });

  it('an empty record has no interior space at all', () => {
    const text = emit((out) => {
      out.beginRecord();
      out.endRecord();
    });
    expect(text).toBe('{}');
  });

  it('a map writes key => value pairs, space-separated', () => {
    const text = emit((out) => {
      out.beginMap();
      out.beforeMapEntry();
      out.quotedString('a');
      out.mapArrow();
      out.unquotedToken('1');
      out.endMap();
    });
    expect(text).toBe('{ "a" => 1 }');
  });

  it('an array puts a space before every element, including the first, and before the closing delimiter', () => {
    const text = emit((out) => {
      out.beginArray();
      out.beforeArrayElement();
      out.unquotedToken('1');
      out.beforeArrayElement();
      out.unquotedToken('2');
      out.endArray();
    });
    expect(text).toBe('[ 1 2 ]');
  });

  it('an empty array has no interior space, like an empty record', () => {
    const text = emit((out) => {
      out.beginArray();
      out.endArray();
    });
    expect(text).toBe('[]');
  });
});

describe('§3.1 annotations', () => {
  it('a valueless annotation carries its own trailing space (§3.1: the boundary rule)', () => {
    const text = emit((out) => {
      out.annotation('deprecated');
      out.nullValue();
    });
    expect(text).toBe('@deprecated null');
  });

  it('a valued annotation has no space after the colon, and one space closing it', () => {
    const text = emit((out) => {
      out.beginAnnotation('doc');
      out.quotedString('hi');
      out.endAnnotation();
      out.unquotedToken('42');
    });
    expect(text).toBe('@doc:"hi" 42');
  });
});

describe('§3.2 type annotations', () => {
  it('!name is adjacent to the name with a single trailing space', () => {
    const text = emit((out) => {
      out.typeRef('uuid');
      out.quotedString('x');
    });
    expect(text).toBe('!uuid "x"');
  });

  it('a second type-ref on one value is refused (§3.2 admits at most one)', () => {
    expect(() =>
      emit((out) => {
        out.typeRef('int32');
        out.typeRef('int64');
      }),
    ).toThrow(TsonWriteError);
  });

  it('a nested value may carry its own type-ref independent of its parent', () => {
    const text = emit((out) => {
      out.typeRef('a');
      out.beginArray();
      out.beforeArrayElement();
      out.typeRef('b');
      out.unquotedToken('1');
      out.endArray();
    });
    expect(text).toBe('!a [ !b 1 ]');
  });
});

describe('§2.2/§3.3 header directives', () => {
  it('documentId writes !!id:"<uri>" terminated by a newline, first', () => {
    const text = emit((out) => {
      out.documentId('https://example.com/doc.tn');
      out.nullValue();
    });
    expect(text).toBe('!!id:"https://example.com/doc.tn"\nnull');
  });

  it('schemaRef writes !!schema:"<uri>" terminated by a newline', () => {
    const text = emit((out) => {
      out.schemaRef('https://example.com/schema.tn');
      out.nullValue();
    });
    expect(text).toBe('!!schema:"https://example.com/schema.tn"\nnull');
  });

  it('a directive argument that is not a valid URI is refused rather than written unreadably', () => {
    expect(() =>
      emit((out) => {
        out.documentId('not a uri at all: spaces and : and no scheme');
      }),
    ).toThrow(TsonWriteError);
  });
});

const BACKSLASH = String.fromCharCode(0x5c);
const BACKSPACE = String.fromCharCode(0x08);
const FORM_FEED = String.fromCharCode(0x0c);
const LINE_FEED = String.fromCharCode(0x0a);
const CARRIAGE_RETURN = String.fromCharCode(0x0d);
const TAB = String.fromCharCode(0x09);

describe('§7.2.2 single-line quoted strings -- minimal escaping', () => {
  it('escapes ", \\, and the named C0 controls with their short named form', () => {
    const input =
      'a"b' +
      BACKSLASH +
      'c' +
      BACKSPACE +
      'd' +
      FORM_FEED +
      'e' +
      LINE_FEED +
      'f' +
      CARRIAGE_RETURN +
      'g' +
      TAB +
      'h';
    const expectedInner = 'a\\"b\\\\c\\bd\\fe\\nf\\rg\\th';
    const text = emit((out) => {
      out.quotedString(input);
    });
    expect(text).toBe(`"${expectedInner}"`);
  });

  it('an unnamed C0 control escapes as \\u00XX, lowercase hex', () => {
    const text = emit((out) => {
      out.quotedString(String.fromCharCode(0x01));
    });
    expect(text).toBe('"\\u0001"');
  });

  it('non-ASCII text is left literal', () => {
    const text = emit((out) => {
      out.quotedString('héllo 世界');
    });
    expect(text).toBe('"héllo 世界"');
  });
});

describe('§7.2.3 multi-line strings -- closing delimiter at column 0, so no indentation is stripped on read back', () => {
  it('round-trips a simple multi-line value with no escaping needed', () => {
    const text = emit((out) => {
      out.multiLineString('line one' + LINE_FEED + 'line two');
    });
    expect(text).toBe('"""\nline one\nline two\n"""\n');
  });

  it('escapes trailing whitespace on a content line so it is not stripped back off on read', () => {
    const text = emit((out) => {
      out.multiLineString('trailing ' + TAB);
    });
    expect(text).toBe('"""\ntrailing\\u0020\\u0009\n"""\n');
  });

  it('escapes a leading """ so it is not mistaken for the closing delimiter', () => {
    const text = emit((out) => {
      out.multiLineString('"""oops');
    });
    expect(text).toBe('"""\n\\u0022""oops\n"""\n');
  });

  it('preserves an empty trailing line from a trailing newline in the value', () => {
    const text = emit((out) => {
      out.multiLineString('one' + LINE_FEED);
    });
    expect(text).toBe('"""\none\n\n"""\n');
  });
});

describe('leaf tokens', () => {
  it('null and absent are distinct spellings', () => {
    expect(
      emit((out) => {
        out.nullValue();
      }),
    ).toBe('null');
    expect(
      emit((out) => {
        out.absentValue();
      }),
    ).toBe('_');
  });

  it('booleanValue writes true/false unquoted', () => {
    expect(
      emit((out) => {
        out.booleanValue(true);
      }),
    ).toBe('true');
    expect(
      emit((out) => {
        out.booleanValue(false);
      }),
    ).toBe('false');
  });
});
