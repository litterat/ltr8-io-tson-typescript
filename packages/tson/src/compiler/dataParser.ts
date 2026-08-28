/**
 * Tier 3: builds a full {@link Document} AST (§2, §3, §7.4) by pulling {@link TsonEvent}s from
 * Wave 1's Tier 2 {@link EventSource} and reducing that flat sequence back into the nested `ast`
 * tree ({@link RecordValue}, {@link MapValue}, {@link ArrayValue}, {@link EmptyBrace},
 * {@link AbsentValue}, {@link TokenValue}). This module holds no independent implementation of
 * the data grammar — `stream/dataStream.js` is the one place that walks source text and resolves
 * things like `{}` record/map disambiguation; everything here is reduction (event sequence ->
 * tree), the streaming counterpart of a DOM builder sitting on top of a SAX/StAX reader.
 *
 * Pulled directly from the {@link EventSource}, one value at a time, rather than buffered into a
 * flat list first: memory stays proportional to nesting depth (the `yield*` delegation chain is
 * itself the frame stack), matching the streaming guarantee the lexer and event stream already
 * give. The `ast` tree this produces is still fully materialized once built — unlike the layers
 * below it, a `Document` has no smaller unit a caller could ask for instead — but nothing here
 * ever holds more than one open container's worth of un-reduced event state at a time.
 *
 * `!!meta` in the header is already rejected by `stream/dataStream.js` before this module ever
 * sees an event, so a schema document never reaches here as a `Document` at all.
 */

import { TsonInternalError, TsonParseError } from '../core/errors.js';
import {
  maxNestingDepthOf,
  nestingLimitExpectation,
  nestingLimitMessage,
  type NestingLimitOptions,
} from '../core/limits.js';
import type { Position } from '../core/position.js';
import type { ByteInput, Task } from '../io/bytes.js';
import { createDataStream } from '../stream/dataStream.js';
import type { EventSource, TsonEvent } from '../stream/event.js';
import type {
  AbsentValue,
  Annotation,
  ArrayValue,
  CoreValue,
  DataValue,
  Document,
  EmptyBrace,
  MapEntry,
  MapValue,
  RecordField,
  RecordValue,
  ScopedValue,
  TokenValue,
} from '../ast/value.js';

/**
 * Records a freshly built {@link CoreValue}'s own start {@link Position}. Called exactly once
 * per {@link CoreValue}, at the point it is constructed (see {@link parseCoreValue}).
 */
export type PositionRecorder = (value: CoreValue, position: Position) => void;
const noopRecorder: PositionRecorder = () => {
  // No position tracking wanted by this caller.
};

/** What a caller may configure about a parse. */
export interface ParseOptions extends NestingLimitOptions {
  /**
   * Where each freshly built {@link CoreValue}'s start position goes. Defaults to discarding
   * them, so a caller that does not track positions need not thread a `WeakMap` through.
   */
  readonly recorder?: PositionRecorder;
}

/**
 * A parse's settled options, threaded through every production below beside the depth.
 *
 * A parameter rather than state on some shared object, and the depth alongside it rather than a
 * counter someone increments: two suspended `Task`s over different documents interleave freely,
 * and shared mutable depth would have them counting each other's nesting.
 */
interface ParseContext {
  readonly recorder: PositionRecorder;
  readonly maxNestingDepth: number;
}

function contextOf(options?: ParseOptions): ParseContext {
  return {
    recorder: options?.recorder ?? noopRecorder,
    maxNestingDepth: maxNestingDepthOf(options),
  };
}

/**
 * The result of {@link parseDocument}: the tree, plus every {@link CoreValue}'s own start
 * position.
 *
 * `positions` is keyed by reference identity — a `WeakMap`, never a structural map keyed by
 * `CoreValue`'s content. Every `CoreValue` implementor here is a plain object compared
 * structurally everywhere else in this codebase (equality-based fixtures, `toEqual` in tests), so
 * a `position` field on the value itself would flow straight into every structural comparison and
 * break every hand-built fixture that constructs one directly — exactly why the Java reference
 * keeps this table separate, keyed by an `IdentityHashMap`. Identity keying is also the only
 * *correct* choice, not merely a safe one: two structurally-identical-but-distinct values (two
 * array elements that are both the literal token `42`) are two different occurrences and must not
 * collide, which is exactly what `===`-keyed lookup guarantees and content-equality lookup would
 * not. This is sound only because every `CoreValue` this parser builds is a fresh object at its
 * own occurrence, never cached or reused as a singleton.
 */
export interface ParsedDocument {
  readonly document: Document;
  readonly positions: WeakMap<CoreValue, Position>;
}

