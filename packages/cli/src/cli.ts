/**
 * `tson` -- the `@ltr8/tson-cli` entry point. Five commands (`validate`, `compile`, `policy`,
 * `hash`, `init-example`), three output formats (`text`, `json`, `tson`), and the exit-code
 * contract `exit.ts` documents in full: **0 checked and nothing to report, 1 checked and
 * rejected, 2 usage error, 69/75 a schema not obtained (permanently/temporarily), 78 a type with
 * no registered binding, 70 a library gap or an internal fault** -- the 1-vs-70 split being the
 * one a script depends on most, so it is never guessed at: every command's own run function
 * (`commands/*.ts`) already separates "a per-file verdict" (`outcome.ts`) from "this run could
 * not reach one", and `exit.ts`'s own `exitCodeFor` is where a run's collected diagnostics are
 * ranked into whichever non-OK code applies -- this module's only job is calling that and
 * rendering the result, never re-deciding it.
 *
 * **Help is two levels.** `tson --help` lists the five commands and nothing else; `tson <command>
 * --help` gives that command what it needs -- what it does, its own options (including the
 * shared `POLICY_OPTIONS_HELP` block for `validate`/`compile`/`policy`, the three that judge a
 * name), and its exit codes. A usage *error* (a bad flag, a missing argument) prints the short
 * one-line `*_USAGE` instead, plus the top-level command list -- a caller who typo'd a flag needs
 * the invocation's shape, not a manual page.
 *
 * Argument parsing is hand-rolled, deliberately, matching the reference implementation's own
 * choice for the same reason it states: the flag set is small and fixed enough that a real
 * parsing library buys nothing here, and `@ltr8/tson`'s own "zero runtime dependencies" ethos
 * extends to this sibling package even though nothing forces it to.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { UsageError, EXIT, exitCodeFor } from './exit.js';
import { describeError } from './problem.js';
import { consumePolicyOptions, type PolicyOptions } from './policyOptions.js';
import {
  parseFormat,
  renderCompileRun,
  renderHashRun,
  renderPolicy,
  renderValidateRun,
  type Format,
} from './render.js';
import { runCompile } from './commands/compile.js';
import { runHash } from './commands/hash.js';
import { runInitExample } from './commands/initExample.js';
import { runPolicy } from './commands/policy.js';
import { runValidate, type ValidateOptions } from './commands/validate.js';

export { EXIT } from './exit.js';

const USAGE = `tson — TSON (Typed Schema Object Notation) command line

Usage:
  tson validate [--schema <file-or-url> --root <name>] [<policy options>] [--format text|json|tson] <file|->...
  tson compile  [<policy options>] [--format text|json|tson] <schema>...
  tson policy   [<policy options>] [--format text|json|tson]
  tson hash     [--format text|json|tson] <schema>...
  tson init-example [<dir>]

Commands:
  validate       Validate data documents against a schema they name, or (with no --schema)
                 base syntax and the built-in type vocabulary alone. See 'tson validate --help'.
  compile        Resolve and link a schema document against the bundled standard library and
                 report whether it compiles. See 'tson compile --help'.
  policy         Print the [TSON-DATA] §8.2 Unicode policy this run would apply, with no
                 document in hand. See 'tson policy --help'.
  hash           Compute a document's canonical content hash ([TSON-DATA] §2.2.1) and, when
                 it declares !!id, the reference pinned with that hash. See 'tson hash --help'.
  init-example   Write an example schema (person.tn) and a matching data document
                 (person-data.tn) into <dir> (default: .), ready to validate.

Options:
  --help, -h     print this help; 'tson <command> --help' for a command's own options
  --             end option parsing; every later argument is a file name

Any other argument beginning with '-' is a usage error (exit 2), never a file name --
a mistyped flag is not something to try to open.

Exit codes:
  0  checked, and nothing to report
  1  checked and rejected -- includes a [TSON-DATA] §8.2 name-hygiene refusal
  2  usage error
 69  a schema permanently unavailable -- refused by policy, absent, or too large
 75  a schema temporarily unavailable -- unreachable, or it did not answer in time
 78  a type the schema needs has no registered binding
 70  a gap in this library, or an internal fault -- never a statement about your document
`;

/**
 * The [TSON-DATA] §8.2 policy flags, printed by the help of each command that takes them
 * (`validate`, `compile`, `policy`) -- stated once here rather than three times, matching the
 * reference implementation's own shared `POLICY_OPTIONS` block.
 */
