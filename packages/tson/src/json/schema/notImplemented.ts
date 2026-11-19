import type { Task } from '../../io/bytes.js';
import type { JsonReadContext } from '../readContext.js';
import { skipNextValue } from './eventSkip.js';
import type { JsonTypeReader } from './types.js';

/**
 * A reader reporting `NOT_IMPLEMENTED` for a position this package cannot read yet -- see this
 * module's own top note for exactly which ones. **Still consumes the whole value it
 * cannot read** ({@link skipNextValue}): a gap must leave the event stream exactly where a reader
 * that understood this position would have left it, or the sibling field/element read next would
 * desynchronise against events this reader never pulled.
 */
export function notImplementedReader(displayName: string, reason: string): JsonTypeReader {
  return {
    *read(ctx: JsonReadContext): Task<undefined> {
      ctx.report(
        'NOT_IMPLEMENTED',
        `'${displayName}' is ${reason}, which this package does not read yet`,
      );
      yield* skipNextValue(ctx);
      return undefined;
    },
  };
}
