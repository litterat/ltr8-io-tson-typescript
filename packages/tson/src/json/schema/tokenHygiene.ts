/**
 * [TSON-DATA] §8.2's "Values" paragraph, reached into this encoding by [TSON-JSON] §9.4: "the
 * token policy, when a deployment sets one, reaches map keys and string values" — this package's
 * own analogue of `reader/schemaless/tree.ts`'s `checkTokenHygiene`, over a JSON event source
 * instead of the TSON text lexer's.
 *
 * **Checked exactly once per token, even under a `peek()`/`lookingAhead` pass that crosses it.**
 * The pinned Java reference rides its own event stream for this reason ("a stream produces each
 * token exactly once where a context rewinds"); this package achieves the same property from the
 * call site instead — `json/schema/atoms.ts`'s `makeAtomReader` and `json/schema/map.ts`'s
 * object-form key loop each call this only once a `JsonReadContext.next()` (never a `peek()`) has
 * actually handed back the string, and a rewound/replayed event (`json/readContext.ts`'s own
 * `lookingAhead`) is never re-checked because nothing calls this a second time over the same
 * logical field. There is no need for a stream-level hook: the two call sites are exactly [TSON-
 * JSON] §9.4's own reach, so a general hook checking every event indiscriminately would also have
 * to check a record's own member names (already the identifier policy's territory, §9.4's own
 * split) and would risk checking a token twice wherever a dispatcher peeks and this package's own
 * reader also consumes it.
 *
 * **Restriction-level only, matching `unicode/policy.ts`'s own {@link TokenPolicy} doc**:
 * {@link tokenHygieneRefusal} can only ever report that one rule, so — unlike
 * {@link import('./nameHygiene.js').nameHygieneRefuses} — there is no mechanism to name.
 */
import { diagnosticCodeForMechanism } from '../../core/diagnostic.js';
import { tokenHygieneRefusal } from '../../unicode/policy.js';
import type { JsonReadContext } from '../readContext.js';

/**
 * Judges `text` under `ctx`'s own token policy, reporting at most one `RESTRICTED_SCRIPT` refusal
 * and answering whether it refused. **Not a verdict on the document** — the same "a refusal is
 * apart from §8.1's four categories" split `nameHygiene.ts`'s own function documents, applied here
 * on the value surface instead of the name surface.
 */
export function tokenHygieneRefuses(ctx: JsonReadContext, text: string): boolean {
  const detail = tokenHygieneRefusal(text, ctx.tokenPolicy());
  if (detail === undefined) return false;
  ctx.report(
    diagnosticCodeForMechanism('restriction-level'),
    `the token '${text}' is refused under [TSON-DATA] §8.2's "Values" token policy: ${detail}`,
    'a token this processor will accept',
    `'${text}'`,
  );
  return true;
}
