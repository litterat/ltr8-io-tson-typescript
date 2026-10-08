/**
 * `tson validate [--schema <file-or-url>] [--root <name>] [<policy options>] <file|-># ...`
 *
 * With no `--schema`, every file is checked against base syntax and the built-in type vocabulary
 * alone (Class 1) -- `@ltr8/tson`'s schemaless `validate()`. With `--schema`, every file's root
 * value is read against `--root`'s own entry in that schema, compiled once and shared across
 * every file this run checks.
 *
 * **`--root` is required whenever `--schema` is given, and is not auto-detected from a data
 * file's own header.** The reference implementation's CLI is fully self-describing (each data
 * file's own `!!schema` directive picks its schema, no `--type` needed) -- this port does not
 * follow that design, deliberately: honouring a directive a *data file* declares would mean
 * fetching or opening whatever it names on the strength of untrusted content, exactly the
 * SSRF/arbitrary-file-read shape `@ltr8/tson/source`'s own module doc warns a `SchemaSource`
 * implementation about ("the reference is attacker-controlled... a data document names its own
 * schema"). Requiring `--schema`/`--root` on the command line means the only schema a run ever
 * consults is one its own caller named, never one a data file asked for on its own.
 *
 * **Streams every data file rather than buffering it whole** (`node:fs`'s own `createReadStream`,
 * or `process.stdin` for `-`) -- `validate()`'s async overload accepts any `AsyncIterable<Uint8Array>`
 * directly, so this CLI's own memory use stays proportional to nesting depth the same way
 * `CLAUDE.md`'s "streaming is non-negotiable" asks of the library itself, not just of it.
 *
 * **[TSON-DATA] §8.2's policy applies to every path, but not identically.** `options.policy.identifierPolicy`
 * governs a schema's own declared names at link time ([TSON-SCHEMA] §11.4, via `stdlibTson`'s own
 * `Config`) whenever `--schema` is given; `identifierPolicy`/`tokenPolicy` together govern a
 * schemaless *text* read's own record field names and token values (§8.2's Part 1 scope) as
 * per-call options to `validate()`. A schema-governed *text* read consults neither directly -- a
 * data field name under a schema inherits the declaration's own verdict, which linking already
 * reached (`@ltr8/tson/config.ts`'s own note on `Config.identifierPolicy`). **JSON differs
 * here**: [TSON-JSON] §9.4 has the identifier policy reach every `$type` and every member name
 * that matches no declared field even under a schema-governed read, so this CLI passes
 * `options.policy.identifierPolicy` through to `validateJsonAsync` for every `.json`/JSON-stdin
 * input, bound or not -- there is no JSON path that skips it the way the text path does.
 *
 * **JSON inputs ([TSON-JSON] §3.1, §3.4).** A file whose name ends `.json` (case-insensitive) is
 * a JSON encoding of TSON data, read with `@ltr8/tson/json`'s own `validateJsonAsync` rather than
 * `@ltr8/tson`'s text `validate`. [TSON-JSON] §3.4 gives a document's binding exactly two routes,
 * out-of-band or in-band, and this CLI -- for JSON as for text -- offers only the out-of-band one:
 * `--schema`/`--root` are the sole source of a JSON input's binding, never a `$schema`/`$type`
 * the document itself carries, for the identical attacker-controlled-reference reason this
 * module's own top note already states for `!!schema`. §3.4 also says there is no schemaless
 * reading for this encoding at all ("this encoding has none"), so a `.json` input with no binding
 * is a usage error, checked before any file is opened, rather than falling back to a Class-1-style
 * check the way an unbound `.tn` file does. **§9.4's token policy** (map keys and string values,
 * once a deployment sets one) now reaches a schema-directed JSON read (`ReadJsonOptions.tokenPolicy`,
 * `json/schema/tokenHygiene.ts`) -- but this CLI does not thread it there yet: the code below still
 * passes only `identifierPolicy` to `validateJsonAsync`, so `--token-policy`/`--token-scripts`
 * currently affect only `.tn`/TSON-text inputs; see `STATUS.md`'s own "Known gaps" entry.
 *
 * **Standard input is TSON text by default, whatever binding is given** -- a deliberate
 * divergence from the reference CLI (recorded in `STATUS.md`), which instead infers `-`'s
 * encoding from whether `--schema`/`--type` are given ("read as JSON when they are, since a .tn
 * document names its own binding and would not need them"). This CLI does not: `-` piped in is
 * TSON text unconditionally, so `cat data.tn | tson validate --schema s.tn --root person -`
 * reads `data.tn` as TSON regardless of `--schema`/`--root` being present, and a caller piping
 * JSON says so explicitly. `--input tson|json` makes every input's encoding an explicit choice
 * rather than an inferred one: omitted, a named file is classified by its own extension
 * ([TSON-JSON] §3.1's `.json`) and `-` is always TSON; given, it forces every input this run
 * reads, named or `-`, to that one encoding.
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import {
  diagnosticCodeForFetch,
  TsonInternalError,
  TsonSchemaFetchError,
  validate,
  type CompiledSchema,
  type Diagnostic,
  type LinkedSchema,
  type Tson,
} from '@ltr8/tson';
import { compileJsonSchema, validateJsonAsync, type JsonCompiledSchema } from '@ltr8/tson/json';
import { UsageError } from '../exit.js';
import { outcomeOfDiagnostics, outcomeOfFiles, type Outcome } from '../outcome.js';
import { classifyReadError, isInvalidSchemaError } from '../problem.js';
import { processorPolicyOf, type PolicyOptions, type ProcessorPolicy } from '../policyOptions.js';
import { stdlibTson } from '../stdlib.js';

/** Which encoding an input is read as. */
export type InputKind = 'json' | 'tson';