/**
 * Builds the whole {@link Document} AST from `input`'s TSON bytes (§2.2, §7.4).
 *
 * Pulls events all the way to the stream's own `document-end` — reaching the end of the root
 * value is not the same as reaching the end of the *document* (§7.1 requires the difference to be
 * observable: `{ x: 1 } junk` is trailing content, not a second value). The pull is what performs
 * that check, not an assertion added afterwards: `stream/dataStream.js`'s own root frame raises
 * {@link TsonParseError} the moment it is asked for one more event past the root value and finds
 * the document is not actually over. A caller that built the root and stopped there — never
 * asking the stream for anything past it — would silently accept any trailing content, which is
 * exactly the trap: nothing fails on its own from merely *stopping* a lazy pull-based stream
 * early.
 */
export function* parseDocument(
  input: ByteInput,
  options?: NestingLimitOptions,
): Task<ParsedDocument> {
  const source = createDataStream(input);
  const positions = new WeakMap<CoreValue, Position>();
  const ctx = contextOf({
    ...options,
    recorder: (value, position) => positions.set(value, position),
  });

  const start = yield* source.next();
  if (start.kind !== 'document-start') {
    throw new TsonInternalError(`expected document-start, got '${start.kind}'`);
  }

  const root = yield* dataValue(source, ctx, 0);

  const end = yield* source.next(); // the pull that makes trailing content observable (§7.1)
  if (end.kind !== 'document-end') {
    throw new TsonInternalError(`expected document-end, got '${end.kind}'`);
  }

  const document: Document = {
    ...(start.id !== undefined ? { id: start.id } : {}),
    ...(start.schema !== undefined ? { schema: start.schema } : {}),
    root,
  };
  return { document, positions };
}

// ── Shared reduction entry points ───────────────────────────────────────────────────────────
//
// Exposed at data-value/core-value/annotation granularity, not only at document scope — the same
// seam the Java reference's package-private forwards give `TsonSchemaParser`: Part 2's schema
// grammar (§12.1) imports Part 1's `annotation`/`data-value` productions directly rather than
// re-implementing them, and this is where such a caller would pull from. `recorder` defaults to a
// no-op so a caller that doesn't track positions doesn't need to thread a `WeakMap` through.

/** `data-value = *annotation [type-ref] core-value` (§2.3, §7.4). */
export function* parseDataValue(source: EventSource, options?: ParseOptions): Task<DataValue> {
  return yield* dataValue(source, contextOf(options), 0);
}

function* dataValue(source: EventSource, ctx: ParseContext, depth: number): Task<DataValue> {
  // Checked here, on the way *down*, and not only in `coreValueAt` at the bottom of the descent.
  // An annotation chain (`@a:@a:@a:...`) recurses through this function once per annotation and
  // reaches a core value only at the very end, so a bottom-only check is reached with the host
  // stack already spent -- which is exactly how a 2,000-annotation document produced a RangeError
  // while a 700-annotation one produced the intended diagnostic.
  yield* guardDepth(source, ctx, depth);
  const annotations: Annotation[] = [];
  for (;;) {
    const peeked = yield* source.peek();
    if (peeked.kind !== 'annotation-start') break;
    // `depth + 1`, and neither `depth` nor `0`. An annotation's value is a data value in its own
    // right, so `@a:@a:@a:...` recurses through this function once per annotation with no
    // structural nesting at all to count -- and this used to pass `0`, which reset the counter at
    // every annotation, so even a nesting chain walked straight past the bound into the host's
    // own stack limit and out of `parse` as an uncaught RangeError.
    annotations.push(yield* annotation(source, ctx, depth + 1));
  }

  let typeRef: string | undefined;
  const afterAnnotations = yield* source.peek();
  if (afterAnnotations.kind === 'type-ref') {
    yield* source.next();
    typeRef = afterAnnotations.name;
  }

  const coreValue = yield* coreValueAt(source, ctx, depth);
  return {
    annotations,
    ...(typeRef !== undefined ? { typeRef } : {}),
    coreValue,
  };
}

/** `"@" unquoted-token [ ":" data-value ]` (§3.1, §7.4): one annotation, with or without a value. */
export function* parseAnnotation(source: EventSource, options?: ParseOptions): Task<Annotation> {
  return yield* annotation(source, contextOf(options), 0);
}

function* annotation(source: EventSource, ctx: ParseContext, depth: number): Task<Annotation> {
  const start = yield* source.next();
  if (start.kind !== 'annotation-start') {
    throw new TsonInternalError(`expected annotation-start, got '${start.kind}'`);
  }

  let value: DataValue | undefined;
  const peeked = yield* source.peek();
  if (peeked.kind !== 'annotation-end') {
    value = yield* dataValue(source, ctx, depth);
  }

  const end = yield* source.next();
  if (end.kind !== 'annotation-end') {
    throw new TsonInternalError(`expected annotation-end, got '${end.kind}'`);
  }

  return {
    name: start.name,
    ...(value !== undefined ? { value } : {}),
  };
}

