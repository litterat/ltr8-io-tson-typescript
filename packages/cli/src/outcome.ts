/**
 * Whether a document will be accepted -- the question a sender checking a file against a
 * deployment's schema and policy is asking (the reference implementation's `Outcome`, `tson-cli`'s
 * own `Outcome.java`).
 *
 * **Acceptance, not validity, is the headline.** A document is rejected by an invalidity every
 * processor repeats, and equally by a refusal under this processor's own configuration -- its
 * [TSON-DATA] §8.2 policy, its §9.1 limits, or a schema it does not hold and will not fetch or one
 * past its size limit ([TSON-SCHEMA] §11.2): either way it will not be accepted here, and the
 * sender holds the fix. Which of the two it was -- the portable finding or the local one -- is
 * each diagnostic's own code, where the library's `isVerdict` and `isRefusal` tell them apart.
 * What leaves a document {@link "UNDETERMINED"} is nothing anyone present could judge it by: a
 * schema that could not be obtained, a gap in this library, a type with no binding here
 * ([TSON-DATA] §8.1).
 *
 * **A three-member type rather than a `valid` boolean**, since `if (!valid)` reads "undetermined"
 * as "rejected" -- the assertion a consumer acts on. There is no falsy shortcut past it.
 */
import { isRefusal, isVerdict, type Diagnostic } from '@ltr8/tson';

export type Outcome = 'ACCEPTED' | 'REJECTED' | 'UNDETERMINED';

/**
 * The outcome one file's (or one schema's) own diagnostics denote: nothing reported is
 * {@link "ACCEPTED"}, any invalidity or refusal is {@link "REJECTED"}, and what is left is
 * {@link "UNDETERMINED"}. **One rejection is enough**, beside anything else reported: what went
 * unjudged cannot make a rejected document acceptable, only an unrejected one unknown. Which codes
 * reject is the library's to say, so this keeps no copy of the set.
 */
export function outcomeOfDiagnostics(diagnostics: readonly Diagnostic[]): Outcome {
  if (diagnostics.length === 0) return 'ACCEPTED';
  return diagnostics.some((d) => isVerdict(d.code) || isRefusal(d.code))
    ? 'REJECTED'
    : 'UNDETERMINED';
}

/**
 * The outcome of a whole run, on the same terms (the reference implementation's
 * `Outcome.ofFiles`): any file {@link "REJECTED"} makes the run {@link "REJECTED"}; short of that,
 * every file {@link "ACCEPTED"} makes the run {@link "ACCEPTED"}; anything else is
 * {@link "UNDETERMINED"}.
 */
export function outcomeOfFiles(outcomes: readonly Outcome[]): Outcome {
  if (outcomes.some((outcome) => outcome === 'REJECTED')) return 'REJECTED';
  return outcomes.every((outcome) => outcome === 'ACCEPTED') ? 'ACCEPTED' : 'UNDETERMINED';
}
