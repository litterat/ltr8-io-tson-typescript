import { describe, expect, it } from 'vitest';
import { runSync, type Task } from '../src/io/bytes.js';
import { lookingAhead } from '../src/reader/context.js';
import { collectingContextOver } from './reader-tree-helpers.js';
import type { ReadContext } from '../src/reader/contracts.js';

/**
 * A lookahead rewinds by putting everything it consumed back at the front of the queue. Doing
 * that with `unshift(...consumed)` passes one argument per event, so a long enough lookahead —
 * a variant dispatch skipping a large annotation run, which is where this was found — threw a
 * raw `RangeError: Maximum call stack size exceeded` out of a reader whose contract is to report
 * diagnostics, never to throw a host error.
 */
describe('lookingAhead rewinds a long run without a host stack overflow', () => {
  function drainThenRewind(text: string, take: number): { seen: number; first: string } {
    const { ctx } = collectingContextOver(text);
    const seen = runSync(
      lookingAhead(ctx, function* (ahead: ReadContext): Task<number> {
        let n = 0;
        for (let i = 0; i < take; i++) {
          const event = yield* ahead.next();
          n += 1;
          if (event.kind === 'document-end') break;
        }
        return n;
      }),
    );
    // The rewind must have put everything back: the very next read is the document's first event.
    const first = runSync(
      (function* (): Task<string> {
        return (yield* ctx.peek()).kind;
      })(),
    );
    return { seen, first };
  }

  it('rewinds tens of thousands of events', () => {
    const elements = Array.from({ length: 260_000 }, (_, i) => String(i)).join(' ');
    const result = drainThenRewind(`[${elements}]`, 250_000);
    expect(result.seen).toBe(250_000);
    expect(result.first).toBe('array-start');
  });

  it('rewinds a short run just as exactly', () => {
    const result = drainThenRewind('[1 2 3]', 3);
    expect(result.seen).toBe(3);
    expect(result.first).toBe('array-start');
  });
});
