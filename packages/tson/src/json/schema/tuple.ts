/**
 * A tuple as a JSON array of exactly its declared length ([TSON-JSON] §6.3, [TSON-SCHEMA] §5.3):
 * each position decodes at its own element reader; an OPTIONAL position's absent value is JSON
 * null in its slot, and at a REQUIRED position null is a validation error (§7). Short or long
 * arrays are validation errors regardless of trailing-optional positions.
 */
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { Task } from '../../io/bytes.js';
import type { TupleBody } from '../../schema/meta/bodies.js';
import type { JsonReadContext } from '../readContext.js';
import { jsonArray, jsonNull, type JsonValue } from '../tree.js';
import { describeEvent, reportUnreadable } from './atoms.js';
import type { CompileContext } from './compile.js';
import { skipNextValue } from './eventSkip.js';
import type { JsonTypeReader } from './types.js';

const ABSENT = Symbol('json.tuple.absent');
const REFUSED = Symbol('json.tuple.refused');
type Slot = JsonValue | typeof ABSENT | typeof REFUSED;

export function buildTupleReader(
  name: string,
  body: TupleBody,
  schemaLocation: SchemaLocation,
  ctx: CompileContext,
): JsonTypeReader<JsonValue> {
  const optional = body.elements.map((element) => element.state === 'OPTIONAL');
  const slotReaders = body.elements.map((element) => ctx.resolve(element.elementType.name));
  const arity = slotReaders.length;

  return {
    *read(readCtx: JsonReadContext): Task<JsonValue | undefined> {
      const outer = readCtx.underDeclaration(schemaLocation);
      const first = yield* outer.next();
      if (first.kind !== 'array-start') {
        yield* reportUnreadable(outer, name, first, () => {
          outer.report(
            'TYPE_MISMATCH',
            `'${name}' is a tuple and takes a JSON array, and this is ${describeEvent(first)}`,
            'an array',
            describeEvent(first),
          );
        });
        return undefined;
      }

      const reportedBefore = outer.reported();
      const positions: Slot[] = [];

      for (;;) {
        const peeked = yield* outer.peek();
        if (peeked.kind === 'array-end') break;
        const position = positions.length;
        const at = outer.index(position);
        if (position >= arity) {
          yield* skipNextValue(at);
          positions.push(REFUSED);
          continue;
        }
        positions.push(yield* readPosition(at, position));
      }
      yield* outer.next(); // array-end

      if (positions.length > arity) {
        outer.report(
          'WRONG_ARITY',
          `'${name}' takes exactly ${String(arity)} elements, and this has ${String(positions.length)}`,
          String(arity),
          String(positions.length),
        );
      } else if (positions.length < arity) {
        outer.report(
          'WRONG_ARITY',
          `'${name}' takes exactly ${String(arity)} elements, and this has ${String(positions.length)}`,
          String(arity),
          String(positions.length),
        );
      }

      if (outer.reported() !== reportedBefore) return undefined;
      return jsonArray(
        positions.map((slot) => (slot === ABSENT ? jsonNull() : (slot as JsonValue))),
      );
    },
  };

  function* readPosition(at: JsonReadContext, position: number): Task<Slot> {
    const peeked = yield* at.peek();
    if (peeked.kind === 'null') {
      yield* at.next();
      if (optional[position] !== true) {
        at.report(
          'FIELD_REQUIRED',
          `position ${String(position)} of '${name}' is required, and null is not a value here`,
          'a value',
          'null',
        );
      }
      return ABSENT;
    }
    const reader = slotReaders[position];
    if (reader === undefined) throw new Error('unreachable: position index out of range');
    const value = yield* reader.read(at);
    return value === undefined ? REFUSED : (value as JsonValue);
  }
}