const POLICY_OPTIONS_HELP = `policy options -- [TSON-DATA] §8.2 name hygiene, which decides whether a name is refused
here but accepted elsewhere. Every report states what it was judged under ('tson policy'
prints it on its own; 'validate'/'compile' carry it as their own 'policy' field).
  --identifier-policy <level>   level for declared names (default: highly-restrictive)
  --identifier-per-segment      apply it per _/- segment rather than the whole name, which
                                admits id_пользователя while still refusing id_pаy
  --identifier-scripts <A+B>    admit one script combination over and above the level,
                                e.g. Latin+Cyrillic (repeatable)
  --token-policy <level>        level for values (default: unrestricted, which scans nothing)
  --token-scripts <A+B>         the same for values; on its own it raises the token level to
                                single-script, a list of combinations being no configuration
                                at all under a level that scans nothing (repeatable)

<level> is a UTS #39 §5.2 restriction level: ascii-only, single-script, highly-restrictive,
moderately-restrictive, minimally-restrictive, unrestricted. The spelling 'tson policy'
prints (HIGHLY_RESTRICTIVE) is accepted too, so its output is usable as its input.

<A+B> names UCD Script property values joined by '+', such as Latin+Cyrillic -- the long-form
name only ('Latin', not 'Latn'); 'tson policy' prints back whatever a combination resolved to.

Reach for the unit or a named combination before dropping a level: both keep the rule
everywhere else. 'tson policy' with the same flags prints exactly what they would apply.`;

const VALIDATE_USAGE =
  "usage: tson validate [--schema <file-or-url> --root <name>] [<policy options>] [--format text|json|tson] <file|->...   ('-' reads one data document from stdin)";

const VALIDATE_HELP = `usage: tson validate [--schema <file-or-url> --root <name>] [<policy options>] [--format text|json|tson] <file|->...

Validates data documents. With no --schema: base syntax and the built-in type vocabulary
only (Class 1). With --schema: also give --root, and every file's root value is read
against that schema entry. '-' reads one data document from standard input, at most once,
always as data. Never fetches or opens a schema a data file's own !!schema directive
names -- only --schema/--root, given on the command line, is ever consulted.

options:
  --schema <file-or-url>   schema to validate against (a local path or an https:// URL)
  --root <name>            the schema entry the root value reads against (with --schema)
  --format text|json|tson  output format (default: text)

${POLICY_OPTIONS_HELP}

exit codes: 0 every file checked and nothing to report, 1 at least one checked and rejected,
            2 usage error, 69 a schema nothing here would supply, 75 a schema that could not
            be reached, 78 a type this tool has no binding for, 70 a gap in this library or
            an internal fault`;

const COMPILE_USAGE =
  'usage: tson compile [<policy options>] [--format text|json|tson] <schema>...';

const COMPILE_HELP = `usage: tson compile [<policy options>] [--format text|json|tson] <schema>...

Resolves and links each schema document against the bundled standard library (meta-kernel,
meta.tn, core.tn) and reports whether it compiles -- composition, refinement, template
application, reference validity, choice disjointness. Does not force every declared
entry's reader; see this command's own module doc for why.

options:
  --format text|json|tson  output format (default: text)

${POLICY_OPTIONS_HELP}

exit codes: 0 every schema compiles, 1 at least one checked and rejected, 2 usage error,
            69 a schema nothing here would supply, 75 a schema that could not be reached,
            78 a type this tool has no binding for, 70 a gap in this library or an internal
            fault`;

const POLICY_USAGE =
  "usage: tson policy [<policy options>] [--format text|json|tson]   (the [TSON-DATA] §8.2 Unicode policy this run would apply; see 'tson policy --help')";

const POLICY_HELP = `usage: tson policy [<policy options>] [--format text|json|tson]

Prints the [TSON-DATA] §8.2 identifier and token policy this run would apply, and the
Unicode data version behind it -- what decides whether a name is refused here but accepted
elsewhere, which is in neither your document nor your schema. The same record rides on
every validate/compile report ('policy'); this prints it with no document in hand, so a
generator can conform before it writes rather than after being refused.

It takes the policy options itself, so it doubles as their dry run: 'tson policy
--identifier-policy ascii-only' prints exactly what a validate under that flag would apply.

options:
  --format text|json|tson  output format (default: text)

${POLICY_OPTIONS_HELP}

Exit code is always 0: this is a question about this processor, and it has an answer
whatever the state of anyone's documents.`;

const HASH_USAGE = 'usage: tson hash [--format text|json|tson] <schema>...';

const HASH_HELP = `usage: tson hash [--format text|json|tson] <schema>...

Computes each document's canonical content hash ([TSON-DATA] §2.2.1: SHA-256 over every
byte past the first line's terminator) and, when it declares !!id, the reference pinned
with that hash (<id>?sha256=<hex>). Applies to any TSON document, schema or data.

Read-only: prints the pinned reference rather than rewriting the file in place -- a caller
who wants the file rewritten pipes the printed reference into their own edit.

options:
  --format text|json|tson  output format (default: text)`;