/**
 * `core-value = record / map / array / empty-brace / absent / token` (§2.3, §7.4).
 *
 * Records the value's own start position via `recorder` before returning it — the one place a
 * fresh {@link CoreValue} comes into existence, so the one place its position can be captured
 * unambiguously (see {@link ParsedDocument.positions}).
 */
export function* parseCoreValue(source: EventSource, options?: ParseOptions): Task<CoreValue> {
  return yield* coreValueAt(source, contextOf(options), 0);
}

/** Refuses a document that has nested past this parse's limit (§9.1), positioned at what comes next. */
function* guardDepth(source: EventSource, ctx: ParseContext, depth: number): Task<void> {
  if (depth < ctx.maxNestingDepth) return;
  const here = yield* source.peek();
  throw new TsonParseError(nestingLimitMessage(ctx.maxNestingDepth), here.position, {
    expected: nestingLimitExpectation(ctx.maxNestingDepth),
    actual: 'deeper',
  });
}

function* coreValueAt(source: EventSource, ctx: ParseContext, depth: number): Task<CoreValue> {
  yield* guardDepth(source, ctx, depth);
  const event = yield* source.next();
  const value = yield* reduceCoreEvent(source, event, ctx, depth);
  ctx.recorder(value, event.position);
  return value;
}

function* reduceCoreEvent(
  source: EventSource,
  event: TsonEvent,
  ctx: ParseContext,
  depth: number,
): Task<CoreValue> {
  switch (event.kind) {
    case 'token':
      return { kind: 'token', text: event.text, form: event.form } satisfies TokenValue;
    case 'absent':
      return { kind: 'absent' } satisfies AbsentValue;
    case 'empty-brace':
      return { kind: 'empty-brace' } satisfies EmptyBrace;
    case 'record-start':
      return yield* parseRecord(source, ctx, depth + 1);
    case 'map-start':
      return yield* parseMap(source, ctx, depth + 1);
    case 'array-start':
      return yield* parseArray(source, ctx, depth + 1);
    default:
      throw new TsonInternalError(`unexpected event reducing a core-value: '${event.kind}'`);
  }
}

/** `record = "{" ws field *( separator field ) ws "}"` (§2.5, §7.4). `record-start` already consumed. */
function* parseRecord(source: EventSource, ctx: ParseContext, depth: number): Task<RecordValue> {
  const fields: RecordField[] = [];
  for (;;) {
    const event = yield* source.next();
    if (event.kind === 'record-end') break;
    if (event.kind !== 'field-name') {
      throw new TsonInternalError(`expected field-name or record-end, got '${event.kind}'`);
    }
    const value = yield* parseScopedValue(source, ctx, depth);
    fields.push({ name: event.name, value });
  }
  return { kind: 'record', fields };
}

/** `map = "{" ws map-entry *( separator map-entry ) ws "}"` (§2.6, §7.4). `map-start` already consumed. */
function* parseMap(source: EventSource, ctx: ParseContext, depth: number): Task<MapValue> {
  const entries: MapEntry[] = [];
  for (;;) {
    const peeked = yield* source.peek();
    if (peeked.kind === 'map-end') {
      yield* source.next();
      break;
    }
    const key = yield* dataValue(source, ctx, depth);
    const arrow = yield* source.next();
    if (arrow.kind !== 'map-arrow') {
      throw new TsonInternalError(`expected map-arrow, got '${arrow.kind}'`);
    }
    const value = yield* parseScopedValue(source, ctx, depth);
    entries.push({ key, value });
  }
  return { kind: 'map', entries };
}

/** `array = "[" ws [ scoped-value *( separator scoped-value ) ] ws "]"` (§2.7, §7.4). `array-start` already consumed. */
function* parseArray(source: EventSource, ctx: ParseContext, depth: number): Task<ArrayValue> {
  const elements: ScopedValue[] = [];
  for (;;) {
    const peeked = yield* source.peek();
    if (peeked.kind === 'array-end') {
      yield* source.next();
      break;
    }
    elements.push(yield* parseScopedValue(source, ctx, depth));
  }
  return { kind: 'array', elements };
}

/** `scoped-value = [ schema-directive ws ] data-value` (§2.3, §7.4). */
function* parseScopedValue(
  source: EventSource,
  ctx: ParseContext,
  depth: number,
): Task<ScopedValue> {
  const peeked = yield* source.peek();
  let schemaRef: string | undefined;
  if (peeked.kind === 'schema-ref') {
    yield* source.next();
    schemaRef = peeked.uri;
  }
  const value = yield* dataValue(source, ctx, depth);
  return {
    ...(schemaRef !== undefined ? { schemaRef } : {}),
    value,
  };
}
