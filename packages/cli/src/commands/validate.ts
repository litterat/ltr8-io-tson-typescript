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
 * **[TSON-DATA] §8.2's policy applies to both paths, differently.** `options.policy.identifierPolicy`
 * governs a schema's own declared names at link time ([TSON-SCHEMA] §11.4, via `stdlibTson`'s own
 * `Config`) whenever `--schema` is given; `identifierPolicy`/`tokenPolicy` together govern a
 * schemaless read's own record field names and token values (§8.2's Part 1 scope) as per-call
 * options to `validate()`. A schema-governed *read* consults neither directly -- a data field
 * name under a schema inherits the declaration's own verdict, which linking already reached
 * (`@ltr8/tson/config.ts`'s own note on `Config.identifierPolicy`).
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import {
  diagnosticCodeForFetch,
  TsonSchemaFetchError,
  validate,
  type CompiledSchema,
  type Diagnostic,
} from '@ltr8/tson';
import { UsageError } from '../exit.js';
import { outcomeOfDiagnostics, outcomeOfFiles, type Outcome } from '../outcome.js';
import { classifyReadError, isInvalidSchemaError } from '../problem.js';
import { processorPolicyOf, type PolicyOptions, type ProcessorPolicy } from '../policyOptions.js';
import { stdlibTson } from '../stdlib.js';

export interface ValidateOptions {
  readonly schemaLocation?: string;
  readonly root?: string;
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
 * Loads, resolves, links and compiles `location` against the bundled standard library, under
 * `policy`'s own `identifierPolicy` ([TSON-SCHEMA] §11.4).
 *
 * A {@link TsonSchemaFetchError} propagates unchanged rather than becoming a {@link UsageError}:
 * `--schema https://…` naming a document no source would supply is not a usage mistake -- the
 * command line was fine, the schema just could not be obtained -- and {@link runValidate} routes
 * it to a non-verdict outcome instead. Every other failure here stays usage-shaped: the caller
 * asked this run to validate against a schema that isn't usable, before any data file was even
 * opened.
 */
async function loadCompiledSchema(
  location: string,
  policy: PolicyOptions,
): Promise<CompiledSchema> {
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
    return tson.compile(tson.resolveSchema(bytes));
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

/** A compiled schema plus which of its entries the root value reads against -- carried as one value so "compiled but no root name" is unrepresentable rather than a runtime check away. */
interface SchemaContext {
  readonly compiled: CompiledSchema;
  readonly root: string;
}

async function validateOne(
  file: string,
  context: SchemaContext | undefined,
  policy: PolicyOptions,
): Promise<ValidateFileResult> {
  const source = openSource(file);
  try {
    // Per-call `identifierPolicy`/`tokenPolicy` matter only on the schemaless path: a
    // schema-governed read (`context` present) consults neither -- see this module's own top note.
    const result =
      context === undefined
        ? await validate(source, {
            identifierPolicy: policy.identifierPolicy,
            tokenPolicy: policy.tokenPolicy,
          })
        : await validate(source, { schema: context.compiled, root: context.root });
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
 * given more than once, `--schema` without `--root`, a schema that will not resolve) before any
 * data file is opened; an unreadable *data* file still throws past this function too, for the
 * same classification reason `commands/compile.ts`/`commands/hash.ts` leave one to their own
 * callers.
 *
 * **A `--schema` no configured source would supply is its own outcome, not a usage error.** No
 * file is opened either way, but every requested file comes back `NOT_CHECKED`, carrying the
 * fetch diagnostic, rather than the run simply throwing -- the same shape a per-file
 * `NOT_IMPLEMENTED` already takes, so a caller reading `diagnostics` sees one consistent story
 * regardless of how early the run stopped.
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
  // The guard is deliberately both ways. `--root` alone used to be accepted and then discarded,
  // so a run whose `--schema` was dropped or mistyped silently fell back to schemaless Class-1
  // checking and reported "valid" for data no one had checked against a schema.
  const { schemaLocation, root } = options;
  if (schemaLocation === undefined && root !== undefined) {
    throw new UsageError('validate: --schema is required when --root is given');
  }
  if (schemaLocation !== undefined && root === undefined) {
    throw new UsageError('validate: --root is required when --schema is given');
  }

  const policy = processorPolicyOf(options.policy);

  let context: SchemaContext | undefined;
  if (schemaLocation !== undefined && root !== undefined) {
    let compiled: CompiledSchema;
    try {
      compiled = await loadCompiledSchema(schemaLocation, options.policy);
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
    context = { compiled, root };
  }

  const files: ValidateFileResult[] = [];
  for (const file of options.files) {
    files.push(await validateOne(file, context, options.policy));
  }
  return { outcome: outcomeOfFiles(files.map((f) => f.outcome)), policy, files };
}
