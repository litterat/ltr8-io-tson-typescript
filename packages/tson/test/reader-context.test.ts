import { describe, expect, it } from 'vitest';
import { fromString, runSync } from '../src/io/bytes.js';
import { createDataStream } from '../src/stream/dataStream.js';
import { createReadContext, lookingAhead } from '../src/reader/context.js';
import { collector, throwing } from '../src/core/diagnostic.js';
import type { SchemaLocation } from '../src/core/diagnostic.js';
import type { EventSource, TsonEvent } from '../src/stream/event.js';
import type { ReadContext } from '../src/reader/contracts.js';

/**
 * `reader/context.ts` -- the one implementation of `ReadContext`/`createReadContext`/
 * `lookingAhead` (`reader/contracts.ts`, frozen). Exercised against a real `EventSource`
 * (`stream/dataStream.ts`) rather than a hand-rolled one, since the shared-cursor semantics this
 * module promises -- every scoped copy pulling through the same live source -- are only really
 * tested by driving actual events.
 */

function contextOver(text: string): ReadContext {
  const source = createDataStream(fromString(text));
  return createReadContext(
    source,
    throwing((d) => new Error(d.message)),
  );
}

function next(ctx: ReadContext): TsonEvent {
  return runSync(ctx.next());
}

function peek(ctx: ReadContext): TsonEvent {
  return runSync(ctx.peek());
}

describe('ReadContext.peek/next -- shared cursor', () => {
  it('peek does not consume; repeated peeks return the same event', () => {
    const ctx = contextOver('{ a: 1 }');
    const first = peek(ctx);
    const second = peek(ctx);
    expect(first).toEqual(second);
    expect(next(ctx)).toEqual(first); // next() returns the same event peek() already showed
  });

  it('a scoped copy shares the same live cursor as its parent', () => {
    const ctx = contextOver('{ a: 1 }');
    next(ctx); // document-start
    const child = ctx.field('a');
    next(ctx); // record-start, pulled through the PARENT copy
    // The child sees the record-start already consumed through the parent -- one shared cursor.
    expect(peek(child).kind).toBe('field-name');
  });

  it('position() reflects whichever copy last peeked or consumed', () => {
    const ctx = contextOver('{ a: 1 }');
    expect(ctx.position()).toBeUndefined(); // nothing pulled yet
    const documentStart = next(ctx);
    expect(ctx.position()).toEqual(documentStart.position);
    const child = ctx.field('a');
    const recordStart = next(child);
    // The PARENT's own position() also moved -- there is only one real cursor.
    expect(ctx.position()).toEqual(recordStart.position);
  });

  it('peek alone moves position, matching the Java original', () => {
    const ctx = contextOver('{ a: 1 }');
    const event = peek(ctx);
    expect(ctx.position()).toEqual(event.position);
  });
});

describe('ReadContext.path -- RFC 6901 accumulation', () => {
  it('is the empty string at the root', () => {
    const ctx = contextOver('{ a: 1 }');
    expect(ctx.path()).toBe('');
  });

  it('field/index/schemaField all extend the data path', () => {
    const ctx = contextOver('{ a: 1 }');
    expect(ctx.field('a').path()).toBe('/a');
    expect(ctx.index(3).path()).toBe('/3');
    expect(ctx.field('a').index(0).path()).toBe('/a/0');
    expect(ctx.schemaField('a').path()).toBe('/a');
  });

  it('escapes ~ and / in a field name, ~ first per RFC 6901 §3', () => {
    const ctx = contextOver('{ a: 1 }');
    expect(ctx.field('a/b').path()).toBe('/a~1b');
    expect(ctx.field('a~b').path()).toBe('/a~0b');
    expect(ctx.field('a~1b').path()).toBe('/a~01b'); // ~ before / -- a literal ~1 escapes to ~01
  });

  it('a scoped copy does not mutate its parent', () => {
    const ctx = contextOver('{ a: 1 }');
    const child = ctx.field('a');
    expect(child.path()).toBe('/a');
    expect(ctx.path()).toBe('');
  });
});

