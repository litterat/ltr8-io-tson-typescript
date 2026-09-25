/**
 * [TSON-DATA] §8.2's per-name hygiene rules, at every schema-directed position that carries an
 * arriving name this package judges before drawing a verdict on it ([TSON-JSON] §9.4's reach): a
 * record member matching no declared field (§6.1.1), and a `$type` that does not resolve, or
 * resolves to something inadmissible, at a record-family dispatch, a choice, or a no-subtype atom/
 * array/tuple position (§9.4: "every `$type`, and every member name...").
 *
 * **A refusal is not a verdict, and that is the whole reason this exists.** §8.2 requires a
 * name-hygiene refusal to be reported apart from [TSON-DATA] §8.1's four categories — never as one
 * of them — so hygiene is judged *before* the verdict an unmatched name would otherwise draw:
 * `pаssword` (U+0430 CYRILLIC SMALL LETTER A) against a record declaring `password` matches
 * no field, and `UNRECOGNIZED_FIELD` there would be a validation error in exactly the case the
 * rule exists for — advice to add a field already declared, when the fix is one character.
 *
 * **Only the per-name mechanisms apply here, not skeleton distinctness** — this package's own
 * reading, matching the pinned Java reference's `NameHygiene.refuses` (`tson-json/.../reader/
 * NameHygiene.java`): mechanism 1 is a *relation* over a whole scope (every field a record
 * declares, checked once at schema-link time by `link/nameHygiene.ts`), and has nothing further to
 * say about one arriving, unmatched member name compared against nothing. Calling this package's
 * own `unicode/policy.ts#nameHygieneRefusal` with a **single-element** scope achieves exactly that
 * split for free: `firstConfusableCollision` never fires over one name, so only the per-name
 * `identifier-status`/`restriction-level` checks ever run here — no second implementation of
 * either rule, and the reused function's own scope-relation half degrades to a no-op rather than
 * needing to be bypassed.
 */
import { diagnosticCodeForMechanism } from '../../core/diagnostic.js';
import { nameHygieneRefusal } from '../../unicode/policy.js';
import type { JsonReadContext } from '../readContext.js';

/**
 * Judges `name` under `ctx`'s own identifier policy, reporting at most one refusal and answering
 * whether it refused — so a caller reports the refusal *instead of* the verdict it was about to
 * give, never as well as it.
 */
export function nameHygieneRefuses(ctx: JsonReadContext, name: string): boolean {
  const refusal = nameHygieneRefusal([name], ctx.identifierPolicy());
  if (refusal === undefined) return false;
  ctx.report(
    diagnosticCodeForMechanism(refusal.mechanism),
    `the name ${refusal.detail}`,
    'a name this processor will accept',
    `'${name}'`,
  );
  return true;
}
