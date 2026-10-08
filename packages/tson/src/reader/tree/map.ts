/**
 * Tree mode's `map` reader -- reads a map-shaped value into a {@link MapNode} whose keys are themselves
 * {@link Value}s (TSON map keys can be typed, §2.6). The port of `MapAbstractReader`/`MapTreeReader`.
 *
 * `{}` is a zero-entry map here, size rules included (§2.8: an empty-brace resolves to "the empty
 * container of that type" once a schema supplies one), so `min_items`/`max_items` are checked against it
 * exactly as they are against a stated entry list.
 */
import type { Task } from '../../io/bytes.js';
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { ReadContext, TypeReader } from '../contracts.js';
import type { MapBody } from '../../schema/meta/bodies.js';
import type { TsonEvent } from '../../stream/event.js';
import type { MapEntry, Value } from '../../tree/nodes.js';
import { absentNode, mapNode } from '../../tree/nodes.js';
import { captureAnnotations } from './annotations.js';
import {
  describeEvent,
  refuseUnscopedSchemaRef,
  skipAnnotationsAndTypeRef,
  skipCoreValue,
  skipScopedValue,
} from './grammar.js';
import { valuesEqual } from './equality.js';
import { declareOrder } from '../../value/orderedness.js';
import { reportConfusablePair } from './refusal.js';
import { abandonedValue, type TreeTypeResolver } from './support.js';
import { createConfusableScope } from '../../unicode/skeleton.js';

type Shape = 'entries' | 'empty' | 'mismatch';

/** A map key's own path segment: its scalar text, or `?` for a key with no single text form. */
function keySegmentFor(e: TsonEvent): string {
  return e.kind === 'token' ? e.text : '?';
}

/**
 * Builds a `map` tree reader for one compiled schema entry. `resolveType` resolves the key and
 * value types' own readers, once, at construction; `isScopedType` answers §7.8's typed-position
 * question for the value type at that same step -- a map key is a plain `data-value`, never a
 * `scoped-value` (§2.6), so it never carries a nested `!!schema` for this to guard.
 *
 * `keysAreNames` is true when the key type is an identifier family: its keys are then one naming
 * scope (§11.4), and a key reading alike with an earlier one is reported (`CONFUSABLE_NAMES`) at
 * its own position, as §8.2 places a refused pair, and its entry read normally. A key whose reading
 * reported -- its policy refusal included -- is no name of the scope, for the reason it is not in
 * the duplicate check. The caller passes it only where the read's policy applies skeleton
 * distinctness.
 */
