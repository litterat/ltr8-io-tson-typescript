/**
 * [TSON-JSON] §3.4's in-band route, as far as this processor reads it: a root annotation object led
 * by `$import` -- the list of schemas the document names itself read under, as a TSON text
 * document's `!!import`s do (§3.3) -- is recognised and declined as `NOT_IMPLEMENTED`, the route
 * being one this processor does not read yet. The binding comes out of band: the caller supplies
 * the compiled schema and the root type (`json/facade.ts`'s `ReadJsonOptions`).
 *
 * Declined at the root rather than left to the root's reader, which would refuse the member as it
 * refuses an `$import` at every value position (`SCOPE_NOT_ADMITTED`, `json/schema/tags.ts`): at
 * the top of the document the member stands where §3.3 puts it, so refusing it there would be a
 * verdict that changes once the route is read, which is a gap's mark and not a document's fault.
 */
import type { Task } from '../io/bytes.js';
import { lookingAhead, type JsonReadContext } from './readContext.js';
import { IMPORT } from './schema/tagMembers.js';

/**
 * Whether the root at `ctx`'s cursor leads with `$import`, reporting the gap when it does.
 * Consumes nothing either way: a caller told `true` abandons the read.
 */
export function* declinesInBandBinding(ctx: JsonReadContext): Task<boolean> {
  const first = yield* ctx.peek();
  if (first.kind !== 'object-start') return false;
  const leads = yield* lookingAhead(ctx, function* (ahead): Task<boolean> {
    yield* ahead.next(); // object-start
    const member = yield* ahead.next();
    return member.kind === 'member-name' && member.name === IMPORT;
  });
  if (leads) {
    ctx
      .field(IMPORT)
      .report(
        'NOT_IMPLEMENTED',
        "the document names its own binding with '$import' ([TSON-JSON] §3.4's in-band route), " +
          'which this processor does not read -- supply the schema and root type out of band',
        'a document bound out of band',
        IMPORT,
      );
  }
  return leads;
}
