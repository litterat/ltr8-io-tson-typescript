/**
 * Tree mode's `array` reader -- reads an array-shaped value into an {@link ArrayNode}, one element per
 * source element, in source order. The port of `ArrayAbstractReader`/`ArrayTreeReader`. Distinct from
 * `tuple.ts`'s reader, which reads a fixed-arity, positionally-typed sequence.
 *
 * A failed or explicitly-`_` element is kept as an {@link AbsentNode} placeholder -- its own diagnostic
 * (if any) carries the story, not the node standing in for it -- so later elements' own indices stay
 * accurate against the original data.
 */
import type { Task } from '../../io/bytes.js';
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { ReadContext, TypeReader } from '../contracts.js';
import type { ArrayBody } from '../../schema/meta/bodies.js';
import type { Value } from '../../tree/nodes.js';
import { absentNode, arrayNode } from '../../tree/nodes.js';
import { captureAnnotations } from './annotations.js';
import { describeEvent, skipAnnotationsAndTypeRef, skipCoreValue } from './grammar.js';
import { valuesEqual } from './equality.js';
import { renderValue, type TreeTypeResolver } from './support.js';

/** Builds an `array` tree reader for one compiled schema entry. `resolveType` resolves the element type's own reader once, at construction. */
export function arrayTreeReader(
  name: string,
  displayName: string,
  body: ArrayBody,
  resolveType: TreeTypeResolver,
  schemaLocation: SchemaLocation,
): TypeReader<Value> {
  const elementParser = resolveType(body.elementType.name);

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
      if (peeked.kind === 'schema-ref') {
        yield* ctx.next();
      }
      const elementPeek = yield* ctx.peek();
      let decoded: Value;
      if (elementPeek.kind === 'absent') {
        yield* ctx.next(); // consume the absent event regardless of REQUIRED/OPTIONAL
        if (body.state === 'REQUIRED') {
          ctx
            .index(index)
            .report(
              'FIELD_REQUIRED',
              `'${displayName}' element [${String(index)}] is absent, but elements are required`,
              'a value',
              '(absent)',
            );
        }
        decoded = absentNode();
      } else {
        decoded = yield* elementParser.read(ctx.index(index));
      }
      if (seen !== undefined) {
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
      if (!(yield* expectArrayStart(arrayCtx))) {
        return absentNode(undefined, annotations);
      }
      const elements: Value[] = [];
      yield* readInto(arrayCtx, (decoded) => {
        elements.push(decoded);
      });
      return arrayNode(elements, name, annotations);
    },
  };
}
