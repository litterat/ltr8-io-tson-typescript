import { describe, expect, it } from 'vitest';
import { parse, readTree, validate } from '../src/index.js';
import { MAX_NESTING_DEPTH } from '../src/compiler/dataParser.js';
import { TsonParseError, TsonReadError } from '../src/core/errors.js';
import { createDataStream } from '../src/stream/dataStream.js';
import { fromBytes, runSync, type Task } from '../src/io/bytes.js';

/**
 * §9.1 names deeply nested structures a denial-of-service vector and asks an implementation to
 * bound them. Unbounded, the bound still existed — it was the host's call stack, reached at around
 * 750 levels for `parse` and 1,600 for `readTree`, and reported as an uncaught
 * `RangeError: Maximum call stack size exceeded` escaping a public API whose contract is a typed
 * error with a position.
 *
 * The existing regression test for CLAUDE.md's "memory proportional to nesting depth" claim drove
 * `createDataStream` directly — Tier 2, which really is iterative and really does walk a million
 * levels. It therefore passed while every function a caller can actually reach crashed. These
 * tests drive the public entry points.
 */
function nested(depth: number): Uint8Array {
  return new TextEncoder().encode('['.repeat(depth) + ']'.repeat(depth));
}

describe('the public read entry points bound nesting depth (§9.1)', () => {
  it('accepts a document at the limit', () => {
    expect(() => parse(nested(MAX_NESTING_DEPTH))).not.toThrow();
    expect(() => readTree(nested(MAX_NESTING_DEPTH))).not.toThrow();
  });

  it('parse refuses one level past it, with a position', () => {
    try {
      parse(nested(MAX_NESTING_DEPTH + 1));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonParseError);
      expect((error as TsonParseError).message).toContain('nests deeper');
      expect((error as TsonParseError).position.line).toBe(1);
    }
  });

  it.each([
    ['readTree', readTree],
    ['validate', validate],
  ])('%s refuses one level past it', (_name, read) => {
    expect(() => read(nested(MAX_NESTING_DEPTH + 1))).toThrow(TsonReadError);
  });

  it.each([
    ['parse', parse as (b: Uint8Array) => unknown],
    ['readTree', readTree as (b: Uint8Array) => unknown],
    ['validate', validate as (b: Uint8Array) => unknown],
  ])('%s survives a hostile depth without a host error', (_name, read) => {
    // 100,000 levels is 200 KB of input. Before the bound this was a RangeError out of the
    // public API; the recovery path was recursive too, so `validate` overflowed even once the
    // guard existed.
    let thrown: unknown;
    try {
      read(nested(100_000));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(thrown).not.toBeInstanceOf(RangeError);
  });

  it('leaves the Tier 2 event stream unbounded, which is where the guarantee really holds', () => {
    // The frame stack in stream/dataStream.ts is why this tier costs no host frames per level.
    // Pinned so a future change cannot quietly make it recursive too.
    const events = createDataStream(fromBytes(nested(50_000)));
    const counted = runSync(
      (function* (): Task<number> {
        let n = 0;
        for (;;) {
          const event = yield* events.next();
          n += 1;
          if (event.kind === 'document-end') return n;
        }
      })(),
    );
    expect(counted).toBeGreaterThan(100_000);
  });
});
