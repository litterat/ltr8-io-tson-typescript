import { describe, expect, it } from 'vitest';
import { collector, throwing, type Diagnostic } from '../src/core/diagnostic.js';
import { TsonReadError } from '../src/core/errors.js';
import { START, formatPosition, position } from '../src/core/position.js';

const problem: Diagnostic = { code: 'FIELD_REQUIRED', message: 'field "name" is required' };

describe('diagnostics receivers', () => {
  it('a collector accumulates in report order and lets the read continue', () => {
    const sink = collector();
    sink.report(problem);
    sink.report({ code: 'TYPE_MISMATCH', message: 'expected integer' });
    expect(sink.diagnostics.map((d) => d.code)).toEqual(['FIELD_REQUIRED', 'TYPE_MISMATCH']);
  });

  it('a throwing receiver fails on the first problem', () => {
    const sink = throwing((d) => new TsonReadError(d));
    expect(() => {
      sink.report(problem);
    }).toThrow(TsonReadError);
  });

  it('carries the whole diagnostic through, not just its message', () => {
    // A caller catching a read failure needs the code and the path to act on it. Flattening the
    // diagnostic into a string loses exactly the part that is machine-readable.
    const sink = throwing((d) => new TsonReadError(d));
    const located: Diagnostic = {
      code: 'TYPE_MISMATCH',
      message: 'expected integer',
      path: '/items/2/qty',
      dataPosition: position(4, 11, 62),
    };
    try {
      sink.report(located);
      expect.unreachable('the receiver should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonReadError);
      const read = error as TsonReadError;
      expect(read.diagnostic).toBe(located);
      expect(read.diagnostic.code).toBe('TYPE_MISMATCH');
      expect(read.diagnostic.path).toBe('/items/2/qty');
      expect(read.message).toBe('expected integer');
      // toString appends where, so a stack trace locates it without the catcher doing the work.
      expect(read.toString()).toContain(formatPosition(position(4, 11, 62)));
    }
  });

  it('omits the position when the diagnostic does not locate one', () => {
    const read = new TsonReadError(problem);
    expect(read.toString()).toBe('TsonReadError: field "name" is required');
  });

  it('the two are the same read with different policies, which is why validate() reuses it', () => {
    const runs = (sink: { report: (d: Diagnostic) => void }): void => {
      sink.report(problem);
    };
    const sink = collector();
    runs(sink);
    expect(sink.diagnostics).toHaveLength(1);
    expect(() => {
      runs(throwing((d) => new TsonReadError(d)));
    }).toThrow(TsonReadError);
  });
});

describe('Position', () => {
  it('starts at line 1, column 1, byte offset 0 (§8.1)', () => {
    expect(START).toEqual({ line: 1, column: 1, offset: 0 });
  });

  it('renders as line:column', () => {
    expect(formatPosition(position(3, 17, 42))).toBe('3:17');
  });
});
