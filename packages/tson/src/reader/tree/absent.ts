/**
 * Tree mode's `void` reader -- reads the absent sentinel, spelled `_` or, equivalently, `null` (§7.3),
 * into an {@link AbsentNode}. The port of `AbsentTreeReader`.
 */
import type { Task } from '../../io/bytes.js';
import type { ReadContext, TypeReader } from '../contracts.js';
import type { Value } from '../../tree/nodes.js';
import { absentNode } from '../../tree/nodes.js';
import { captureAnnotations } from './annotations.js';
import { describeEvent, skipAnnotationsAndTypeRef, skipCoreValue } from './grammar.js';

/** Builds the `void` tree reader -- `displayName` names this position in a shape-mismatch diagnostic. */
export function absentTreeReader(displayName: string): TypeReader<Value> {
  return {
    *read(ctx: ReadContext): Task<Value> {
      const annotations = yield* captureAnnotations(ctx);
      yield* skipAnnotationsAndTypeRef(ctx); // no-op past the annotations already captured above; consumes an optional type-ref
      const e = yield* ctx.peek();
      if (e.kind === 'absent') {
        yield* ctx.next();
      } else {
        ctx.report(
          'TYPE_MISMATCH',
          `expected the absent sentinel '_' for '${displayName}', found ${describeEvent(e)}`,
          "the absent sentinel '_'",
          describeEvent(e),
        );
        yield* skipCoreValue(ctx);
      }
      return absentNode(undefined, annotations);
    },
  };
}
