import { TsonNotImplementedError } from '@ltr8/tson';

/**
 * Process exit codes.
 *
 * These are part of the CLI's contract, not an implementation detail: a caller in a shell script
 * distinguishes "this document is invalid" from "this tool could not answer", and conflating them
 * turns a library gap into a silent validation pass.
 */
export const EXIT = {
  /** Every input was valid. */
  OK: 0,
  /** At least one data file was invalid. */
  INVALID: 1,
  /** The command line itself was wrong. */
  USAGE: 2,
  /** A library gap or internal fault — never a statement about the input. */
  FAULT: 70,
} as const;

const USAGE = `tson — TSON (Typed Schema Object Notation) command line

Usage:
  tson validate [--schema <uri>] [--format text|json|tson] <file>...
  tson compile  <schema>...
  tson hash     <schema>...
  tson init-example [dir]

Exit codes:
  0  valid
  1  at least one data file invalid
  2  usage error
 70  library gap or internal fault
`;

/** Map a thrown value to an exit code, keeping a library gap distinct from invalid input. */
export function exitCodeFor(error: unknown): number {
  if (error instanceof TsonNotImplementedError) return EXIT.FAULT;
  return EXIT.FAULT;
}

export function main(argv: readonly string[]): number {
  const [command] = argv;

  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return command === undefined ? EXIT.USAGE : EXIT.OK;
  }

  switch (command) {
    case 'validate':
    case 'compile':
    case 'hash':
    case 'init-example':
      try {
        throw new TsonNotImplementedError(`\`tson ${command}\` is not implemented yet`);
      } catch (error) {
        process.stderr.write(`${String(error)}\n`);
        return exitCodeFor(error);
      }
    default:
      process.stderr.write(`tson: unknown command '${command}'\n\n${USAGE}`);
      return EXIT.USAGE;
  }
}

process.exitCode = main(process.argv.slice(2));
