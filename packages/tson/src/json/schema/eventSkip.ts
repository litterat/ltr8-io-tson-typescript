/**
 * Discards one JSON value whose opening event has already been pulled — what a reader does after
 * reporting a problem it cannot read past (or, for {@link notImplementedReader}'s own use in
 * `json/schema/compile.ts`, a position it cannot read at all), so the surrounding read continues
 * at the next sibling with the event stream still balanced, rather than desynchronising. The port
 * of the Java reference's `EventSkip`.
 *
 * **Iterative over its own depth, not recursive** — this walks values nothing keeps, so it is the
 * one place a document's nesting would cost stack for no result: [TSON-JSON] §10.1's bound has
 * already refused anything deeper than a reader that keeps what it reads would ever see, and a
 * skip that recursed would spend the stack twice over for a value being thrown away.
 */
import type { Task } from '../../io/bytes.js';
import type { JsonReadContext } from '../readContext.js';
import type { JsonEvent } from '../stream.js';

/** Consumes the rest of the value `first` opened; a no-op when `first` was a scalar or `null`. */
export function* skipValue(ctx: JsonReadContext, first: JsonEvent): Task<void> {
  let depth = first.kind === 'object-start' || first.kind === 'array-start' ? 1 : 0;
  while (depth > 0) {
    const event = yield* ctx.next();
    if (event.kind === 'object-start' || event.kind === 'array-start') depth += 1;
    else if (event.kind === 'object-end' || event.kind === 'array-end') depth -= 1;
  }
}

/** Consumes one whole value from `ctx`'s cursor, opening event included. */
export function* skipNextValue(ctx: JsonReadContext): Task<void> {
  yield* skipValue(ctx, yield* ctx.next());
}