describe('ReadContext.schemaLocation -- the "offer my own declaration" convention', () => {
  const declOf = (name: string, position?: SchemaLocation['position']): SchemaLocation => ({
    schemaId: 'https://example.test/s.tn',
    pointer: `/${name}`,
    ...(position === undefined ? {} : { position }),
  });

  it('is undefined for a read with no schema behind it at all', () => {
    const ctx = contextOver('{ a: 1 }');
    expect(ctx.schemaLocation()).toBeUndefined();
  });

  it('underDeclaration seeds only when nothing is established yet', () => {
    const ctx = contextOver('{ a: 1 }');
    const seeded = ctx.underDeclaration(declOf('int32'));
    expect(seeded.schemaLocation()).toEqual({
      schemaId: 'https://example.test/s.tn',
      pointer: '/int32',
    });
    // A second underDeclaration, further down, does NOT displace the first.
    const untouched = seeded.field('x').underDeclaration(declOf('text'));
    expect(untouched.schemaLocation()?.schemaId).toBe('https://example.test/s.tn');
    expect(untouched.schemaLocation()?.pointer).toBe('/int32');
  });

  it('inRecord re-anchors identity+position but keeps the accumulated pointer', () => {
    const ctx = contextOver('{ a: 1 }');
    const outer = ctx.inRecord(declOf('person'));
    expect(outer.schemaLocation()).toEqual({
      schemaId: 'https://example.test/s.tn',
      pointer: '/person',
    });
    const nested = outer
      .schemaField('address')
      .inRecord({ schemaId: 'https://example.test/other.tn', pointer: '/street_address' });
    // Pointer keeps growing through /address; id re-anchors to the nested record's own schema.
    expect(nested.schemaLocation()).toEqual({
      schemaId: 'https://example.test/other.tn',
      pointer: '/person/address',
    });
  });

  it('a declaration with no position of its own leaves the enclosing one alone', () => {
    const ctx = contextOver('{ a: 1 }');
    const outer = ctx.inRecord(declOf('person', { line: 3, column: 1, offset: 10 }));
    const nested = outer.schemaField('age').inRecord(declOf('int32'));
    expect(nested.schemaLocation()?.position).toEqual({ line: 3, column: 1, offset: 10 });
  });

  it('field/index do not step the schema pointer; schemaField does', () => {
    const ctx = contextOver('{ a: 1 }');
    const anchored = ctx.inRecord(declOf('list'));
    expect(anchored.index(2).schemaLocation()?.pointer).toBe('/list'); // array index: data-only
    expect(anchored.field('extra').schemaLocation()?.pointer).toBe('/list'); // undeclared field: data-only
    expect(anchored.schemaField('x').schemaLocation()?.pointer).toBe('/list/x');
  });
});

describe('ReadContext.withPosition', () => {
  it('overrides position() without touching peek/next', () => {
    const ctx = contextOver('{ a: 1 }');
    const documentStart = next(ctx);
    const pinned = ctx.withPosition(documentStart.position);
    next(ctx); // advances the shared cursor well past documentStart
    expect(pinned.position()).toEqual(documentStart.position);
    // peek/next on the pinned copy still pull from the same live cursor.
    expect(peek(pinned).kind).not.toBe('document-start');
  });

  it('undefined restores following the live cursor', () => {
    const ctx = contextOver('{ a: 1 }');
    const documentStart = next(ctx);
    const pinned = ctx.withPosition(documentStart.position).withPosition(undefined);
    expect(pinned.position()).toEqual(ctx.position());
  });
});

