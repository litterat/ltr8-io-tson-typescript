/**
 * Tree mode's `array` reader -- reads an array-shaped value into an {@link ArrayNode}, one element per
 * source element, in source order. The port of `ArrayAbstractReader`/`ArrayTreeReader`. Distinct from
 * `tuple.ts`'s reader, which reads a fixed-arity, positionally-typed sequence.
 *
 * **The read is all-or-nothing.** An element whose own read reports anything abandons the whole
 * array (`support.ts`'s own `abandonedValue`), not only that element -- the diagnostic carries the
 * story, and building continues past it anyway (so later elements keep the indices the source
 * data gave them, and `uniqueItems` never compares against the fake sentinel a failed read hands
 * back), but the tree this reader ultimately returns for the array is never a partial one. An
 * explicitly-`_` element is the one legitimate {@link AbsentNode} this reader ever produces.
 */
import type { Task } from '../../io/bytes.js';
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { ReadContext, TypeReader } from '../contracts.js';
import type { ArrayBody } from '../../schema/meta/bodies.js';
import type { Value } from '../../tree/nodes.js';
import { absentNode, arrayNode } from '../../tree/nodes.js';
import { captureAnnotations } from './annotations.js';
import {
  describeEvent,
  refuseUnscopedSchemaRef,
  skipAnnotationsAndTypeRef,
  skipCoreValue,
} from './grammar.js';
import { valuesEqual } from './equality.js';
import { abandonedValue, renderValue, type TreeTypeResolver } from './support.js';

/**
 * Builds an `array` tree reader for one compiled schema entry. `resolveType` resolves the element
 * type's own reader once, at construction; `isScopedType` answers §7.8's typed-position question
 * for that same element type, at the same step.
 */
export function arrayTreeReader(
  name: string,
  displayName: string,
  body: ArrayBody,
  resolveType: TreeTypeResolver,
  schemaLocation: SchemaLocation,
  isScopedType: (typeName: string) => boolean,
): TypeReader<Value> {
  const elementParser = resolveType(body.elementType.name);
  const scopedElement = isScopedType(body.elementType.name);

  function validateSize(size: number, ctx: ReadContext): void {
    const count = BigInt(size);
    if (body.minItems !== undefined && count < body.minItems) {
      ctx.report(
        'TYPE_MISMATCH',
        `'${displayName}' has ${String(size)} elements, fewer than the minimum ${body.minItems.toString()}`,
        `at least ${body.minItems.toString()} elements`,
        String(size),
      );
    }
    if (body.maxItems !== undefined && count > body.maxItems) {
      ctx.report(
        'TYPE_MISMATCH',
        `'${displayName}' has ${String(size)} elements, more than the maximum ${body.maxItems.toString()}`,
        `at most ${body.maxItems.toString()} elements`,
        String(size),
      );
    }
  }

  function* expectArrayStart(ctx: ReadContext): Task<boolean> {
    yield* skipAnnotationsAndTypeRef(ctx);
    const e = yield* ctx.peek();
    if (e.kind === 'array-start') {
      yield* ctx.next();
      return true;
    }
    ctx.report(
      'TYPE_MISMATCH',
      `expected an array for '${displayName}', found ${describeEvent(e)}`,
      'an array',
      describeEvent(e),
    );
    yield* skipCoreValue(ctx);
    return false;
  }

  function* readInto(ctx: ReadContext, sink: (decoded: Value) => void): Task<void> {
    const seen: Value[] | undefined = body.uniqueItems ? [] : undefined;
    let index = 0;
    for (;;) {
      const peeked = yield* ctx.peek();
      if (peeked.kind === 'array-end') break;
      const elementCtx = ctx.index(index);
      yield* refuseUnscopedSchemaRef(elementCtx, scopedElement, body.elementType.name);
      const elementPeek = yield* ctx.peek();
      let decoded: Value;
      // Whether this element's own read reported anything -- an abandoned element (ConstructionGuard)
      // is never compared for uniqueness (there is no value to compare, only the fake sentinel
      // `reader/tree/support.ts`'s own `abandonedValue` hands back), the way `record.ts`'s own
      // `verifyFixed` skips its equality check on the same checkpoint. The element is still handed
      // to `sink` so later indices stay accurate; the whole array is abandoned below regardless.
      let elementAbandoned: boolean;
      if (elementPeek.kind === 'absent') {
        yield* ctx.next(); // consume the absent event regardless of voidability
        if (!body.voidable) {
          elementCtx.report(
            'FIELD_REQUIRED',
            `'${displayName}' element [${String(index)}] is absent, but elements are required`,
            'a value',
            '(absent)',
          );
        }
        decoded = absentNode();
        elementAbandoned = false;
      } else {
        const before = ctx.reported();
        decoded = yield* elementParser.read(elementCtx);
        elementAbandoned = ctx.reported() > before;
      }
      if (seen !== undefined && !elementAbandoned) {
        if (seen.some((element) => valuesEqual(element, decoded))) {
          ctx
            .index(index)
            .report(
              'TYPE_MISMATCH',
              `'${displayName}' requires unique elements, '${renderValue(decoded)}' appears more than once`,
              'a value not already present in this array',
              renderValue(decoded),
            );
        } else {
          seen.push(decoded);
        }
      }
      sink(decoded);
      index += 1;
    }
    yield* ctx.next(); // array-end
    validateSize(index, ctx);
  }

  return {
    *read(ctx: ReadContext): Task<Value> {
      const arrayCtx = ctx.underDeclaration(schemaLocation);
      const annotations = yield* captureAnnotations(arrayCtx);
      // The construction-guard checkpoint -- see `record.ts`'s own note on where the mark goes.
      const mark = arrayCtx.reported();
      if (!(yield* expectArrayStart(arrayCtx))) {
        return abandonedValue();
      }
      const elements: Value[] = [];
      yield* readInto(arrayCtx, (decoded) => {
        elements.push(decoded);
      });
      if (arrayCtx.reported() > mark) {
        return abandonedValue();
      }
      return arrayNode(elements, name, annotations);
    },
  };
}
