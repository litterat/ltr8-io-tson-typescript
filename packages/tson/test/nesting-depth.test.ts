import { describe, expect, it } from 'vitest';
import { createTson, parse, readTree, validate } from '../src/index.js';
import {
  DEFAULT_MAX_NESTING_DEPTH as MAX_NESTING_DEPTH,
  maxNestingDepthOf,
} from '../src/core/limits.js';
import { TsonParseError, TsonReadError, TsonSchemaValidationError } from '../src/core/errors.js';
import { compile } from '../src/compiler/compile.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';
import { createDataStream } from '../src/stream/dataStream.js';
import { fromBytes, fromString, runSync, type Task } from '../src/io/bytes.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

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

describe('the limit is configurable (§9.1 asks for a bound, not for this number)', () => {
  it('parse honours a lower limit', () => {
    expect(() => parse(nested(20), { maxNestingDepth: 20 })).not.toThrow();
    expect(() => parse(nested(21), { maxNestingDepth: 20 })).toThrow(TsonParseError);
  });

  it('names the configured limit in the message, not the default', () => {
    try {
      parse(nested(21), { maxNestingDepth: 20 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as TsonParseError).message).toContain('20 levels');
      expect((error as TsonParseError).expected).toBe('at most 20 levels of nesting');
    }
  });

  it.each([
    ['readTree', readTree as (b: Uint8Array, o: { maxNestingDepth: number }) => unknown],
    ['validate', validate as (b: Uint8Array, o: { maxNestingDepth: number }) => unknown],
  ])('%s honours a lower limit', (_name, read) => {
    expect(() => read(nested(20), { maxNestingDepth: 20 })).not.toThrow();
    expect(() => read(nested(21), { maxNestingDepth: 20 })).toThrow(TsonReadError);
  });

  it('honours a higher one, so a document past the default can be read deliberately', () => {
    // Raising is bounded by the host's own call stack, which this tier still costs a frame per
    // level against -- see `core/limits.ts`. 520 is past the default and far below any host's
    // limit, which is the range a raise is actually useful in.
    expect(() => parse(nested(520))).toThrow(TsonParseError);
    expect(() => parse(nested(520), { maxNestingDepth: 600 })).not.toThrow();
    expect(() => readTree(nested(520), { maxNestingDepth: 600 })).not.toThrow();
  });

  it('is stated once on a Tson instance and applies to everything it does', () => {
    const tson = createTson({ maxNestingDepth: 20 });
    expect(() => tson.parse(nested(21))).toThrow(TsonParseError);
    expect(() => tson.readTree(nested(21))).toThrow(TsonReadError);
    expect(() => tson.parse(nested(20))).not.toThrow();
  });

  it('refuses a limit that is not a positive integer, rather than silently taking it', () => {
    // A limit of 0 would refuse every document including an empty one, and a negative or
    // fractional one is a configuration mistake that would otherwise surface as a document being
    // rejected for a reason having nothing to do with the document.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => maxNestingDepthOf({ maxNestingDepth: bad })).toThrow(TsonSchemaValidationError);
    }
    expect(maxNestingDepthOf()).toBe(MAX_NESTING_DEPTH);
    expect(maxNestingDepthOf({})).toBe(MAX_NESTING_DEPTH);
    expect(maxNestingDepthOf({ maxNestingDepth: 1 })).toBe(1);
  });
});

describe('a schema document is bounded too, on every path into it', () => {
  // Worse than the data-side case, because a schema is routinely fetched from somewhere else:
  // each of these used to exhaust the host call stack inside `resolveSchema`/`compile` and escape
  // as an uncaught RangeError.
  const HEADER = '!!id:"test://deep.tn"\n!!meta:"https://tson.io/2026/33/m/meta.tn"\n';

  const VECTORS: readonly (readonly [string, (n: number) => string])[] = [
    [
      'an annotation value',
      (n) => `${HEADER}@x:${'['.repeat(n)}${']'.repeat(n)}\n{ t => { f: text } }\n`,
    ],
    ['a nested array type', (n) => `${HEADER}{ t => ${'['.repeat(n)}text${']'.repeat(n)} }\n`],
    [
      'a nested choice type',
      (n) => `${HEADER}{ t => ${'('.repeat(n)}text|text${')'.repeat(n)} }\n`,
    ],
  ];

  it.each(VECTORS)('%s is refused rather than overflowing the stack', (_name, make) => {
    let thrown: unknown;
    try {
      runSync(parseSchemaDocument(fromString(make(50_000))));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TsonParseError);
    expect((thrown as TsonParseError).message).toContain('nests deeper');
  });

  it.each(VECTORS)('%s honours a configured limit', (_name, make) => {
    expect(() =>
      runSync(parseSchemaDocument(fromString(make(30)), { maxNestingDepth: 20 })),
    ).toThrow(TsonParseError);
  });
});

describe('a recursive schema-governed read is bounded (the compiled reader stack)', () => {
  // The bound the compiled readers had none of: `readNode` in the schemaless reader was guarded,
  // but a `CompiledSchema` recursing through `ctx.field`/`ctx.index` was not, so a self-recursive
  // schema type reading a deep document overflowed the host stack and escaped `readTree`.
  const compiled = compile(
    resolveUserSchema(`!!id:"test://recursive.tn"
!!meta:"https://tson.io/2026/33/m/meta.tn"
!!import:"https://tson.io/2026/33/m/core.tn"
{
  node => { children: [node] }
}
`),
  );

  function tree(depth: number): Uint8Array {
    return new TextEncoder().encode(
      `${'{ children: [ '.repeat(depth)}{ children: [] }${' ] }'.repeat(depth)}`,
    );
  }

  it('reads a document within the limit', () => {
    expect(() => readTree(tree(50), { schema: compiled, root: 'node' })).not.toThrow();
  });

  it('refuses a hostile one without a host error', () => {
    let thrown: unknown;
    try {
      readTree(tree(5000), { schema: compiled, root: 'node' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TsonReadError);
    expect(thrown).not.toBeInstanceOf(RangeError);
  });

  it('honours a configured limit', () => {
    expect(() =>
      readTree(tree(30), { schema: compiled, root: 'node', maxNestingDepth: 20 }),
    ).toThrow(TsonReadError);
  });
});

describe('an annotation chain does not reset the depth counter', () => {
  it('counts an annotation value as nesting, like any other data value', () => {
    // `parseDataValue` used to call `parseAnnotation` without the current depth, so every
    // annotation started the count again -- and a document alternating annotations with arrays
    // walked straight past the bound into the host stack limit.
    const doc = new TextEncoder().encode(`${'@a:['.repeat(20_000)}1${']'.repeat(20_000)}`);
    let thrown: unknown;
    try {
      parse(doc);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(thrown).not.toBeInstanceOf(RangeError);
  });
});
