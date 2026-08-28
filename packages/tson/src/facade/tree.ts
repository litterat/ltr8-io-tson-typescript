/**
 * `readTree`/`validate` -- the recommended default read: a whole document into a `tree/nodes.ts`
 * {@link Value} (structure-preserving, typed leaves, null-safe navigation), schema-governed when
 * a {@link CompiledSchema} is supplied (§4-§6) and schemaless otherwise (§4's base-type
 * vocabulary alone, Class 1). Mirrors the reference implementation's own front door
 * (`Tson#treeReader`/`Tson#validate`): "the recommended default... no Java class per schema
 * type."
 *
 * **Both share one whole-document framing**, {@link readWholeDocument} below: consume
 * `document-start`, read the root value through whichever `TypeReader<Value>` {@link
 * pickReader} selects, then consume `document-end` -- reported, not thrown, when the cursor finds
 * unconsumed content there, so a collecting read still gets everything the root value itself
 * found. This is `compiler/compile.ts`'s own `readValue` generalised over *any* `TypeReader<Value>`
 * rather than only a `CompiledSchema`'s, so the schemaless branch (`reader/schemaless/tree.ts`'s
 * own `schemalessTreeReader`, which owns no document-level framing of its own either) gets the
 * identical trailing-content check the schema-governed branch already had. Kept as this module's
 * own copy rather than exported from `compile.ts` and reused: `compile.ts` is `compiler/`-zoned
 * frozen work from an earlier wave, and duplicating nine lines here costs less than editing it.
 *
 * `readTree` throws {@link TsonReadError} at the first problem (the fail-fast counterpart);
 * `validate` collects every one and always returns a value, `diagnostics` empty meaning the
 * document conforms -- `compile.ts`'s own `read`/`validate` split, generalised the same way.
 *
 * **Both hold to that split even for a failure raised before any reader is running.** A document
 * that will not lex or parse, and a construct this library has no reader for, are both routed
 * through the receiver by {@link readWholeDocument} rather than thrown past it; see its own note
 * for why each keeps a distinct diagnostic code. Without that, `validate` threw for exactly the
 * documents a caller reached for a collecting read to handle.
 */
import type { ByteInput, Task } from '../io/bytes.js';
import {
  collector,
  throwing,
  type Diagnostic,
  type DiagnosticsReceiver,
} from '../core/diagnostic.js';
import {
  TsonInternalError,
  TsonLexError,
  TsonNotImplementedError,
  TsonParseError,
  TsonReadError,
  TsonUnsupportedDocumentError,
} from '../core/errors.js';
import { createDataStream } from '../stream/dataStream.js';
import { createReadContext } from '../reader/context.js';
import type { ReadContext, TypeReader } from '../reader/contracts.js';
import {
  schemalessTreeReader,
  type SchemalessTreeReaderOptions,
} from '../reader/schemaless/index.js';
import type { CompiledSchema, ValidationResult } from '../compiler/compile.js';
import { missingNode, type Value } from '../tree/nodes.js';
import {
  runOverAsyncSource,
  runOverBytes,
  type AsyncByteSource,
  type ByteSource,
} from './byteSource.js';

export type { CompiledSchema, ValidationResult } from '../compiler/compile.js';

/** Reads `rootName` from a {@link CompiledSchema} already built (`compile()`, `@ltr8/tson/schema`'s resolve/link pipeline, or `createTson`'s own `compile`). */
export interface SchemaGovernedReadOptions {
  readonly schema: CompiledSchema;
  readonly root: string;
}

/** No schema in scope -- Class 1 reading, `reader/schemaless/tree.ts`'s own contract. */
export interface SchemalessReadOptions extends SchemalessTreeReaderOptions {
  readonly schema?: undefined;
}

export type ReadTreeOptions = SchemaGovernedReadOptions | SchemalessReadOptions;

function pickReader(options: ReadTreeOptions | undefined): TypeReader<Value> {
  if (options?.schema !== undefined) {
    return options.schema.reader(options.root);
  }
  return schemalessTreeReader(
    options?.preserveUnknownTypeRefs === undefined
      ? {}
      : { preserveUnknownTypeRefs: options.preserveUnknownTypeRefs },
  );
}

/**
 * A failure the lexer or the event stream raises **before** any {@link ReadContext} exists to
 * report through: malformed UTF-8, an unlexable token, a structural violation of §2's grammar, or
 * a document this implementation will not read at all (a declared encoding other than UTF-8).
 * Everything a *reader* finds already goes through the receiver; these three do not, because at
 * the point they are raised there is nothing to go through yet.
 */
function isBaseSyntaxError(
  error: unknown,
): error is TsonLexError | TsonParseError | TsonUnsupportedDocumentError {
  return (
    error instanceof TsonLexError ||
    error instanceof TsonParseError ||
    error instanceof TsonUnsupportedDocumentError
  );
}

/**
 * The root value handed back for a document that produced none. `''` is the RFC 6901 pointer for
 * the document root, and it is deliberately not `undefined`: `''` is a *valid* pointer meaning
 * exactly "the root", where `undefined` would mean "no location at all".
 */
function noRootValue(): Value {
  return missingNode('');
}

