/**
 * `tson` -- the `@ltr8/tson-cli` entry point. Four commands (`validate`, `compile`, `hash`,
 * `init-example`), three output formats (`text`, `json`, `tson`), and the exit-code contract
 * `exit.ts` documents in full: **0 valid, 1 invalid input, 2 usage error, 70 a library gap or
 * fault** -- the 1-vs-70 split being the one a script depends on, so it is never guessed at:
 * every command's own run function (`commands/*.ts`) already separates "a per-file verdict" from
 * "this run could not reach one", and this module's only job is turning that separation into an
 * exit code and rendered output, never re-deciding it.
 *
 * Argument parsing is hand-rolled, deliberately, matching the reference implementation's own
 * choice for the same reason it states: the flag set is small and fixed enough that a real
 * parsing library buys nothing here, and `@ltr8/tson`'s own "zero runtime dependencies" ethos
 * extends to this sibling package even though nothing forces it to.
 */
import { UsageError, EXIT } from './exit.js';
import { describeError } from './problem.js';
import {
  parseFormat,
  renderCompileRun,
  renderHashRun,
  renderValidateRun,
  type Format,
} from './render.js';
import { runCompile } from './commands/compile.js';
import { runHash } from './commands/hash.js';
import { runInitExample } from './commands/initExample.js';
import { runValidate, type ValidateOptions } from './commands/validate.js';

export { EXIT } from './exit.js';

const USAGE = `tson — TSON (Typed Schema Object Notation) command line

Usage:
  tson validate [--schema <file-or-url> --root <name>] [--format text|json|tson] <file|->...
  tson compile  [--format text|json|tson] <schema>...
  tson hash     [--format text|json|tson] <schema>...
  tson init-example [<dir>]

Commands:
  validate       Validate data documents. With no --schema: base syntax and the built-in
                 type vocabulary only (Class 1). With --schema: also give --root, and
                 every file's root value is read against that schema entry. '-' reads one
                 data document from standard input (at most once).
  compile        Resolve and link each schema document against the bundled standard
                 library (meta-kernel, meta.tn, core.tn) and report whether it compiles.
  hash           Compute each document's canonical content hash ([TSON-DATA] §2.2.1) and,
                 when it declares !!id, the reference pinned with that hash. Read-only --
                 it prints the pinned reference rather than rewriting the file in place.
  init-example   Write an example schema (person.tn) and a matching data document
                 (person-data.tn) into <dir> (default: .), ready to validate.

Options:
  --schema <file-or-url>   schema to validate against (validate only; a local path or an
                           https:// URL -- never a data file's own !!schema directive)
  --root <name>            the schema entry the root value reads against (with --schema)
  --format text|json|tson  output format (default: text)
  --help, -h               print this help

Exit codes:
  0  valid
  1  at least one file invalid
  2  usage error
 70  library gap or internal fault
`;

const VALIDATE_USAGE =
  "usage: tson validate [--schema <file-or-url> --root <name>] [--format text|json|tson] <file|->...   ('-' reads one data document from stdin)";
const COMPILE_USAGE = 'usage: tson compile [--format text|json|tson] <schema>...';
const HASH_USAGE = 'usage: tson hash [--format text|json|tson] <schema>...';
const INIT_USAGE =
  'usage: tson init-example [<dir>]   (writes person.tn and person-data.tn; default dir: .)';

function isHelpFlag(arg: string): boolean {
  return arg === '--help' || arg === '-h';
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

function parseFormatArg(raw: string): Format {
  try {
    return parseFormat(raw);
  } catch (error) {
    throw new UsageError(describeError(error));
  }
}

// ── validate ─────────────────────────────────────────────────────────────────────────────────

function parseValidateArgs(
  args: readonly string[],
): { options: ValidateOptions; format: Format } | 'help' {
  let format: Format = 'text';
  let schemaLocation: string | undefined;
  let root: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (isHelpFlag(arg)) return 'help';
    switch (arg) {
      case '--schema':
        schemaLocation = requireValue(args, ++i, '--schema');
        break;
      case '--root':
        root = requireValue(args, ++i, '--root');
        break;
      case '--format':
        format = parseFormatArg(requireValue(args, ++i, '--format'));
        break;
      default:
        files.push(arg);
    }
  }
  return {
    options: {
      files,
      ...(schemaLocation === undefined ? {} : { schemaLocation }),
      ...(root === undefined ? {} : { root }),
    },
    format,
  };
}

