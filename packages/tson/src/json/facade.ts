/**
 * `readJsonTree`/`validateJson`/`readJsonTreeAsync` — the schema-directed front door, mirroring
 * `facade/tree.ts`'s own `readTree`/`validate` shape and `json/index.ts`'s own
 * `parseJson`/`parseJsonAsync`/`parseJsonCollecting` conventions (this module builds directly on
 * those, rather than re-deriving a document-framing policy of its own): a whole JSON document,
 * read against a {@link JsonCompiledSchema}'s `root` entry, into a {@link JsonValue} — sync for a
 * complete buffer, `Promise`-returning for a chunked source, and a read is all-or-nothing (§9.1:
 * "diagnostics all reported, no value if any was" — every reader in `json/schema/**` already
 * upholds this on its own, so this module adds no second check).
 *
 * **A base-syntax failure (malformed UTF-8, a bad token, a §3.1 grammar violation) or a §10.1
 * nesting-limit refusal still throws even under a collecting read** — {@link parseJsonCollecting}'s
 * own documented posture (`json/index.ts`), carried over here rather than `facade/tree.ts`'s TSON
 * text convention of catching and re-routing both through the receiver: this package's schemaless
 * front door already set that precedent for `json/`, and a schema-directed read follows it instead
 * of introducing a second one.
 */
import {
  collector,
  throwing,
  type Diagnostic,
  type DiagnosticsReceiver,
} from '../core/diagnostic.js';
import { TsonInternalError, TsonReadError } from '../core/errors.js';
import type { NestingLimitOptions } from '../core/limits.js';
import { fromBytes, fromString, runOver, runSync, type ByteInput, type Task } from '../io/bytes.js';
import type { NamePolicy } from '../unicode/policy.js';
import { createJsonReadContext } from './readContext.js';
import type { JsonCompiledSchema, JsonTypeReader } from './schema/compile.js';
import { createJsonStream } from './stream.js';
import type { JsonValue } from './tree.js';

export type { JsonCompiledSchema, JsonTypeReader } from './schema/compile.js';
export { compileJsonSchema } from './schema/compile.js';

/** Options for a schema-directed JSON read — the out-of-band binding [TSON-JSON] §3.4 calls "the expected production route": the application supplies both `schema` and `root`, and the document is then a bare value read directly at that type. */
export interface ReadJsonOptions extends NestingLimitOptions {
  readonly schema: JsonCompiledSchema;
  readonly root: string;
  /** [TSON-DATA] §8.2's identifier policy, applied to an unmatched record member name (`json/schema/nameHygiene.ts`). Defaults to `unicode/policy.ts`'s own `DEFAULT_NAME_POLICY`. */
  readonly identifierPolicy?: NamePolicy;
}

function rootReaderOf(options: ReadJsonOptions): JsonTypeReader {
  const reader = options.schema.find(options.root);
  if (reader === undefined) {
    throw new TsonInternalError(
      `'${options.root}' is not declared in this compiled schema -- a caller must name one of ` +
        'the entries it was compiled from',
    );
  }
  return reader;
}

function inputOf(source: Uint8Array | string): ByteInput {
  return typeof source === 'string' ? fromString(source) : fromBytes(source);
}

/**
 * Reads one whole document off `events` against `reader` — the root value, then the pull past it
 * that rejects trailing content ([TSON-JSON] §3.1's own "a JSON document is one value").
 */
function* readWholeDocument(
  reader: JsonTypeReader,
  events: ReturnType<typeof createJsonStream>,
  receiver: DiagnosticsReceiver,
  options: ReadJsonOptions,
): Task<JsonValue | undefined> {
  const ctx = createJsonReadContext(events, receiver, options.identifierPolicy);
  const rootLocation = options.schema.rootDeclaration(options.root);
  const anchored = rootLocation === undefined ? ctx : ctx.underDeclaration(rootLocation);
  const value = yield* reader.read(anchored);
  const end = yield* ctx.next();
  if (end.kind !== 'end-of-document') {
    ctx.report(
      'VALIDATION_ERROR',
      'the document carries content after its root value, which the read did not consume',
      'end of document',
      end.kind,
    );
    return undefined;
  }
  return value as JsonValue | undefined;
}

/** Reads `source` against `options.schema`'s `options.root` entry, throwing {@link TsonReadError} at the first problem. */
export function readJsonTree(source: Uint8Array | string, options: ReadJsonOptions): JsonValue {
  const reader = rootReaderOf(options);
  const events = createJsonStream(inputOf(source), options);
  const receiver = throwing((d: Diagnostic) => new TsonReadError(d));
  const value = runSync(readWholeDocument(reader, events, receiver, options));
  if (value === undefined) {
    throw new TsonInternalError(
      'a throwing receiver returned instead of throwing -- this is a library bug',
    );
  }
  return value;
}

/** {@link readJsonTree}, driven by an async byte source — the same `Task<JsonValue>` the sync path runs, suspended on chunk boundaries (`io/bytes.ts`'s `runOver`), so memory stays proportional to nesting depth. */
export async function readJsonTreeAsync(
  source: AsyncIterable<Uint8Array>,
  options: ReadJsonOptions,
): Promise<JsonValue> {
  const reader = rootReaderOf(options);
  const receiver = throwing((d: Diagnostic) => new TsonReadError(d));
  const value = await runOver(source, (input: ByteInput): Task<JsonValue | undefined> =>
    readWholeDocument(reader, createJsonStream(input, options), receiver, options),
  );
  if (value === undefined) {
    throw new TsonInternalError(
      'a throwing receiver returned instead of throwing -- this is a library bug',
    );
  }
  return value;
}

/** {@link readJsonTree}/{@link readJsonTreeAsync}'s collecting result — a value only when nothing was reported (all-or-nothing, matching `facade/tree.ts`'s own `ValidationResult`). */
export interface ValidateJsonResult {
  readonly value?: JsonValue;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Reads `source` against `options.schema`'s `options.root` entry, collecting every problem in one
 * pass rather than stopping at the first. See this module's own top note on why a base-syntax
 * failure or a §10.1 limit refusal still throws rather than being collected.
 */
export function validateJson(
  source: Uint8Array | string,
  options: ReadJsonOptions,
): ValidateJsonResult {
  const reader = rootReaderOf(options);
  const events = createJsonStream(inputOf(source), options);
  const problems = collector();
  const value = runSync(readWholeDocument(reader, events, problems, options));
  return problems.diagnostics.length === 0
    ? { diagnostics: problems.diagnostics, ...(value === undefined ? {} : { value }) }
    : { diagnostics: problems.diagnostics };
}

/** {@link validateJson}, driven by an async byte source. */
export async function validateJsonAsync(
  source: AsyncIterable<Uint8Array>,
  options: ReadJsonOptions,
): Promise<ValidateJsonResult> {
  const reader = rootReaderOf(options);
  const problems = collector();
  const value = await runOver(source, (input: ByteInput): Task<JsonValue | undefined> =>
    readWholeDocument(reader, createJsonStream(input, options), problems, options),
  );
  return problems.diagnostics.length === 0
    ? { diagnostics: problems.diagnostics, ...(value === undefined ? {} : { value }) }
    : { diagnostics: problems.diagnostics };
}
