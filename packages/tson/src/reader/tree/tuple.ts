/**
 * Tree mode's `tuple` reader -- reads a fixed-arity, positionally-typed sequence into a
 * {@link TupleNode}, structurally like `array.ts`'s reader (array-shaped on the wire) but a distinct
 * kind, produced only by a schema-driven read. The port of `TupleAbstractReader`/`TupleTreeReader`.
 *
 * Arity is fixed and exact, unlike an array's `min_items`/`max_items` range, but a stream has no
 * up-front element count, so arity is checked incrementally: an element arriving past the declared
 * position count reports `WRONG_ARITY` once (every further extra element is still decoded and
 * discarded, keeping the cursor correctly positioned for `array-end`), and `array-end` arriving before
 * every position got a value reports `WRONG_ARITY` too. A slot that is absent (the sentinel `_` at an
 * OPTIONAL position) or never reached at all is kept as an {@link AbsentNode} placeholder.
 */
import type { Task } from '../../io/bytes.js';
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { ReadContext, TypeReader } from '../contracts.js';
import type { TupleBody, TupleElement } from '../../schema/meta/bodies.js';
import type { Value } from '../../tree/nodes.js';
import { absentNode, tupleNode } from '../../tree/nodes.js';
import { captureAnnotations } from './annotations.js';
import {
  describeEvent,
  skipAnnotationsAndTypeRef,
  skipCoreValue,
  skipDataValue,
} from './grammar.js';
import type { TreeTypeResolver } from './support.js';

interface CompiledSlot {
  readonly schema: TupleElement;
  readonly parser: TypeReader<Value>;
}

/** Builds a `tuple` tree reader for one compiled schema entry. `resolveType` resolves every position's own reader once, at construction. */
export function tupleTreeReader(
  name: string,
  displayName: string,
  body: TupleBody,
  resolveType: TreeTypeResolver,
  schemaLocation: SchemaLocation,
): TypeReader<Value> {
  const slots: readonly CompiledSlot[] = body.elements.map((schema) => ({
    schema,
    parser: resolveType(schema.elementType.name),
  }));

  function* expectTupleStart(ctx: ReadContext): Task<boolean> {
    yield* skipAnnotationsAndTypeRef(ctx);
    const e = yield* ctx.peek();
    if (e.kind === 'array-start') {
      yield* ctx.next();
      return true;
    }
    ctx.report(
      'TYPE_MISMATCH',
      `expected a tuple (array-shaped) for '${displayName}', found ${describeEvent(e)}`,
      'a tuple (array-shaped)',
      describeEvent(e),
    );
    yield* skipCoreValue(ctx);
    return false;
  }

  /** Decodes every position up to `array-end` into a fixed-size array; a position never reached stays `undefined`. */
  function* decode(ctx: ReadContext): Task<(Value | undefined)[]> {
    const result: (Value | undefined)[] = new Array(slots.length).fill(undefined) as (
      Value | undefined
    )[];
    let index = 0;
    let reportedExtra = false;
    for (;;) {
      const peeked = yield* ctx.peek();
      if (peeked.kind === 'array-end') break;
      if (peeked.kind === 'schema-ref') {
        yield* ctx.next();
      }
      if (index >= slots.length) {
        if (!reportedExtra) {
          ctx.report(
            'WRONG_ARITY',
            `'${displayName}' has ${String(slots.length)} positions, found more than ${String(slots.length)} elements`,
            `${String(slots.length)} elements`,
            `more than ${String(slots.length)}`,
          );
          reportedExtra = true;
        }
        yield* skipDataValue(ctx);
        index += 1;
        continue;
      }
      const slot = slots[index];
      if (slot === undefined) {
        throw new Error(
          `internal error: no compiled slot at index ${String(index)} on '${displayName}'`,
        );
      }
      const elementPeek = yield* ctx.peek();
      if (elementPeek.kind === 'absent') {
        yield* ctx.next(); // consume the absent event regardless of REQUIRED/OPTIONAL
        if (slot.schema.state === 'REQUIRED') {
          ctx
            .index(index)
            .report(
              'FIELD_REQUIRED',
              `'${displayName}' position [${String(index)}] is absent, but this position is required`,
              'a value',
              '(absent)',
            );
        }
      } else {
        result[index] = yield* slot.parser.read(ctx.index(index));
      }
      index += 1;
    }
    yield* ctx.next(); // array-end
    if (index < slots.length) {
      ctx.report(
        'WRONG_ARITY',
        `'${displayName}' has ${String(slots.length)} positions, found only ${String(index)} elements`,
        `${String(slots.length)} elements`,
        String(index),
      );
    }
    return result;
  }

  return {
    *read(ctx: ReadContext): Task<Value> {
      const tupleCtx = ctx.underDeclaration(schemaLocation);
      const annotations = yield* captureAnnotations(tupleCtx);
      if (!(yield* expectTupleStart(tupleCtx))) {
        return absentNode(undefined, annotations);
      }
      const decoded = yield* decode(tupleCtx);
      const elements = decoded.map((value) => value ?? absentNode());
      return tupleNode(elements, name, annotations);
    },
  };
}