const INIT_USAGE =
  'usage: tson init-example [<dir>]   (writes person.tn and person-data.tn; default dir: .)';

const INIT_HELP = `usage: tson init-example [<dir>]

Writes an example schema (person.tn) and a data document that validates against it
(person-data.tn) into <dir>, defaulting to the current directory. Edit either and re-run
'tson validate --schema person.tn --root person person-data.tn' to see what changes.
Refuses to overwrite an existing file.`;

function isHelpFlag(arg: string): boolean {
  return arg === '--help' || arg === '-h';
}

/** Whether `--help`/`-h` appears anywhere in a subcommand's own arguments -- checked ahead of everything else that subcommand does, including policy-flag parsing, so a bad policy value never stands between a caller and the help they asked for. */
function hasHelpFlag(args: readonly string[]): boolean {
  return args.some(isHelpFlag);
}

/**
 * Whether `arg` looks like a flag rather than a file name. A lone `-` does not: it is
 * `validate`'s own stdin token. Everything else beginning with `-` does, which is why an
 * unrecognised one is a usage error rather than a file the command then fails to open -- a
 * mistyped `--schemas` reported as ENOENT tells a script the tool ran and the file was missing,
 * when in fact nothing was checked.
 */
function looksLikeFlag(arg: string): boolean {
  return arg.startsWith('-') && arg !== '-';
}

function rejectUnknownFlag(arg: string, usage: string): never {
  throw new UsageError(`unrecognized option '${arg}'\n${usage}`);
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
  policy: PolicyOptions,
): { options: ValidateOptions; format: Format } {
  let format: Format = 'text';
  let schemaLocation: string | undefined;
  let root: string | undefined;
  const files: string[] = [];
  // `--` ends option parsing, so a file genuinely named like a flag stays reachable.
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (literal) {
      files.push(arg);
      continue;
    }
    switch (arg) {
      case '--':
        literal = true;
        break;
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
        if (looksLikeFlag(arg)) rejectUnknownFlag(arg, VALIDATE_USAGE);
        files.push(arg);
    }
  }
  return {
    options: {
      files,
      policy,
      ...(schemaLocation === undefined ? {} : { schemaLocation }),
      ...(root === undefined ? {} : { root }),
    },
    format,
  };
}

async function runValidateCommand(args: readonly string[]): Promise<number> {
  if (hasHelpFlag(args)) {
    process.stdout.write(`${VALIDATE_HELP}\n`);
    return EXIT.OK;
  }
  const { policy, rest } = consumePolicyOptions(args);
  const parsed = parseValidateArgs(rest, policy);
  const run = await runValidate(parsed.options);
  process.stdout.write(`${renderValidateRun(run, parsed.format)}\n`);
  if (run.outcome === 'VALID') {
    return EXIT.OK;
  }
  const code = exitCodeFor(run.files.flatMap((f) => f.diagnostics));
  if (code === EXIT.FAULT) {
    process.stderr.write(
      'note: some input could not be checked -- a construct is not implemented yet (see the ' +
        'NOT_IMPLEMENTED entries above). This is a gap in tson, not a problem with your document.\n',
    );
  } else if (code === EXIT.CONFIG) {
    process.stderr.write(
      'note: some input could not be checked -- a type the schema needs has no registered ' +
        'binding (see the BIND_MISMATCH entries above). Nothing is wrong with your document.\n',
    );
  } else if (code === EXIT.SCHEMA_UNAVAILABLE) {
    process.stderr.write(
      'note: some input could not be checked -- a schema could not be obtained (see the ' +
        'SCHEMA_ entries above). Nothing here has read that schema, so nothing here is saying ' +
        'your document, or that schema, is wrong. Rerunning will not obtain it.\n',
    );
  } else if (code === EXIT.SCHEMA_TEMPFAIL) {
    process.stderr.write(
      'note: some input could not be checked -- a schema could not be reached (see the ' +
        'SCHEMA_ entries above). This one may succeed if you run it again.\n',
    );
  }
  return code;
}

// ── compile ──────────────────────────────────────────────────────────────────────────────────

function parseFilesAndFormat(
  args: readonly string[],
  usage: string,
): { files: string[]; format: Format } {
  let format: Format = 'text';
  const files: string[] = [];
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (literal) {
      files.push(arg);
      continue;
    }
    if (arg === '--') {
      literal = true;
      continue;
    }
    if (arg === '--format') {
      format = parseFormatArg(requireValue(args, ++i, '--format'));
      continue;
    }
    if (looksLikeFlag(arg)) rejectUnknownFlag(arg, usage);
    files.push(arg);
  }
  if (files.length === 0) {
    throw new UsageError(usage);
  }
  return { files, format };
}

