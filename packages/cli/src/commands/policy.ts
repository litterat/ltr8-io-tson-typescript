/**
 * `tson policy [<policy options>]` -- prints the [TSON-DATA] §8.2 policy this run would apply,
 * with no document in hand.
 *
 * **This is the surface that makes a refusal avoidable rather than merely explicable.** §8.2's
 * three name-hygiene rules read data the Unicode Consortium does not freeze, at a level this
 * deployment chose, so a name one processor accepts another refuses. A sender that can read the
 * policy before it writes never writes the name that would be refused; the same record rides on
 * every `validate`/`compile` run (`render.ts`), so a report and this command state one fact one
 * way.
 *
 * Takes the same policy flags `validate` and `compile` do, so it doubles as their dry run:
 * `tson policy --identifier-policy ascii-only` prints exactly what a `validate` under that flag
 * would apply. Always succeeds -- see `policyOptions.ts`'s own {@link processorPolicyOf}.
 */
import { processorPolicyOf, type PolicyOptions, type ProcessorPolicy } from '../policyOptions.js';

export function runPolicy(options: PolicyOptions): ProcessorPolicy {
  return processorPolicyOf(options);
}
