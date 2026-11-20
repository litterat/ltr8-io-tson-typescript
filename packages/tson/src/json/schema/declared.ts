/**
 * A declared position ([TSON-JSON] §8.5, [TSON-SCHEMA] §7.8): the kernel's `meta.declared_type`
 * constructor, whose one instance is `meta.declared`, the open sum over the governing closure.
 * The value names its own type and is read in full against it. Ported from the Java reference's
 * `DispatchDeclaredReader`; it selects a reader and builds nothing.
 *
 * **The value is an annotation object led by `$type`** ({@link lead}): inline when the named type
 * reads the value as a record, wrapper otherwise (§3.3). Any other value -- a bare scalar, an
 * array, an object with no annotation member, one with no `$type` -- names no type, and is a
 * `VALIDATION_ERROR`, the position promising no type for it to be read as: nothing failed to
 * resolve, so the verdict is validation and not resolver. A `$type` naming no type of the closure
 * did fail to resolve and is `UNKNOWN_TYPE`; a leading `$import` is refused as at every value
 * position ({@link refusesScope}).
 *
 * **The closure is fixed at compile time.** The entry belongs to one schema, and every name that
 * schema's namespace holds -- its own declarations and its imports', qualified by path -- routes
 * to that entry's reader, resolved lazily through the compile's own `resolve` so a recursive
 * declaration reads through its finished reader.
 */
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { Task } from '../../io/bytes.js';
import type { JsonReadContext } from '../readContext.js';
import { describeEvent } from './atoms.js';
import type { CompileContext } from './compile.js';
import { skipNextValue } from './eventSkip.js';
import { nameHygieneRefuses } from './nameHygiene.js';
import { isKeyedType, routeTo, type Route } from './route.js';
import { lead as leadOf, TYPE } from './tagMembers.js';
import { refusesScope } from './tags.js';
import type { JsonTypeReader } from './types.js';

const UNTYPED_EXPECTED = "an annotation object naming the value's type";

/** How this position describes itself in the `$import` refusal. */
const WHAT = 'is a declared type, whose values name a type of the governing schema';

/** Builds the reader for one `declared_type` entry, reachable only through `json/schema/compile.ts`'s own `build`. */
export function buildDeclaredReader(
  name: string,
  schemaLocation: SchemaLocation,
  ctx: CompileContext,
): JsonTypeReader {
  const closure = new Map<string, Route>();
  for (const entry of ctx.linkedSchema.entries.keys()) {
    closure.set(
      entry,
      routeTo(() => ctx.resolve(entry), isKeyedType(entry, ctx.linkedSchema)),
    );
  }

  const untyped =
    `'${name}' is a declared type -- the value names its own type, so it must be an ` +
    "annotation object leading with '$type' (§8.5)";

  function* abandon(
    rctx: JsonReadContext,
    code: 'VALIDATION_ERROR' | 'UNKNOWN_TYPE',
    message: string,
    expected: string,
    actual: string,
  ): Task<undefined> {
    rctx.report(code, message, expected, actual);
    yield* skipNextValue(rctx);
    return undefined;
  }

  return {
    *read(readCtx: JsonReadContext): Task<unknown> {
      const rctx = readCtx.underDeclaration(schemaLocation);
      const first = yield* rctx.peek();
      if (first.kind !== 'object-start') {
        return yield* abandon(
          rctx,
          'VALIDATION_ERROR',
          untyped,
          UNTYPED_EXPECTED,
          describeEvent(first),
        );
      }
      const lead = yield* leadOf(rctx);
      if (!(lead.imports || lead.typed || lead.wrapper)) {
        return yield* abandon(
          rctx,
          'VALIDATION_ERROR',
          untyped,
          UNTYPED_EXPECTED,
          'an object naming no type',
        );
      }
      if (yield* refusesScope(rctx, lead, name, WHAT)) return undefined;
      if (lead.type === undefined) {
        return yield* abandon(
          rctx,
          'VALIDATION_ERROR',
          `'${name}' is a declared type -- the value names its own type, so its annotation ` +
            "object requires a '$type' (§8.5)",
          "a '$type' naming the value's own type",
          'no $type',
        );
      }
      const route = closure.get(lead.type);
      if (route === undefined) {
        if (!nameHygieneRefuses(rctx.field(TYPE), lead.type)) {
          rctx.report(
            'UNKNOWN_TYPE',
            `'${lead.type}' is not a type this schema declares or imports, and '${name}' ` +
              "resolves a value's own type name there (§8.5)",
            'a type declared by the governing schema',
            lead.type,
          );
        }
        yield* skipNextValue(rctx);
        return undefined;
      }
      return yield* route.read(rctx, lead);
    },
  };
}