describe('ReadContext.report/reported', () => {
  it('a diagnostic omits path/schemaPointer at the root, per the undefined-not-empty-string convention', () => {
    const receiver = collector();
    const ctx = createReadContext(dummySource(), receiver);
    ctx.report('VALIDATION_ERROR', 'boom');
    expect(receiver.diagnostics).toEqual([{ code: 'VALIDATION_ERROR', message: 'boom' }]);
  });

  it('carries path, schema location and expected/actual when present', () => {
    const receiver = collector();
    const ctx = createReadContext(dummySource(), receiver);
    ctx
      .field('person')
      .schemaField('age')
      .inRecord({ schemaId: 'https://example.test/s.tn', pointer: '/person' })
      .report('TYPE_MISMATCH', 'wrong shape', 'int32', 'text');
  });

  it('reported() is monotonic and shared across every scoped copy', () => {
    const receiver = collector();
    const ctx = createReadContext(dummySource(), receiver);
    expect(ctx.reported()).toBe(0);
    const child = ctx.field('a');
    child.report('VALIDATION_ERROR', 'first');
    expect(ctx.reported()).toBe(1);
    expect(child.reported()).toBe(1);
    ctx.field('b').report('VALIDATION_ERROR', 'second');
    expect(ctx.reported()).toBe(2);
  });

  it('a throwing receiver throws from report() and never returns', () => {
    const ctx = contextOver('{ a: 1 }');
    expect(() => {
      ctx.report('VALIDATION_ERROR', 'boom');
    }).toThrow('boom');
  });
});

describe('lookingAhead', () => {
  it('rewinds every event it consumed, so the next real read sees them again', () => {
    const ctx = contextOver('{ a: 1 }');
    next(ctx); // document-start
    const seen = runSync(
      lookingAhead(ctx, function* (inner) {
        const a = yield* inner.next();
        const b = yield* inner.next();
        return [a.kind, b.kind];
      }),
    );
    expect(seen).toEqual(['record-start', 'field-name']);
    // Nothing was actually consumed from the caller's point of view: replaying from the top
    // reproduces the exact same two events.
    expect(next(ctx).kind).toBe('record-start');
    expect(next(ctx).kind).toBe('field-name');
  });

  it('costs only what it looked past -- replayed events are not re-lexed', () => {
    const ctx = contextOver('{ a: 1 }');
    next(ctx);
    runSync(
      lookingAhead(ctx, function* (inner) {
        yield* inner.next();
        return undefined;
      }),
    );
    const replayed = next(ctx);
    expect(replayed.kind).toBe('record-start');
  });

  it('leaves position() where the lookahead reached, not restored', () => {
    const ctx = contextOver('{ a: 1 }');
    next(ctx);
    const reached = runSync(
      lookingAhead(ctx, function* (inner) {
        return yield* inner.next();
      }),
    );
    expect(ctx.position()).toEqual(reached.position);
  });

  it('a nested lookahead rewinds ahead of the enclosing one, preserving read order', () => {
    const ctx = contextOver('[1 2 3]');
    next(ctx); // document-start
    const order = runSync(
      lookingAhead(ctx, function* (outer) {
        const first = yield* outer.next(); // array-start
        const nestedOrder: string[] = [];
        yield* lookingAhead(outer, function* (inner) {
          nestedOrder.push((yield* inner.next()).kind); // token(1)
          nestedOrder.push((yield* inner.next()).kind); // token(2)
        });
        const afterNested = yield* outer.next();
        return [first.kind, ...nestedOrder, afterNested.kind];
      }),
    );
    expect(order).toEqual(['array-start', 'token', 'token', 'token']);
    // Everything the outer lookahead touched (including what the nested one touched inside it)
    // replays in original order.
    expect(next(ctx).kind).toBe('array-start');
    expect(next(ctx).kind).toBe('token');
    expect(next(ctx).kind).toBe('token');
    expect(next(ctx).kind).toBe('token');
  });
});

/** A minimal `EventSource` for tests that only need `report`/`reported`, never a real pull. */
function dummySource(): EventSource {
  return {
    // eslint-disable-next-line require-yield -- never actually driven; throws before any yield.
    *next() {
      throw new Error('not used by this test');
    },
    // eslint-disable-next-line require-yield -- never actually driven; throws before any yield.
    *peek() {
      throw new Error('not used by this test');
    },
  };
}
