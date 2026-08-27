import { describe, expect, it } from 'vitest';
import { fromString, runSync, type Task } from '../src/io/bytes.js';
import { createDataStream } from '../src/stream/dataStream.js';
import { TsonParseError } from '../src/core/errors.js';

/** Drains the whole event stream, so a failure at any point surfaces. */
function drain(source: string): number {
  const events = createDataStream(fromString(source));
  return runSync(
    (function* (): Task<number> {
      let n = 0;
      for (;;) {
        const event = yield* events.next();
        n += 1;
        if (event.kind === 'document-end') return n;
        if (n > 64) return n;
      }
    })(),
  );
}

describe("a directive's argument must be a URI (§3.3)", () => {
  it('rejects an argument with an unescaped space', () => {
    // The shared conformance vector parser/invalid/directive-argument-not-a-uri. Without the
    // check this parses clean through to document-end.
    expect(() => drain('!!id:"not a uri"\n_')).toThrow(TsonParseError);
  });

  it('names the directive and the argument in the message', () => {
    try {
      drain('!!id:"not a uri"\n_');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonParseError);
      const parse = error as TsonParseError;
      expect(parse.message).toContain('!!id');
      expect(parse.message).toContain('not a uri');
      expect(parse.message).toContain('§3.3');
      // The structured half, which Diagnostic carries through unchanged.
      expect(parse.expected).toBe('a URI');
      expect(parse.actual).toBe('not a uri');
    }
  });

  it('accepts a well-formed absolute URI', () => {
    expect(() => drain('!!id:"https://tson.io/x.tn"\n_')).not.toThrow();
  });

  it('accepts a relative reference, which RFC 3986 admits', () => {
    expect(() => drain('!!id:"../sibling.tn"\n_')).not.toThrow();
  });
});
