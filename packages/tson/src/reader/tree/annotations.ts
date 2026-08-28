/**
 * Captures a value's own leading wire annotations (§3.1) as an {@link Annotations} for a tree node.
 *
 * **Structural, not resolved, and that is a consequence of `tree/nodes.ts` being frozen rather than a
 * choice made here.** The Java original's `TsonAnnotation` holds an `Optional<TsonValue>` -- a resolved
 * node, read through whichever compiled reader the governing schema names for the annotation -- but this
 * port's `RecordNode`/`MapNode`/... carry {@link Annotations} from `annotations/index.ts`, whose
 * `Annotation.value` is `DataValue` (`ast/value.ts`'s own structural, uninterpreted AST node), not this
 * package's `Value`. There is nowhere on the frozen node shape to put a resolved value even if one were
 * available. So every tree reader in this directory captures annotations the Class 1 way (§3.1: "preserved,
 * ordered metadata with no further interpretation") regardless of whether a schema governs the read --
 * ported from `AnnotationCapture`'s `AnnotationTypes.UNVALIDATED` path only; the schema-checked path
 * (`AnnotationTypes.of`, resolving `@doc` against the governing meta's own compiled reader) has nothing
 * to build against yet: it needs a whole-schema reader table, which is Wave 5's compiler, not this
 * package. See this package's own work-package report for why this is stated as a deliberate reading of
 * an ambiguity the frozen contract leaves, not a silent gap.
 */
import type { Task } from '../../io/bytes.js';
import { parseDataValue } from '../../compiler/dataParser.js';
import type { Annotations } from '../../annotations/index.js';
import { EMPTY_ANNOTATIONS } from '../../annotations/index.js';
import type { Annotation } from '../../ast/value.js';
import type { ReadContext } from '../contracts.js';

/**
 * Consumes this value's own leading `*annotation` run (§3.1), in source order with repeats preserved.
 * Leaves the cursor positioned at the optional `type-ref`/core-value that follows -- a caller still owes
 * {@link skipTypeRef} (`grammar.ts`) or its own type-ref handling before reading the core-value itself.
 */
export function* captureAnnotations(ctx: ReadContext): Task<Annotations> {
  const first = yield* ctx.peek();
  if (first.kind !== 'annotation-start') {
    return EMPTY_ANNOTATIONS;
  }
  const values: Annotation[] = [];
  for (;;) {
    const start = yield* ctx.peek();
    if (start.kind !== 'annotation-start') break;
    yield* ctx.next();
    const after = yield* ctx.peek();
    if (after.kind === 'annotation-end') {
      yield* ctx.next();
      values.push({ name: start.name });
    } else {
      const value = yield* parseDataValue(ctx, () => {
        // No position tracking wanted for an annotation value read this way.
      });
      const end = yield* ctx.next();
      if (end.kind !== 'annotation-end') {
        throw new Error(`expected the end of annotation '@${start.name}', found '${end.kind}'`);
      }
      values.push({ name: start.name, value });
    }
  }
  return { values };
}
