/**
 * `readJsonTree`/`validateJson`/`readJsonTreeAsync` — the schema-directed front door, mirroring
 * `facade/tree.ts`'s own `readTree`/`validate` shape: a whole JSON document, read against a
 * {@link JsonCompiledSchema}'s `root` entry, into a {@link JsonValue} — sync for a complete
 * buffer, `Promise`-returning for a chunked source, and a read is all-or-nothing (§9.1:
 * "diagnostics all reported, no value if any was" — every reader in `json/schema/**` already
 * upholds this on its own, so this module adds no second check).
 *
 * **Both `readJsonTree`/`readJsonTreeAsync` and `validateJson`/`validateJsonAsync` hold to
 * `facade/tree.ts`'s split even for a failure raised before any reader is running**: a document
 * that will not lex or parse, and the pull past the root value that rejects trailing content
 * ([TSON-JSON] §3.1), are both routed through the receiver by {@link readWholeDocument} rather
 * than thrown past it — the same two-tier posture `facade/tree.ts`'s own `readWholeDocument`
 * documents, ported rather than re-derived, so a collecting read here really does hand back
 * every problem in one pass instead of throwing for exactly the documents it exists to handle
 * (`JsonSchemaBindingTest`'s own `aDocumentThatWillNotParseIsReportedThroughTheSameChannel` and
 * `trailingContentIsRejectedUnderASchemaToo` state this for the reference; this module now keeps
 * it too). A fail-fast read still stops at the first problem, because its receiver ({@link
 * throwing}) turns the reported diagnostic straight back into a throw.
 *
 * **A §10.1 nesting-limit refusal ({@link TsonLimitRefusedError}) still propagates untouched**,
 * under a collecting read too — `core/errors.ts`'s own `TsonRefusedError` family is a policy
 * refusal, not a verdict on this document's syntax, and `facade/tree.ts`'s identically-named
 * function does not catch it either (its own `isBaseSyntaxError` names exactly the three text
 * errors a `ReadContext` cannot yet exist to report through; {@link isJsonBaseSyntaxError} below
 * is this encoding's counterpart, over the two JSON raises instead of three — `json/` has no
 * `TsonUnsupportedDocumentError` counterpart, there being no second encoding a JSON document
 * could declare itself as).
 */
import {
  collector,
  throwing,
  type Diagnostic,
  type DiagnosticsReceiver,
} from '../core/diagnostic.js';
import { TsonInternalError, TsonLexError, TsonParseError, TsonReadError } from '../core/errors.js';
import type { NestingLimitOptions } from '../core/limits.js';
import { fromBytes, fromString, runOver, runSync, type ByteInput, type Task } from '../io/bytes.js';
import type { NamePolicy, TokenPolicy } from '../unicode/policy.js';
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
  /**
   * [TSON-DATA] §8.2's "Values" token policy, reached into this encoding by [TSON-JSON] §9.4:
   * "the token policy, when a deployment sets one, reaches map keys and string values"
   * (`json/schema/tokenHygiene.ts`). Defaults to `unicode/policy.ts`'s own
   * `DEFAULT_TOKEN_POLICY`, which checks nothing.
   */
  readonly tokenPolicy?: TokenPolicy;
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
 * A failure `json/stream.ts`/`json/lexer.ts` raise **before** any {@link JsonReadContext} exists
 * to report through: malformed UTF-8 or an unlexable token ({@link TsonLexError}), or a §3.1
 * grammar violation including the pull-past-the-root-value check that rejects trailing content
 * ({@link TsonParseError}). Everything a *reader* finds already goes through the receiver; these
 * two do not, because at the point they are raised there is nothing to go through yet —
 * `facade/tree.ts`'s own `isBaseSyntaxError`, over this encoding's two raises rather than three
 * (see this module's own top note on the missing third).
 */
function isJsonBaseSyntaxError(error: unknown): error is TsonLexError | TsonParseError {
  return error instanceof TsonLexError || error instanceof TsonParseError;
}

/**
 * Reports `diagnostic`, and — if the receiver answers by throwing, which is what a fail-fast read
 * does — attaches `cause` to that error on its way out, so a caller who wants the narrower {@link
 * TsonLexError}/{@link TsonParseError} back can still reach it. `facade/tree.ts`'s identically
 * named, identically shaped helper, ported rather than imported (the `src/json/**` ESLint zone
 * forbids reaching into `facade/` at all).
 */
function reportCaused(receiver: DiagnosticsReceiver, diagnostic: Diagnostic, cause: unknown): void {
  try {
    receiver.report(diagnostic);
  } catch (thrown) {
    if (thrown instanceof Error && thrown.cause === undefined) {
      thrown.cause = cause;
    }
    throw thrown;
  }
}

/**
 * Reads one whole document off `events` against `reader` — the root value, then the pull past it
 * that rejects trailing content ([TSON-JSON] §3.1's own "a JSON document is one value").
 */
function* readJsonDocumentValue(
  reader: JsonTypeReader,
  events: ReturnType<typeof createJsonStream>,
  receiver: DiagnosticsReceiver,
  options: ReadJsonOptions,
): Task<JsonValue | undefined> {
  const ctx = createJsonReadContext(
    events,
    receiver,
    options.identifierPolicy,
    options.tokenPolicy,
  );
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

/**
 * {@link readJsonDocumentValue} with a base-syntax failure ({@link isJsonBaseSyntaxError}) routed
 * through the receiver instead of escaping it — so `validateJson`/`validateJsonAsync` really do
 * hold to their own contract that an empty `diagnostics` means the document conforms, and a
 * non-empty one is the whole story. See this module's own top note for why, and for the one kind
 * of failure ({@link TsonLimitRefusedError}) that still propagates untouched.
 *
 * A fail-fast read's receiver ({@link throwing}) turns the diagnostic straight back into a throw
 * on its way out ({@link reportCaused}), so `readJsonTree`/`readJsonTreeAsync` still stop at the
 * first problem — as one {@link TsonReadError}, with the original error as its `cause`.
 *
 * Anything else — {@link TsonInternalError} above all — propagates untouched: a broken invariant
 * is not a diagnostic about the document, and reporting one as though it were would tell a caller
 * their input was bad when the bug is here.
 */
function* readWholeDocument(
  reader: JsonTypeReader,
  events: ReturnType<typeof createJsonStream>,
  receiver: DiagnosticsReceiver,
  options: ReadJsonOptions,
): Task<JsonValue | undefined> {
  try {
    return yield* readJsonDocumentValue(reader, events, receiver, options);
  } catch (error) {
    if (isJsonBaseSyntaxError(error)) {
      reportCaused(
        receiver,
        { code: 'VALIDATION_ERROR', message: error.message, dataPosition: error.position },
        error,
      );
      return undefined;
    }
    throw error;
  }
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
 * pass rather than stopping at the first — a base-syntax failure (malformed UTF-8, a bad token, a
 * §3.1 grammar violation) is reported through `diagnostics` exactly like any other, per this
 * module's own top note; only a §10.1 nesting-limit refusal still throws.
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