export interface ValidateOptions {
  readonly schemaLocation?: string;
  readonly root?: string;
  /** Forces every input's encoding, overriding the by-extension/`-`-is-TSON default (this module's own top note). `undefined` applies that default. */
  readonly input?: InputKind;
  readonly policy: PolicyOptions;
  readonly files: readonly string[];
}

export interface ValidateFileResult {
  readonly file: string;
  readonly outcome: Outcome;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ValidateRun {
  readonly outcome: Outcome;
  /** Stated once for the run, never per file -- [TSON-DATA] §8.2's own verdict cannot differ between two files of one invocation. Mirrors the reference implementation's `ValidationRun.policy`. */
  readonly policy: ProcessorPolicy;
  readonly files: readonly ValidateFileResult[];
}

const HTTP_URL = /^https?:\/\//u;

/** Fetches or reads `location`'s schema bytes -- an `http(s)://` URL is fetched (no redirects, a bounded timeout), anything else is a local file path. Never consults a data file's own `!!schema`; see this module's own top note on why. */
async function loadSchemaBytes(location: string): Promise<Uint8Array> {
  if (!HTTP_URL.test(location)) {
    return await readFile(location);
  }
  // One signal for the whole operation, headers and body together. `AbortSignal.timeout` fires on
  // schedule but only aborts what is still awaiting it, so a signal passed to `fetch` alone stops
  // bounding anything the moment the response headers arrive — a server that answers 200 and then
  // streams forever was never interrupted.
  const deadline = AbortSignal.timeout(SCHEMA_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(location, {
      redirect: 'error',
      signal: deadline,
    });
  } catch (error) {
    throw new TsonSchemaFetchError(
      location,
      'transport',
      `cannot fetch schema '${location}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new TsonSchemaFetchError(
      location,
      'not-found',
      `cannot fetch schema '${location}': HTTP ${String(response.status)}`,
    );
  }
  return await readCappedBody(location, response, deadline);
}

/** The most a fetched schema may be. A schema is a document, not a data feed. */
const SCHEMA_MAX_BYTES = 8 * 1024 * 1024;

/** How long the whole fetch may take, headers and body together. */
const SCHEMA_FETCH_TIMEOUT_MS = 30_000;

/**
 * Reads a response body with the size cap enforced WHILE streaming.
 *
 * `response.arrayBuffer()` buffers whatever arrives with no bound at all, so a server that
 * answers 200 and then writes forever grows the process until it dies — measured at ~13 GB RSS
 * after 90 seconds, with the process never exiting. The cap has to be checked per chunk, and the
 * body cancelled the moment it trips, which is also what the library's own schema sources do.
 */
async function readCappedBody(
  location: string,
  response: Response,
  deadline: AbortSignal,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    return new Uint8Array(0);
  }
  // Typed locally: this package carries no DOM lib, so `getReader()` would otherwise be `any` and
  // every use of the chunk below unchecked.
  interface ByteReader {
    read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
    cancel(): Promise<void>;
  }
  const reader = (body as unknown as { getReader(): ByteReader }).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (deadline.aborted) {
        throw new TsonSchemaFetchError(
          location,
          'timeout',
          `cannot fetch schema '${location}': exceeded ${String(SCHEMA_FETCH_TIMEOUT_MS)} ms`,
        );
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.length;
      if (total > SCHEMA_MAX_BYTES) {
        throw new TsonSchemaFetchError(
          location,
          'too-large',
          `cannot fetch schema '${location}': exceeds ${String(SCHEMA_MAX_BYTES)} bytes`,
        );
      }
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/**
 * Loads, resolves and links `location` against the bundled standard library, under `policy`'s own
 * `identifierPolicy` ([TSON-SCHEMA] §11.4) -- the one step both encodings share; {@link
 * runValidate} compiles the result to whichever of {@link CompiledSchema}/{@link
 * JsonCompiledSchema} the run's own inputs actually need.
 *
 * A {@link TsonSchemaFetchError} propagates unchanged rather than becoming a {@link UsageError}:
 * `--schema https://…` naming a document no source would supply is not a usage mistake -- the
 * command line was fine, the schema just could not be obtained -- and {@link runValidate} routes
 * it to a non-verdict outcome instead. Every other failure here stays usage-shaped: the caller
 * asked this run to validate against a schema that isn't usable, before any data file was even
 * opened.
 */
async function loadLinkedSchema(
  location: string,
  policy: PolicyOptions,
): Promise<{ readonly tson: Tson; readonly linked: LinkedSchema }> {
  const tson = stdlibTson({ identifierPolicy: policy.identifierPolicy });
  let bytes: Uint8Array;
  try {
    bytes = await loadSchemaBytes(location);
  } catch (error) {
    if (error instanceof TsonSchemaFetchError) {
      throw error;
    }
    throw new UsageError(
      `cannot read schema '${location}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return { tson, linked: tson.resolveSchema(bytes) };
  } catch (error) {
    if (error instanceof TsonSchemaFetchError) {
      throw error;
    }
    if (isInvalidSchemaError(error)) {
      throw new UsageError(`schema '${location}' does not resolve: ${error.message}`);
    }
    throw error;
  }
}

/** `-` for stdin (read once, whole process lifetime), otherwise a streamed file. Typed as `Readable`, not the narrower `NodeJS.ReadableStream` interface, because it is `Readable`'s own `[Symbol.asyncIterator]` that makes this structurally an `AsyncByteSource` for `validate()`'s async overload below. */
function openSource(file: string): Readable {
  return file === '-' ? process.stdin : createReadStream(file);
}

/** Whether `file`'s own name marks it as a JSON encoding of TSON data ([TSON-JSON] §3.1: "a JSON file, and .json is its extension"). Case-insensitive, matching this CLI's other file-classification rules; `'-'` has no name to classify by and never ends in `.json`, so absent `--input` it falls through {@link classifyInput} to TSON text, matching this module's own top note. */
function isJsonPath(file: string): boolean {
  return file.toLowerCase().endsWith('.json');
}

/** Classifies one input by this module's own top note: `forced` (`--input`), when given, wins outright; otherwise a `.json` name is JSON and everything else -- including `-` -- is TSON text. */
function classifyInput(file: string, forced: InputKind | undefined): InputKind {
  if (forced !== undefined) return forced;
  return isJsonPath(file) ? 'json' : 'tson';
}

/**
 * The root name plus whichever of the two encodings' compiled forms this run's own inputs need --
 * `text` for every `.tn` input and for stdin (`classifyInput`'s own default, this module's top
 * note: stdin is TSON text unless `--input json` forces it), `json` for every `.json` input and
 * for stdin only when `--input json` is given. Built from one shared {@link LinkedSchema}
 * (`runValidate`'s own `loadLinkedSchema`), so a run mixing both encodings against one schema
 * compiles it once per encoding, never per file, and "compiled but no root name" stays
 * unrepresentable rather than a runtime check away.
 */
interface SchemaContext {
  readonly root: string;
  readonly text?: CompiledSchema;
  readonly json?: JsonCompiledSchema;
}

async function validateOne(
  file: string,
  kind: InputKind,
  context: SchemaContext | undefined,
  policy: PolicyOptions,
): Promise<ValidateFileResult> {
  const source = openSource(file);
  try {
    // Per-call `identifierPolicy`/`tokenPolicy` matter only on the schemaless *text* path: a
    // schema-governed *text* read (`context.text`) consults neither -- see this module's own top
    // note. JSON differs: [TSON-JSON] §9.4 applies `identifierPolicy` to a schema-directed read
    // too (every `$type`, and any member name matching no declared field), so a JSON read always
    // carries it, bound or not.
    let result: { readonly diagnostics: readonly Diagnostic[] };
    if (kind === 'json') {
      if (context?.json === undefined) {
        // `runValidate` compiles `json` for every context a `'json'`-classified input reaches --
        // see its own note on why a `.json` input with no binding is a usage error, caught before
        // any file opens, and never reaches here at all.
        throw new TsonInternalError(
          `'${file}' is a JSON input but no compiled JSON schema reached validateOne -- this is a library bug`,
        );
      }
      result = await validateJsonAsync(source, {
        schema: context.json,
        root: context.root,
        identifierPolicy: policy.identifierPolicy,
      });
    } else if (context?.text !== undefined) {
      result = await validate(source, { schema: context.text, root: context.root });
    } else {
      result = await validate(source, {
        identifierPolicy: policy.identifierPolicy,
        tokenPolicy: policy.tokenPolicy,
      });
    }
    return {
      file,
      outcome: outcomeOfDiagnostics(result.diagnostics),
      diagnostics: result.diagnostics,
    };
  } catch (error) {
    const problem = classifyReadError(error);
    if (problem.kind === 'invalid') {
      return {
        file,
        outcome: outcomeOfDiagnostics([problem.diagnostic]),
        diagnostics: [problem.diagnostic],
      };
    }
    if (problem.kind === 'not-implemented') {
      const diagnostics: Diagnostic[] = [{ code: 'NOT_IMPLEMENTED', message: problem.message }];
      return { file, outcome: outcomeOfDiagnostics(diagnostics), diagnostics };
    }
    throw problem.error; // an unreadable file, or a bug here -- the caller's job to classify
  }
}

/**
 * Runs `validate` over every file. Throws {@link UsageError} for a bad invocation (no files, `-`
 * given more than once, `--schema` without `--root`, a `.json` input with no binding, a `--root`
 * that names no entry, a schema that will not resolve) before any data file is opened; an
 * unreadable *data* file still throws past this function too, for the same classification reason
 * `commands/compile.ts`/`commands/hash.ts` leave one to their own callers.
 *
 * **A `--schema` no configured source would supply is its own outcome, not a usage error.** No
 * file is opened either way, but every requested file comes back `NOT_CHECKED`, carrying the
 * fetch diagnostic, rather than the run simply throwing -- the same shape a per-file
 * `NOT_IMPLEMENTED` already takes, so a caller reading `diagnostics` sees one consistent story
 * regardless of how early the run stopped.
 *
 * **A binding with no `.json` input to apply it to is not a usage error**, deliberately: `--schema`/
 * `--root` already govern schema-checked `.tn` inputs on their own (`init-example` writes a pair
 * this run checks exactly that way, with no `.json` input in sight), so requiring a JSON input
 * whenever a binding is given would reject that existing, tested use.
 */
export async function runValidate(options: ValidateOptions): Promise<ValidateRun> {
  if (options.files.length === 0) {
    throw new UsageError('validate: at least one <file> is required');
  }
  const stdinCount = options.files.filter((f) => f === '-').length;
  if (stdinCount > 1) {
    throw new UsageError(
      `standard input can only be read once, but '-' was given ${String(stdinCount)} times`,
    );
  }
  // The guard is deliberately both ways. `--root` names a type inside a schema, so on its own it
  // names nothing: accepting it and discarding it would let a run whose `--schema` was dropped or
  // mistyped fall back to schemaless Class-1 checking and report "valid" for data nobody had
  // checked against a schema.
  const { schemaLocation, root } = options;
  if (schemaLocation === undefined && root !== undefined) {
    throw new UsageError('validate: --schema is required when --root is given');
  }
  if (schemaLocation !== undefined && root === undefined) {
    throw new UsageError('validate: --root is required when --schema is given');
  }
  const bindingGiven = schemaLocation !== undefined && root !== undefined;

  const kinds = new Map(options.files.map((file) => [file, classifyInput(file, options.input)]));
  // [TSON-JSON] §3.4: this encoding has no schemaless reading at all, so an input this run reads
  // as JSON -- by extension, or forced with `--input json`, `-` included -- with no binding is
  // refused up front, unlike an unbound TSON-text input, which the schemaless branch below still
  // checks on Class-1 terms.
  if (!bindingGiven) {
    const unboundJson = options.files.find((file) => kinds.get(file) === 'json');
    if (unboundJson !== undefined) {
      throw new UsageError(
        `validate: '${unboundJson}' is read as JSON, which has no schemaless reading ` +
          '([TSON-JSON] §3.4) -- give --schema and --root',
      );
    }
  }

  const policy = processorPolicyOf(options.policy);

  let context: SchemaContext | undefined;
  if (schemaLocation !== undefined && root !== undefined) {
    let tson: Tson;
    let linked: LinkedSchema;
    try {
      ({ tson, linked } = await loadLinkedSchema(schemaLocation, options.policy));
    } catch (error) {
      if (!(error instanceof TsonSchemaFetchError)) {
        throw error;
      }
      const diagnostic: Diagnostic = {
        code: diagnosticCodeForFetch(error.reason),
        message: error.message,
      };
      const files: ValidateFileResult[] = options.files.map((file) => ({
        file,
        outcome: outcomeOfDiagnostics([diagnostic]),
        diagnostics: [diagnostic],
      }));
      return { outcome: outcomeOfFiles(files.map((f) => f.outcome)), policy, files };
    }
    if (!linked.entries.has(root)) {
      throw new UsageError(`validate: '${root}' is not declared in schema '${schemaLocation}'`);
    }
    const needsText = [...kinds.values()].includes('tson');
    const needsJson = [...kinds.values()].includes('json');
    context = {
      root,
      ...(needsText ? { text: tson.compile(linked) } : {}),
      ...(needsJson ? { json: compileJsonSchema(linked) } : {}),
    };
  }

  const files: ValidateFileResult[] = [];
  for (const file of options.files) {
    const kind = kinds.get(file) ?? 'tson'; // every file was classified above; the fallback is unreachable
    files.push(await validateOne(file, kind, context, options.policy));
  }
  return { outcome: outcomeOfFiles(files.map((f) => f.outcome)), policy, files };
}
