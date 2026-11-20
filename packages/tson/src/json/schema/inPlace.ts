/**
 * The reader of a type written in place ([TSON-SCHEMA] §4.2): `[text]` at a field, a record body at
 * an element, an application closed where it stands.
 *
 * **It has no name, so no `$type` names it** ([TSON-JSON] §3.3, [TSON-SCHEMA] §7.2): a value at a
 * position it types carries no `$type` and admits none, whatever the tag names -- a declared type of
 * the same shape included, nothing being IS-A a type in place. The text encoding's guard of the same
 * kind (`compiler/compile.ts`) refuses the same tags with the same split: a name resolving nowhere
 * in the namespace fails §7.2's first step (`UNKNOWN_TYPE_REF`) before admission is asked, and a
 * name that resolves is not admitted (`TYPE_MISMATCH`).
 *
 * The refusal is the whole of the annotation object's: a leading `$import`, a leading `$type`, and a
 * wrapper's `$value` each name a type or a scope this position has none of, so the object is read no
 * further. Where a position's body takes no annotation object at all -- a map's members are keys
 * (§3.2), and a choice's `$type` names a variant of the choice, which is a name -- the body is built
 * without this guard.
 */
import type { Task } from '../../io/bytes.js';
import type { Top } from '../../schema/meta/typedef.js';
import type { JsonReadContext } from '../readContext.js';
import { skipNextValue } from './eventSkip.js';
import { nameHygieneRefuses } from './nameHygiene.js';
import { lead as leadOf, leadPresent, TYPE } from './tagMembers.js';
import { PLAIN, refusesScope } from './tags.js';
import type { JsonTypeReader } from './types.js';

/** Whether a value of `body` written in place takes §3.3's annotation object -- a map or a choice does not, on the terms above. */
export function takesInPlaceGuard(body: Top): boolean {
  switch (body.kind) {
    case 'map':
    case 'namespace':
    case 'choice':
    case 'declared_type':
    case 'dependent':
    case 'incomplete':
    case 'extern':
    case 'apply':
    case 'value_entry':
      return false;
    default:
      return true;
  }
}

/** `inner`, the reader of the type written in place whose form is `displayName`, refusing every annotation object at its position. */
export function guardInPlace(
  displayName: string,
  body: Top,
  entries: ReadonlyMap<string, unknown>,
  inner: JsonTypeReader,
): JsonTypeReader {
  const abstractRecord = body.kind === 'record' && body.extension === 'ABSTRACT';
  return {
    *read(ctx: JsonReadContext): Task<unknown> {
      const first = yield* ctx.peek();
      if (first.kind === 'object-start') {
        const found = yield* leadOf(ctx);
        if (leadPresent(found)) {
          // §3.3: `$import` stands at the top of the document alone.
          if (yield* refusesScope(ctx, found, displayName, PLAIN)) return undefined;
          return yield* refuse(ctx, found.type, displayName, entries);
        }
      }
      if (abstractRecord) {
        ctx.report(
          'VALIDATION_ERROR',
          `'${displayName}' is an abstract record written in place: it has no direct instances ` +
            'and no member, so no value is one of it (§4.2, §5.2)',
          'no value',
          'a value',
        );
        yield* skipNextValue(ctx);
        return undefined;
      }
      return yield* inner.read(ctx);
    },
  };
}

function* refuse(
  ctx: JsonReadContext,
  type: string | undefined,
  displayName: string,
  entries: ReadonlyMap<string, unknown>,
): Task<undefined> {
  if (type === undefined) {
    // A bare `$value`, or a `$type` that is no string: no tag names anything here.
    ctx.report(
      'UNKNOWN_TYPE_REF',
      `'${displayName}' is a type written in place, which has no name, so no annotation object ` +
        'stands at its position (§3.3, §4.2)',
      'a value with no annotation members',
      'an annotation object',
    );
  } else if (nameHygieneRefuses(ctx.field(TYPE), type)) {
    // A look-alike name is refused apart from §8.1's four categories, and nothing more is said of it.
  } else if (!entries.has(type)) {
    // §7.2's two steps: a name resolving nowhere in the namespace fails the first, before admission is asked.
    ctx.report(
      'UNKNOWN_TYPE_REF',
      `'$type' names '${type}', which does not resolve in the governing schema's namespace ` +
        '(§7.2) -- a type written in place admits no tag at all',
      'a value with no $type',
      type,
    );
  } else {
    ctx.report(
      'TYPE_MISMATCH',
      `'${displayName}' is a type written in place, which has no name, so no '$type' names it ` +
        `and nothing is IS-A it: '$type' naming '${type}' is refused here (§3.3, §4.2, §7.2)`,
      'a value with no $type',
      type,
    );
  }
  yield* skipNextValue(ctx);
  return undefined;
}
