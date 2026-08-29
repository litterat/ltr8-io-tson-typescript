import type { Diagnostic } from '@ltr8/tson';

/**
 * Process exit codes -- part of this CLI's contract, not an implementation detail. A caller in a
 * shell script or CI pipeline distinguishes "this document is invalid" from "this tool could not
 * answer", and conflating them turns a library gap into a silent validation pass.
 *
 * The 1-vs-70 split is the one that matters most and the one most easily got wrong: **1 means the
 * tool ran and the input was bad; 70 means the tool did not reach a verdict at all** -- a
 * `TsonNotImplementedError`/`TsonInternalError`, a file that could not be read for reasons that
 * have nothing to do with its content, or any error this module did not anticipate. Reporting
 * either of those as 1 tells a script the data was judged and rejected, when in fact nothing was
 * checked.
 *
 * **69 sits between the two, for the same reason and a narrower cause.** A `SCHEMA_UNAVAILABLE`
 * diagnostic means `--schema` named a document no configured source would supply -- nothing here
 * ever read it, so this run has no more grounds to call the data invalid than a `NOT_IMPLEMENTED`
 * gap does. It stays a distinct code rather than folding into 70 because the two causes differ:
 * retrying with the schema now reachable may well succeed, where a library gap will not. 70 still
 * outranks 69 when a run carries both, `NOT_IMPLEMENTED` being the more permanent answer --
 * {@link exitCodeFor} is where that ranking lives.
 */
export const EXIT = {
  /** Every input was valid (or, for `compile`/`hash`, every schema was well-formed). */
  OK: 0,
  /** At least one input failed its check -- a real verdict, not a tooling failure. */
  INVALID: 1,
  /** The command line itself was wrong: a bad flag, a missing argument, an unreadable file. */
  USAGE: 2,
  /** A `--schema` reference no configured source would supply -- not obtained, so never judged. */
  SCHEMA_UNAVAILABLE: 69,
  /** This run did not reach a verdict -- a library gap or an internal fault, never a statement about the input. */
  FAULT: 70,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Ranks a run's collected diagnostics into the exit code that reports it, for a run whose
 * per-file verdicts alone would otherwise mean {@link EXIT.INVALID}. `NOT_IMPLEMENTED` outranks
 * `SCHEMA_UNAVAILABLE` -- both are non-verdicts, but a library gap persists on retry where an
 * unreachable schema might not -- and either outranks a plain invalid verdict, since neither is a
 * statement about the document.
 */
export function exitCodeFor(diagnostics: readonly Diagnostic[]): ExitCode {
  if (diagnostics.some((d) => d.code === 'NOT_IMPLEMENTED')) {
    return EXIT.FAULT;
  }
  if (diagnostics.some((d) => d.code === 'SCHEMA_UNAVAILABLE')) {
    return EXIT.SCHEMA_UNAVAILABLE;
  }
  return EXIT.INVALID;
}

/**
 * A command's own argument parsing failed -- the one thing that maps to {@link EXIT.USAGE}.
 * Kept as a distinct type so a broad `catch` cannot mistake a library exception for a usage
 * mistake: only this CLI's own argument parsing throws the type that means "your command line
 * is wrong", matching the reference implementation's `UsageException` split (`tson-cli`'s own
 * `TsonCli`: "a bare IllegalArgumentException catch would relabel a library fault as your
 * command line is wrong").
 */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}