/**
 * Reports `diagnostic`, and — if the receiver answers by throwing, which is what a fail-fast read
 * does — attaches `cause` to that error on its way out. {@link DiagnosticsReceiver} passes only a
 * diagnostic, so this is the one place the original error can stay attached to the throw it
 * produced, which is what lets a caller who wants the narrower `TsonLexError` back still reach it.
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

/** {@link compiler/compile.ts}'s own `readValue`, generalised over any `TypeReader<Value>` -- see this module's own top note. */
function* readDocumentValue(
  reader: TypeReader<Value>,
  input: ByteInput,
  receiver: DiagnosticsReceiver,
): Task<Value> {
  const events = createDataStream(input);
  const ctx: ReadContext = createReadContext(events, receiver);
  const start = yield* ctx.next();
  if (start.kind !== 'document-start') {
    throw new TsonInternalError(
      `expected the event stream to open with 'document-start', found '${start.kind}' -- this is ` +
        'an event-stream invariant, not a document problem',
    );
  }
  const value = yield* reader.read(ctx);
  const end = yield* ctx.next();
  if (end.kind !== 'document-end') {
    ctx.report(
      'VALIDATION_ERROR',
      'the document carries content after its root value, which the read did not consume',
      'end of document',
      end.kind,
    );
  }
  return value;
}

/**
 * {@link readDocumentValue} with the two failures that would otherwise escape a collecting read
 * routed through the receiver instead — so `validate()` really does hold to its own contract that
 * an empty `diagnostics` means the document conforms, and a non-empty one is the whole story. The
 * reference implementation's facade documents the same behaviour ("both facades catch a document
 * that will not lex or parse ... a collecting read never throws for a bad document").
 *
 * Two, not one:
 *
 * - **A base-syntax failure** ({@link isBaseSyntaxError}) is a verdict on the document, and
 *   reaches the receiver as `VALIDATION_ERROR` carrying the position the error already knew.
 * - **{@link TsonNotImplementedError}** is a verdict on *this library*, and reaches it as
 *   `NOT_IMPLEMENTED` — the code `core/diagnostic.ts` defines for exactly that ("a library gap,
 *   not bad input"). It escapes at read time rather than at compile time because
 *   `compiler/compile.ts` builds each entry's reader lazily, so a construct with no reader yet is
 *   discovered only when a value of that type is actually read. A caller must still be able to
 *   tell it apart from a document that is genuinely invalid, which is why it keeps its own code
 *   rather than being folded into `VALIDATION_ERROR`.
 *
 * Neither is swallowed: a fail-fast read's receiver ({@link throwing}) turns the diagnostic
 * straight back into a throw, so `readTree` still stops at the first problem — as one
 * {@link TsonReadError}, with the original error as its `cause`, which is what its own TSDoc
 * has always claimed it raises.
 *
 * Anything else — {@link TsonInternalError} above all — propagates untouched. A broken invariant
 * is not a diagnostic about the document, and reporting one as though it were would tell a caller
 * their input was bad when the bug is here.
 */
function* readWholeDocument(
  reader: TypeReader<Value>,
  input: ByteInput,
  receiver: DiagnosticsReceiver,
): Task<Value> {
  try {
    return yield* readDocumentValue(reader, input, receiver);
  } catch (error) {
    if (isBaseSyntaxError(error)) {
      reportCaused(
        receiver,
        { code: 'VALIDATION_ERROR', message: error.message, dataPosition: error.position },
        error,
      );
      return noRootValue();
    }
    if (error instanceof TsonNotImplementedError) {
      reportCaused(receiver, { code: 'NOT_IMPLEMENTED', message: error.message }, error);
      return noRootValue();
    }
    throw error;
  }
}

function readTreeTask(
  options: ReadTreeOptions | undefined,
  receiver: DiagnosticsReceiver,
): (input: ByteInput) => Task<Value> {
  const reader = pickReader(options);
  return (input: ByteInput): Task<Value> => readWholeDocument(reader, input, receiver);
}

/**
 * Reads `source` as a whole document into a {@link Value} tree, throwing {@link TsonReadError} at
 * the first problem. Schemaless with no `options.schema`; validated against `options.schema`'s
 * `options.root` entry otherwise.
 *
 * Synchronous for a complete `Uint8Array`; a streaming `source` returns a `Promise` instead.
 */
export function readTree(source: Uint8Array, options?: ReadTreeOptions): Value;
export function readTree(source: AsyncByteSource, options?: ReadTreeOptions): Promise<Value>;
export function readTree(source: ByteSource, options?: ReadTreeOptions): Value | Promise<Value> {
  const receiver = throwing((diagnostic) => new TsonReadError(diagnostic));
  const makeTask = readTreeTask(options, receiver);
  return source instanceof Uint8Array
    ? runOverBytes(source, makeTask)
    : runOverAsyncSource(source, makeTask);
}

/**
 * Reads `source` as a whole document into a {@link Value} tree, collecting every problem rather
 * than stopping at the first -- an empty `diagnostics` means the document conforms. Schemaless
 * with no `options.schema`; validated against `options.schema`'s `options.root` entry otherwise.
 *
 * Synchronous for a complete `Uint8Array`; a streaming `source` returns a `Promise` instead.
 */
export function validate(source: Uint8Array, options?: ReadTreeOptions): ValidationResult;
export function validate(
  source: AsyncByteSource,
  options?: ReadTreeOptions,
): Promise<ValidationResult>;
export function validate(
  source: ByteSource,
  options?: ReadTreeOptions,
): ValidationResult | Promise<ValidationResult> {
  const diagnostics = collector();
  const makeTask = readTreeTask(options, diagnostics);
  if (source instanceof Uint8Array) {
    return { value: runOverBytes(source, makeTask), diagnostics: diagnostics.diagnostics };
  }
  return runOverAsyncSource(source, makeTask).then((value) => ({
    value,
    diagnostics: diagnostics.diagnostics,
  }));
}