async function runCompileCommand(args: readonly string[]): Promise<number> {
  if (hasHelpFlag(args)) {
    process.stdout.write(`${COMPILE_HELP}\n`);
    return EXIT.OK;
  }
  const { policy, rest } = consumePolicyOptions(args);
  const { files, format } = parseFilesAndFormat(rest, COMPILE_USAGE);
  const run = await runCompile(files, policy);
  process.stdout.write(`${renderCompileRun(run, format)}\n`);
  return run.outcome === 'VALID' ? EXIT.OK : EXIT.INVALID;
}

// ── policy ───────────────────────────────────────────────────────────────────────────────────

/**
 * Not `async`: {@link runPolicy} has nothing to await -- `Tson.processorPolicy` is a pure
 * function of its `Config` -- and this project's own lint configuration flags an `async`
 * function that never does (`policyOptions.ts`'s `mapSchemaSource` notes the same rule). Still
 * returns a `Promise<number>`, matching every other command in {@link main}'s own dispatch map.
 */
function runPolicyCommand(args: readonly string[]): Promise<number> {
  if (hasHelpFlag(args)) {
    process.stdout.write(`${POLICY_HELP}\n`);
    return Promise.resolve(EXIT.OK);
  }
  const { policy, rest } = consumePolicyOptions(args);
  let format: Format = 'text';
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === '--format') {
      format = parseFormatArg(requireValue(rest, ++i, '--format'));
      continue;
    }
    // `policy` takes no positional arguments at all -- anything left after the shared policy
    // flags and `--format` is a usage error, matching the reference implementation's `runPolicy`.
    throw new UsageError(POLICY_USAGE);
  }
  const result = runPolicy(policy);
  process.stdout.write(`${renderPolicy(result, format)}\n`);
  return Promise.resolve(EXIT.OK);
}

// ── hash ─────────────────────────────────────────────────────────────────────────────────────

async function runHashCommand(args: readonly string[]): Promise<number> {
  if (hasHelpFlag(args)) {
    process.stdout.write(`${HASH_HELP}\n`);
    return EXIT.OK;
  }
  const { files, format } = parseFilesAndFormat(args, HASH_USAGE);
  const run = await runHash(files);
  process.stdout.write(`${renderHashRun(run, format)}\n`);
  return run.outcome === 'VALID' ? EXIT.OK : EXIT.INVALID;
}

// ── init-example ─────────────────────────────────────────────────────────────────────────────

async function runInitExampleCommand(args: readonly string[]): Promise<number> {
  if (hasHelpFlag(args)) {
    process.stdout.write(`${INIT_HELP}\n`);
    return EXIT.OK;
  }
  // Flags first: `init-example --force somewhere` is two arguments, and reporting only "too many
  // arguments" for it would leave the caller to work out which of the two was wrong.
  for (const arg of args) {
    if (looksLikeFlag(arg)) rejectUnknownFlag(arg, INIT_USAGE);
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
    policy: runPolicyCommand,
    hash: runHashCommand,
    'init-example': runInitExampleCommand,
  }[command];

  if (run === undefined) {
    process.stderr.write(
      `tson: unknown command '${command}' -- expected validate, compile, policy, hash, or init-example\n\n${USAGE}`,
    );
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

/**
 * Whether this module is the program being run, rather than a module something imported.
 *
 * **Both sides are resolved to a real path, and that is the whole point.** `npm` installs a `bin`
 * as a symlink (`node_modules/.bin/tson` -> `../@ltr8/tson-cli/dist/cli.js`), and node sets
 * `process.argv[1]` to the path *as invoked* -- the symlink -- while `import.meta.url` is always
 * the resolved target. Comparing them directly is therefore false for every installed invocation,
 * which made the published CLI a silent no-op: `main` never ran, nothing was printed, and the
 * process exited 0. Exiting 0 without checking anything is the worst failure a validator has, since
 * a script reading `$?` concludes the input was fine.
 *
 * The guard has to stay -- `test/cli.test.ts` imports {@link main} from this module and would
 * otherwise run it against vitest's own argv on import -- so it is the comparison that is fixed.
 */
function runningAsProgram(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === fileURLToPath(import.meta.url);
  } catch {
    // argv[1] names something unresolvable: not this file, whatever it is.
    return false;
  }
}

/* node:coverage disable -- process wiring; `scripts/smoke-cli.sh` drives it through a real install */
if (runningAsProgram()) {
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
