/**
 * A document's field name judged as the text reader meets it ([TSON-SCHEMA] §5.2, §7.2, §7.7). The
 * rule itself -- the record's name type, the form a name is matched in, and why a name is no value
 * of the type -- is `link/fieldNameRule.ts`'s, shared with the JSON encoding's record reader, and is
 * re-exported here for this reader's own modules. What this module adds is the read-side half that
 * needs a `ReadContext`: reporting a name §8.2 refuses at the field's own pointer.
 */
import type { FieldNameRule } from '../../link/fieldNameRule.js';
import { matchKey } from '../../link/fieldNameRule.js';
import { judgeName, type IdentifierPolicy } from '../../unicode/policy.js';
import type { ReadContext } from '../contracts.js';
import { reportNameViolations } from './refusal.js';

export {
  FIELD_NAME_RULE,
  fieldNameRule,
  matchKey,
  type FieldNameRule,
} from '../../link/fieldNameRule.js';

/**
 * Judges a document's field name `name` under `rule` and `policy`, at `ctx` (the field's own
 * pointer): `undefined` when it is a name this processor accepts, `'refused'` when §8.2 refused it
 * -- reported here, so the caller reports nothing more about it -- or the reason it is no value of
 * the name type, which the caller reports as an unrecognised field if it matches no declared one.
 */
export function judgeFieldName(
  ctx: ReadContext,
  rule: FieldNameRule,
  policy: IdentifierPolicy,
  name: string,
): undefined | 'refused' | { readonly notAName: string } {
  const notAName = rule.refusal(name);
  if (notAName !== undefined) return { notAName };
  const violations = judgeName(matchKey(rule, name), rule.profile, policy);
  if (violations.length === 0) return undefined;
  reportNameViolations(ctx, name, violations);
  return 'refused';
}