async function runValidateCommand(args: readonly string[]): Promise<number> {
  const parsed = parseValidateArgs(args);
  if (parsed === 'help') {
    process.stdout.write(`${VALIDATE_USAGE}\n`);
    return EXIT.OK;
  }
  const run = await runValidate(parsed.options);
  process.stdout.write(`${renderValidateRun(run, parsed.format)}\n`);
  if (run.notImplemented) {
    process.stderr.write(
      'note: some input could not be checked -- a construct is not implemented yet (see the ' +
        'not_implemented entries above). This is a gap in tson, not a problem with your document.\n',
    );
    return EXIT.FAULT;
  }
  return run.ok ? EXIT.OK : EXIT.INVALID;
}

// ── compile ──────────────────────────────────────────────────────────────────────────────────

function parseFilesAndFormat(
  args: readonly string[],
  usage: string,
): { files: string[]; format: Format } | 'help' {
  let format: Format = 'text';
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (isHelpFlag(arg)) return 'help';
    if (arg === '--format') {
      format = parseFormatArg(requireValue(args, ++i, '--format'));
      continue;
    }
    files.push(arg);
  }
  if (files.length === 0) {
    throw new UsageError(usage);
  }
  return { files, format };
}

async function runCompileCommand(args: readonly string[]): Promise<number> {
  const parsed = parseFilesAndFormat(args, COMPILE_USAGE);
  if (parsed === 'help') {
    process.stdout.write(`${COMPILE_USAGE}\n`);
    return EXIT.OK;
  }
  const run = await runCompile(parsed.files);
  process.stdout.write(`${renderCompileRun(run, parsed.format)}\n`);
  return run.ok ? EXIT.OK : EXIT.INVALID;
}

// ── hash ─────────────────────────────────────────────────────────────────────────────────────

async function runHashCommand(args: readonly string[]): Promise<number> {
  const parsed = parseFilesAndFormat(args, HASH_USAGE);
  if (parsed === 'help') {
    process.stdout.write(`${HASH_USAGE}\n`);
    return EXIT.OK;
  }
  const run = await runHash(parsed.files);
  process.stdout.write(`${renderHashRun(run, parsed.format)}\n`);
  return run.ok ? EXIT.OK : EXIT.INVALID;
}

// ── init-example ─────────────────────────────────────────────────────────────────────────────

async function runInitExampleCommand(args: readonly string[]): Promise<number> {
  if (args.some(isHelpFlag)) {
    process.stdout.write(`${INIT_USAGE}\n`);
    return EXIT.OK;
  }
  if (args.length > 1) {
    throw new UsageError(INIT_USAGE);
  }
  const dir = args[0] ?? '.';
  const result = await runInitExample(dir);
  process.stdout.write(`wrote ${result.schemaFile}\nwrote ${result.dataFile}\n`);
  return EXIT.OK;
}

// ── dispatch ─────────────────────────────────────────────────────────────────────────────────

/** Runs `tson`'s own argv (already stripped of `node`/the script path). Never throws -- every failure this process can report is already an exit code by the time this returns. */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined) {
    process.stderr.write(USAGE);
    return EXIT.USAGE;
  }
  if (isHelpFlag(command) || command === 'help') {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }

  const run: ((args: readonly string[]) => Promise<number>) | undefined = {
    validate: runValidateCommand,
    compile: runCompileCommand,
    hash: runHashCommand,
    'init-example': runInitExampleCommand,
  }[command];

  if (run === undefined) {
    process.stderr.write(`tson: unknown command '${command}'\n\n${USAGE}`);
    return EXIT.USAGE;
  }

  try {
    return await run(rest);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return EXIT.USAGE;
    }
    process.stderr.write(`internal error: ${describeError(error)}\n`);
    process.stderr.write(
      'This is a bug in tson, or an environment problem (an unreadable file, a network failure), ' +
        'not a verdict on your document.\n',
    );
    return EXIT.FAULT;
  }
}

/* node:coverage disable -- process wiring only, exercised by every other test through `main()` directly */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`internal error: ${describeError(error)}\n`);
      process.exitCode = EXIT.FAULT;
    });
}
/* node:coverage enable */
