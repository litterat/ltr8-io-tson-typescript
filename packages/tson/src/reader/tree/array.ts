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
import { declareOrder } from '../../value/orderedness.js';
import { reportConfusablePair } from './refusal.js';
import { abandonedValue, renderValue, type TreeTypeResolver } from './support.js';
import { createConfusableScope } from '../../unicode/skeleton.js';

/**
 * Builds an `array` tree reader for one compiled schema entry. `resolveType` resolves the element
 * type's own reader once, at construction; `isScopedType` answers §7.8's typed-position question
 * for that same element type, at the same step.
 *
 * `elementsAreNames` is true when the array is unique (a set, or any `unique_items` array) and its
 * element type is an identifier family: its elements are then one naming scope (§11.4), and an
 * element reading alike with an earlier one is reported (`CONFUSABLE_NAMES`) at its own index, as
 * §8.2 places a refused pair; a duplicate is the duplicate it is and nothing else. An element that
 * failed to read is no member of either check, there being no value to compare. The caller passes
 * it only where the read's policy applies skeleton distinctness.
 */
export function arrayTreeReader(
  name: string,
  displayName: string,
  body: ArrayBody,
  resolveType: TreeTypeResolver,
  schemaLocation: SchemaLocation,
  isScopedType: (typeName: string) => boolean,
  elementsAreNames = false,
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
    const names = elementsAreNames && seen !== undefined ? createConfusableScope() : undefined;
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
            '_',
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
          if (names !== undefined && decoded.kind === 'atom' && typeof decoded.value === 'string') {
            const collision = names.add(decoded.value);
            if (collision !== undefined) {
              reportConfusablePair(ctx.index(index), collision, 'elements');
            }
          }
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
      return declareOrder(arrayNode(elements, name, annotations), body.ordered);
    },
  };
}