export function mapTreeReader(
  name: string,
  displayName: string,
  body: MapBody,
  resolveType: TreeTypeResolver,
  schemaLocation: SchemaLocation,
  isScopedType: (typeName: string) => boolean,
  keysAreNames = false,
): TypeReader<Value> {
  const keyParser = resolveType(body.keyType.name);
  const valueParser = resolveType(body.valueType.name);
  const scopedValue = isScopedType(body.valueType.name);

  function validateSize(size: number, ctx: ReadContext): void {
    const count = BigInt(size);
    if (body.minItems !== undefined && count < body.minItems) {
      ctx.report(
        'TYPE_MISMATCH',
        `'${displayName}' has ${String(size)} entries, fewer than the minimum ${body.minItems.toString()}`,
        `at least ${body.minItems.toString()} entries`,
        String(size),
      );
    }
    if (body.maxItems !== undefined && count > body.maxItems) {
      ctx.report(
        'TYPE_MISMATCH',
        `'${displayName}' has ${String(size)} entries, more than the maximum ${body.maxItems.toString()}`,
        `at most ${body.maxItems.toString()} entries`,
        String(size),
      );
    }
  }

  function* expectMapShape(ctx: ReadContext): Task<Shape> {
    yield* skipAnnotationsAndTypeRef(ctx);
    const e = yield* ctx.peek();
    if (e.kind === 'map-start') {
      yield* ctx.next();
      return 'entries';
    }
    if (e.kind === 'empty-brace') {
      yield* ctx.next();
      validateSize(0, ctx);
      return 'empty';
    }
    ctx.report(
      'TYPE_MISMATCH',
      `expected a map for '${displayName}', found ${describeEvent(e)}`,
      'a map',
      describeEvent(e),
    );
    yield* skipCoreValue(ctx);
    return 'mismatch';
  }

  function* readInto(ctx: ReadContext, sink: (key: Value, value: Value) => void): Task<void> {
    let count = 0;
    const seenKeys: Value[] = [];
    const names = keysAreNames ? createConfusableScope() : undefined;
    for (;;) {
      const keyPeek = yield* ctx.peek();
      if (keyPeek.kind === 'map-end') break;
      if (keyPeek.kind === 'absent') {
        yield* ctx.next(); // the absent key itself
        ctx.report(
          'TYPE_MISMATCH',
          `'${displayName}': the absent sentinel '_' must not appear as a map key (§2.9)`,
          "a real map key, never the absent sentinel '_'",
          '_',
        );
        yield* ctx.next(); // map-arrow
        yield* skipScopedValue(ctx); // no meaningful key to associate the value with -- discard it
        count += 1;
        continue;
      }
      const keySegment = keySegmentFor(keyPeek);
      const before = ctx.reported();
      const key = yield* keyParser.read(ctx.field(keySegment));
      if (ctx.reported() === before) {
        if (seenKeys.some((seenKey) => valuesEqual(seenKey, key))) {
          ctx
            .field(keySegment)
            .report(
              'DUPLICATE_MAP_KEY',
              `duplicate key '${keySegment}' in '${displayName}' -- a map states each key at most once (§2.6), and the repeat states an entry for nothing`,
              'each key stated once',
              `'${keySegment}' stated again`,
            );
        } else {
          seenKeys.push(key);
          if (names !== undefined && key.kind === 'atom' && typeof key.value === 'string') {
            const collision = names.add(key.value);
            if (collision !== undefined) {
              reportConfusablePair(ctx.field(keySegment), collision, 'keys');
            }
          }
        }
      }
      yield* ctx.next(); // map-arrow
      const valueCtx = ctx.field(keySegment);
      yield* refuseUnscopedSchemaRef(valueCtx, scopedValue, body.valueType.name);
      const valuePeek = yield* ctx.peek();
      let value: Value;
      if (valuePeek.kind === 'absent') {
        // The entry is present with an absent value, so it counts toward the size bounds either
        // way (§5.3); what voidability decides is whether the absence is permitted at all (§7.6).
        yield* ctx.next();
        if (!body.voidable) {
          valueCtx.report(
            'FIELD_REQUIRED',
            `'${displayName}' entry '${keySegment}' is absent, but values are required`,
            'a value',
            '(absent)',
          );
        }
        value = absentNode();
      } else {
        value = yield* valueParser.read(valueCtx);
      }
      sink(key, value);
      count += 1;
    }
    yield* ctx.next(); // map-end
    validateSize(count, ctx);
  }

  return {
    *read(ctx: ReadContext): Task<Value> {
      const mapCtx = ctx.underDeclaration(schemaLocation);
      const annotations = yield* captureAnnotations(mapCtx);
      // The construction-guard checkpoint -- see `record.ts`'s own note on where the mark goes.
      const mark = mapCtx.reported();
      const shape = yield* expectMapShape(mapCtx);
      if (shape === 'mismatch') {
        return abandonedValue();
      }
      const entries: MapEntry[] = [];
      if (shape === 'entries') {
        yield* readInto(mapCtx, (key, value) => {
          entries.push({ key, value });
        });
      }
      if (mapCtx.reported() > mark) {
        return abandonedValue();
      }
      return declareOrder(mapNode(entries, name, annotations), body.ordered);
    },
  };
}
