/**
 * Event-stream grammar helpers every tree reader in this directory needs, beyond whatever its own
 * shape-specific decoding does -- consuming a `data-value`'s leading `annotation* type-ref?` framing
 * (§2.3-§2.4) before a reader inspects its own core-value's shape, and discarding a whole
 * `data-value`/`scoped-value`/`core-value`'s worth of events outright when a reader has nothing to do
 * with one (the wrong shape entirely, or a record field name with no match in the compiled schema).
 *
 * Ported from `tson-compiler/.../reader/EventSkip.java`, minus the `aheadOfValue`/`typeRefAhead`
 * lookahead pair -- schema-driven dispatch (choosing a variant, choosing a root type) is Wave 5's
 * compiler, not this package. `{@link skipAnnotationsAndTypeRef}`'s own type-ref is likewise discarded
 * here: a tree node's `typeRef` is the compiled reader's own declared name (see `record.ts`'s own
 * note), never the wire token, so no caller in this directory needs the name back.
 */
import type { Task } from '../../io/bytes.js';
import type { TsonEvent } from '../../stream/event.js';
import type { ReadContext } from '../contracts.js';

/** Consumes and discards every leading annotation (`AnnotationStart`/`AnnotationEnd` pairs), stopping at whatever follows. */
export function* skipAnnotations(ctx: ReadContext): Task<void> {
  for (;;) {
    const e = yield* ctx.peek();
    if (e.kind !== 'annotation-start') return;
    yield* ctx.next();
    const after = yield* ctx.peek();
    if (after.kind !== 'annotation-end') {
      yield* skipDataValue(ctx); // the annotation's own value -- discarded along with the annotation
    }
    yield* ctx.next(); // annotation-end
  }
}

/** Consumes an optional `type-ref`, discarding it. The second half of a data-value's `annotation* type-ref?` framing. */
export function* skipTypeRef(ctx: ReadContext): Task<void> {
  const e = yield* ctx.peek();
  if (e.kind === 'type-ref') {
    yield* ctx.next();
  }
}

/** {@link skipAnnotations} then {@link skipTypeRef} -- every reader in this directory calls this first, before deciding its own shape. */
export function* skipAnnotationsAndTypeRef(ctx: ReadContext): Task<void> {
  yield* skipAnnotations(ctx);
  yield* skipTypeRef(ctx);
}

/** Discards one full `data-value`: leading annotations/type-ref, then one core-value. */
export function* skipDataValue(ctx: ReadContext): Task<void> {
  yield* skipAnnotationsAndTypeRef(ctx);
  yield* skipCoreValue(ctx);
}

/** Discards `[ schema-directive ] data-value` -- a record field value, a map entry value, an array element. */
export function* skipScopedValue(ctx: ReadContext): Task<void> {
  const e = yield* ctx.peek();
  if (e.kind === 'schema-ref') {
    yield* ctx.next();
  }
  yield* skipDataValue(ctx);
}

/**
 * Discards one core-value whose own first event has *not* yet been consumed (only peeked) by the
 * caller -- the natural shape for a reader that peeked to decide "this isn't what I expected" and now
 * needs to fully discard whatever's actually there, nested containers included.
 */
export function* skipCoreValue(ctx: ReadContext): Task<void> {
  const e = yield* ctx.next();
  switch (e.kind) {
    case 'record-start': {
      for (;;) {
        const peeked = yield* ctx.peek();
        if (peeked.kind === 'record-end') break;
        yield* ctx.next(); // field-name
        yield* skipScopedValue(ctx);
      }
      yield* ctx.next(); // record-end
      return;
    }
    case 'map-start': {
      for (;;) {
        const peeked = yield* ctx.peek();
        if (peeked.kind === 'map-end') break;
        yield* skipDataValue(ctx); // key
        yield* ctx.next(); // map-arrow
        yield* skipScopedValue(ctx);
      }
      yield* ctx.next(); // map-end
      return;
    }
    case 'array-start': {
      for (;;) {
        const peeked = yield* ctx.peek();
        if (peeked.kind === 'array-end') break;
        yield* skipScopedValue(ctx);
      }
      yield* ctx.next(); // array-end
      return;
    }
    case 'token':
    case 'absent':
    case 'empty-brace':
      // leaf, already consumed
      return;
    default:
      throw new Error(`unexpected event while skipping a core-value: ${e.kind}`);
  }
}

/** A core-value's shape as a word, for a diagnostic's `actual` -- ported from `TypeRefCheck.describe`. */
export function describeEvent(e: TsonEvent): string {
  switch (e.kind) {
    case 'record-start':
      return 'a record';
    case 'map-start':
      return 'a map';
    case 'array-start':
      return 'an array';
    case 'empty-brace':
      return '{}';
    case 'absent':
      return "the absent sentinel '_'";
    case 'token':
      return `token '${e.text}'`;
    default:
      return e.kind;
  }
}
