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
 */
import type { ByteInput, Task } from '../io/bytes.js';
import { collector, throwing, type DiagnosticsReceiver } from '../core/diagnostic.js';
import { TsonInternalError, TsonReadError } from '../core/errors.js';
import { createDataStream } from '../stream/dataStream.js';
import { createReadContext } from '../reader/context.js';
import type { ReadContext, TypeReader } from '../reader/contracts.js';
import {
  schemalessTreeReader,
  type SchemalessTreeReaderOptions,
} from '../reader/schemaless/index.js';
import type { CompiledSchema, ValidationResult } from '../compiler/compile.js';
import type { Value } from '../tree/nodes.js';
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

/** {@link compiler/compile.ts}'s own `readValue`, generalised over any `TypeReader<Value>` -- see this module's own top note. */
function* readWholeDocument(
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
