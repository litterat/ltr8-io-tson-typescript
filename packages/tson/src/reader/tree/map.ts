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
  skipAnnotationsAndTypeRef,
  skipCoreValue,
  skipScopedValue,
} from './grammar.js';
import { valuesEqual } from './equality.js';
import type { TreeTypeResolver } from './support.js';

type Shape = 'entries' | 'empty' | 'mismatch';

/** A map key's own path segment: its scalar text, or `?` for a key with no single text form. */
function keySegmentFor(e: TsonEvent): string {
  return e.kind === 'token' ? e.text : '?';
}

/** Builds a `map` tree reader for one compiled schema entry. `resolveType` resolves the key and value types' own readers, once, at construction. */
export function mapTreeReader(
  name: string,
  displayName: string,
  body: MapBody,
  resolveType: TreeTypeResolver,
  schemaLocation: SchemaLocation,
): TypeReader<Value> {
  const keyParser = resolveType(body.keyType.name);
  const valueParser = resolveType(body.valueType.name);

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
        }
      }
      yield* ctx.next(); // map-arrow
      const maybeRef = yield* ctx.peek();
      if (maybeRef.kind === 'schema-ref') {
        yield* ctx.next();
      }
      const value = yield* valueParser.read(ctx.field(keySegment));
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
      const shape = yield* expectMapShape(mapCtx);
      if (shape === 'mismatch') {
        return absentNode(undefined, annotations);
      }
      const entries: MapEntry[] = [];
      if (shape === 'entries') {
        yield* readInto(mapCtx, (key, value) => {
          entries.push({ key, value });
        });
      }
      return mapNode(entries, name, annotations);
    },
  };
}
