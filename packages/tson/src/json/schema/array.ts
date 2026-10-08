/**
 * Arrays and sets as a JSON array ([TSON-JSON] §6.2): elements at the element type's own reader,
 * in order, a voidable-element array (`[T?]`) admitting JSON null at any slot as the void
 * element — the slot exists and counts ([TSON-DATA] §2.9) — and a set's duplicates judged on the
 * element's own value identity ([TSON-SCHEMA] §7.5), never on its spelling. Size facets validate
 * the slot count.
 *
 * A set-typed position shares this exact reader: `schema/meta/bodies.ts`'s own `ArrayBody` backs
 * both `array` and `set` (a refinement of `array`, never a shape of its own), and `ordered`/
 * `uniqueItems` are what tell them apart.
 */
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { Task } from '../../io/bytes.js';
import type { ArrayBody } from '../../schema/meta/bodies.js';
import type { JsonReadContext } from '../readContext.js';
import { jsonArray, jsonNull, type JsonValue } from '../tree.js';
import { describeEvent, reportUnreadable, treeAtomKeyedReader } from './atoms.js';
import type { CompileContext } from './compile.js';
import type { JsonTypeReader } from './types.js';
import { reportConfusablePair } from './nameHygiene.js';
import { declareOrder } from '../../value/orderedness.js';
import { identityOfNode, isIdentified } from './valueIdentity.js';
import { createConfusableScope } from '../../unicode/skeleton.js';
import { terminalDefinition } from '../../link/referenceChain.js';

const ABSENT = Symbol('json.array.absent');
const REFUSED = Symbol('json.array.refused');
type Slot = JsonValue | typeof ABSENT | typeof REFUSED;

export function buildArrayReader(
  name: string,
  body: ArrayBody,
  schemaLocation: SchemaLocation,
  ctx: CompileContext,
): JsonTypeReader<JsonValue> {
  const optionalElements = body.voidable;
  const unique = body.uniqueItems;
  const minItems = body.minItems;
  const maxItems = body.maxItems;
  const elementReader = ctx.resolve(body.elementType.name);
  // A set's atom elements are keyed by their parsed identity, not their spelling -- two
  // instants, or `1`/`1.0`, are one element. A compound element compares by the node its own
  // reader already produced (`identityOfNode`), and needs no wrapping. `ctx.rawAtomReader` hands
  // back the *unwrapped* atom reader (`json/schema/compile.ts`'s own top note on why
  // `ctx.resolve`'s `treeAtomReader`-wrapped reader cannot serve here: it produces a `JsonValue`
  // node, not the decoded host value `identityOfHost` needs to tell `"2026-…+01:00"` from
  // `"2026-…Z"`, or `"1/2"` from `"2/4"`).
  const rawElementReader = unique ? ctx.rawAtomReader(body.elementType.name) : undefined;
  const keyedReader: JsonTypeReader =
    rawElementReader !== undefined ? treeAtomKeyedReader(rawElementReader) : elementReader;
  // A unique array of an identifier family is a naming scope ([TSON-SCHEMA] §11.4): its elements
  // are names ([TSON-DATA] §8.2), and two that read alike are refused at the second.
  const elementsAreNames =
    unique &&
    (() => {
      const element = terminalDefinition(body.elementType.name, (n) =>
        ctx.linkedSchema.entries.get(n),
      )?.body;
      return element !== undefined && 'kind' in element && element.kind === 'identifier_type';
    })();

  return {
    *read(readCtx: JsonReadContext): Task<JsonValue | undefined> {
      const outer = readCtx.underDeclaration(schemaLocation);
      const first = yield* outer.next();
      if (first.kind !== 'array-start') {
        yield* reportUnreadable(outer, first, () => {
          outer.report(
            'TYPE_MISMATCH',
            `'${name}' takes a JSON array, and this is ${describeEvent(first)}`,
            'an array',
            describeEvent(first),
          );
        });
        return undefined;
      }

      const reportedBefore = outer.reported();
      const elements: Slot[] = [];
      const seen = unique ? new Map<string, number>() : undefined;
      const scope =
        elementsAreNames && readCtx.identifierPolicy().skeletonDistinctness
          ? createConfusableScope()
          : undefined;

      for (;;) {
        const peeked = yield* outer.peek();
        if (peeked.kind === 'array-end') break;
        const index = elements.length;
        const at = outer.index(index);
        const peekedAt = yield* at.peek();
        if (peekedAt.kind === 'null') {
          yield* at.next();
          if (!optionalElements) {
            at.report(
              'FIELD_REQUIRED',
              `slot ${String(index)} of '${name}' is required, and null is not a value here`,
              'a value',
              'null',
            );
          }
          elements.push(ABSENT);
          continue;
        }
        const value = yield* keyedReader.read(at);
        if (value === undefined) {
          elements.push(REFUSED);
          continue;
        }
        if (seen !== undefined) {
          const node = isIdentified(value) ? value.node : (value as JsonValue);
          const identity = isIdentified(value) ? value.identity : identityOfNode(node);
          if (seen.has(identity)) {
            at.report(
              'TYPE_MISMATCH',
              `'${name}' is a set and this element repeats one already present`,
              'each element present once',
              describeNode(node),
            );
          } else {
            seen.set(identity, index);
            if (scope !== undefined && isIdentified(value) && typeof value.value === 'string') {
              const collision = scope.add(value.value);
              if (collision !== undefined) reportConfusablePair(at, collision, 'elements');
            }
          }
          elements.push(node);
          continue;
        }
        elements.push(value as JsonValue);
      }
      yield* outer.next(); // array-end

      checkSize(outer, name, elements.length, minItems, maxItems);

      if (outer.reported() !== reportedBefore) return undefined;
      return declareOrder(
        jsonArray(elements.map((slot) => (slot === ABSENT ? jsonNull() : (slot as JsonValue)))),
        body.ordered,
      );
    },
  };
}

function describeNode(node: JsonValue): string {
  return node.kind === 'string' ? node.value : node.kind === 'number' ? node.literal : node.kind;
}

function checkSize(
  ctx: JsonReadContext,
  name: string,
  count: number,
  minItems: bigint | undefined,
  maxItems: bigint | undefined,
): void {
  const size = BigInt(count);
  if (minItems !== undefined && size < minItems) {
    ctx.report(
      'TYPE_MISMATCH',
      `'${name}' takes at least ${minItems.toString()} elements, and this has ${String(count)}`,
      `>= ${minItems.toString()}`,
      String(count),
    );
  }
  if (maxItems !== undefined && size > maxItems) {
    ctx.report(
      'TYPE_MISMATCH',
      `'${name}' takes at most ${maxItems.toString()} elements, and this has ${String(count)}`,
      `<= ${maxItems.toString()}`,
      String(count),
    );
  }
}
