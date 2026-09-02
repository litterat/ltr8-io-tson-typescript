import { isVerdict, type Diagnostic, type DiagnosticCode } from '@ltr8/tson';

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
 * **69, 75 and 78 sit between the two, for the same reason and narrower causes.** Each means some
 * diagnostic was not a verdict (`isVerdict`): nothing here judged the document, so this run has no
 * more grounds to call the data invalid than a `NOT_IMPLEMENTED` gap does.
 *
 * A §8.2 name-hygiene refusal is **not** among them. It is exit 1, the same code as any other
 * rejection: §8.2 calls a refusal a "fifth outcome" that must not be reported under one of §8.1's
 * four *categories*, but that rule is about which layer detected the problem, not about what a
 * caller does next -- and what a caller does next is edit the document, here by renaming
 * something. What is genuinely portability-sensitive, that another deployment's policy might
 * accept the same document, is carried by the diagnostic's own code, not by the exit code.
 */
export const EXIT = {
  /** Every input was valid (or, for `compile`/`hash`, every schema was well-formed). */
  OK: 0,
  /** At least one input failed its check -- a real verdict, not a tooling failure. */
  INVALID: 1,
  /** The command line itself was wrong: a bad flag, a missing argument, an unreadable file. */
  USAGE: 2,
  /** A schema permanently unavailable: refused by policy, absent, or over the size cap. Editing the reference or the allow-list is the fix. */
  SCHEMA_UNAVAILABLE: 69,
  /** A schema temporarily unavailable: unreachable, or it did not answer in time. Rerunning may succeed. */
  SCHEMA_TEMPFAIL: 75,
  /** A type the schema needs has no registered binding -- whoever wires the application must act, not the runner. */
  CONFIG: 78,
  /** This run did not reach a verdict -- a library gap or an internal fault, never a statement about the input. */
  FAULT: 70,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Fetch codes no rerun can help: the reference or the allow-list has to change. */
const PERMANENTLY_UNAVAILABLE: ReadonlySet<DiagnosticCode> = new Set([
  'SCHEMA_NOT_PERMITTED',
  'SCHEMA_NOT_FOUND',
  'SCHEMA_TOO_LARGE',
] satisfies DiagnosticCode[]);

/** Fetch codes a rerun might clear on its own. */
const TEMPORARILY_UNAVAILABLE: ReadonlySet<DiagnosticCode> = new Set([
  'SCHEMA_UNREACHABLE',
  'SCHEMA_TIMEOUT',
] satisfies DiagnosticCode[]);

/**
 * Ranks a run's collected diagnostics into the exit code that reports it, for a run whose
 * per-file verdicts alone would otherwise mean {@link EXIT.INVALID}.
 *
 * The ranking is `70 > 78 > 69 > 75 > 1`, and the rule behind it is **who must act first**: until
 * they do, everyone else's fix is wasted. A library gap (70) blocks everyone; a missing binding
 * (78) blocks whoever wires the application; an unobtainable schema blocks the runner. Ties among
 * "nobody present can act" break by permanence -- 70 is more permanent than 78, and 69 than 75.
 *
 * The permanent/transient partition of the five fetch codes is *this consumer's* opinion, not the
 * library's. A different surface could partition the same five by whose doing it was instead,
 * which is why the library ships five codes rather than a permanent/transient pair.
 */
export function exitCodeFor(diagnostics: readonly Diagnostic[]): ExitCode {
  const has = (predicate: (code: DiagnosticCode) => boolean): boolean =>
    diagnostics.some((d) => predicate(d.code));

  if (has((code) => code === 'NOT_IMPLEMENTED')) return EXIT.FAULT;
  if (has((code) => code === 'BIND_MISMATCH')) return EXIT.CONFIG;
  if (has((code) => PERMANENTLY_UNAVAILABLE.has(code))) return EXIT.SCHEMA_UNAVAILABLE;
  if (has((code) => TEMPORARILY_UNAVAILABLE.has(code))) return EXIT.SCHEMA_TEMPFAIL;
  return EXIT.INVALID;
}

/**
 * Whether every diagnostic in `diagnostics` is a verdict on the document -- so a run carrying any
 * of them has genuinely been checked and rejected, rather than not checked at all.
 *
 * Defers to the library's own {@link isVerdict} rather than keeping a second copy of the set here,
 * which is how two consumers come to disagree about one diagnostic.
 */
export function allVerdicts(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.every((d) => isVerdict(d.code));
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
