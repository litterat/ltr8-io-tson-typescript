/**
 * A leading `$import` at a value position -- the document's binding, which stands at the top of
 * the document alone ([TSON-JSON] §3.3, §3.4) -- refused identically wherever the leading members
 * are read. Ported from the Java reference's `Tags`.
 *
 * Shared because the answer is the same at every position: a concrete record, every dispatcher
 * over a record family, a choice, an atom, array or tuple position and a declared position all
 * refuse it on the same terms, and a copy per reader would be a chance per reader to disagree.
 */
import type { Task } from '../../io/bytes.js';
import type { JsonReadContext } from '../readContext.js';
import { skipNextValue } from './eventSkip.js';
import { IMPORT, type Lead } from './tagMembers.js';

/** How a record position describes itself in the `$import` refusal. */
export const RECORD = 'is a record';

/** How a choice position describes itself in the `$import` refusal. */
export const CHOICE = 'is a choice, whose variants its own schema declares';

/** How an atom, array or tuple position describes itself in the `$import` refusal. */
export const PLAIN = 'is not a record position';

/**
 * Reports an `$import` in the object at `ctx`, consuming nothing: a resolver error at every value
 * position (§3.3), `SCOPE_NOT_ADMITTED` -- the document's binding written where no binding stands,
 * as an `!!import` at a value position is a parse error in text.
 */
export function refuseScope(ctx: JsonReadContext, displayName: string, what: string): void {
  ctx
    .field(IMPORT)
    .report(
      'SCOPE_NOT_ADMITTED',
      `'$import' binds the document to the schemas it names, which it does at the top of the ` +
        `document alone (§3.3) -- '${displayName}' ${what}`,
      'no $import at this position',
      IMPORT,
    );
}

/**
 * Whether `lead` carries an `$import`, reporting the refusal and consuming the value when it does
 * -- so a caller told `true` is done with the object and returns its own refusal result.
 */
export function* refusesScope(
  ctx: JsonReadContext,
  lead: Lead,
  displayName: string,
  what: string,
): Task<boolean> {
  if (!lead.imports) return false;
  refuseScope(ctx, displayName, what);
  yield* skipNextValue(ctx);
  return true;
}
