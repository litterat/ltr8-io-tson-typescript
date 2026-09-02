/**
 * Whether a document was checked, and if it was, what checking found -- the port of the reference
 * implementation's `Outcome` enum (`tson-cli`'s own `Outcome.java`).
 *
 * **The bug a plain `ok: boolean` (plus ad hoc `notImplemented?`/`schemaUnavailable?` side flags)
 * has**: a document whose schema was never fetched, or that hit a construct this library has no
 * reader for, was never actually read. Reporting `ok: false` for it asserts a verdict the run
 * never reached, and `if (!ok)` is exactly what a consumer of this report acts on. A second
 * boolean does not fix this -- `checked: false, valid: true` is representable and meaningless --
 * and neither does an optional boolean, `undefined` being falsy in every language that consumes
 * this wire shape. There is no falsy shortcut past a three-member type.
 */
import { type Diagnostic } from '@ltr8/tson';
import { allVerdicts } from './exit.js';

export type Outcome = 'VALID' | 'INVALID' | 'NOT_CHECKED';

/**
 * The outcome one file's (or one schema's) own diagnostics denote.
 *
 * Mirrors the reference implementation's `Outcome.of`: nothing reported is {@link "VALID"};
 * everything reported being a verdict on the document (`isVerdict`, via `exit.ts`'s own
 * {@link allVerdicts}) is {@link "INVALID"}; **any non-verdict present, even beside real
 * verdicts, makes the whole thing {@link "NOT_CHECKED"}** -- the ordinary problems beside it are
 * still real and still reported, but part of the document went unchecked, so "invalid" is a claim
 * about the whole that this run cannot make.
 */
export function outcomeOfDiagnostics(diagnostics: readonly Diagnostic[]): Outcome {
  if (diagnostics.length === 0) return 'VALID';
  return allVerdicts(diagnostics) ? 'INVALID' : 'NOT_CHECKED';
}

/**
 * The outcome of a whole run: the least settled of its files' own outcomes -- a run is no better
 * than its parts (the reference implementation's `Outcome.ofFiles`). Any file {@link
 * "NOT_CHECKED"} makes the run {@link "NOT_CHECKED"}; short of that, every file {@link "VALID"}
 * makes the run {@link "VALID"}; anything else is {@link "INVALID"}.
 */
export function outcomeOfFiles(outcomes: readonly Outcome[]): Outcome {
  if (outcomes.some((outcome) => outcome === 'NOT_CHECKED')) return 'NOT_CHECKED';
  return outcomes.every((outcome) => outcome === 'VALID') ? 'VALID' : 'INVALID';
}
