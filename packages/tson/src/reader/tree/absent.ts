/**
 * Tree mode's `void` reader -- reads the absent sentinel `_`, `void`'s one admitted spelling
 * (§7.3), into an {@link AbsentNode}. The unquoted token `null` is not equivalent: it is an
 * ordinary string with no keyword status ([TSON-DATA] §4.4), so it lands on the mismatch branch
 * below like any other token. The port of `AbsentTreeReader`.
 */
import type { Task } from '../../io/bytes.js';
import type { ReadContext, TypeReader } from '../contracts.js';
import type { Value } from '../../tree/nodes.js';
import { absentNode } from '../../tree/nodes.js';
import { captureAnnotations } from './annotations.js';
import { describeEvent, skipAnnotationsAndTypeRef, skipCoreValue } from './grammar.js';
import { abandonedValue } from './support.js';

/** Builds the `void` tree reader -- `displayName` names this position in a shape-mismatch diagnostic. */
export function absentTreeReader(displayName: string): TypeReader<Value> {
  return {
    *read(ctx: ReadContext): Task<Value> {
      const annotations = yield* captureAnnotations(ctx);
      const mark = ctx.reported();
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
      // Tree mode's construction guard: a shape mismatch reported above means no node, not the
      // absent one a genuinely-written `_` reads to.
      return ctx.reported() > mark ? abandonedValue() : absentNode(undefined, annotations);
    },
  };
}
