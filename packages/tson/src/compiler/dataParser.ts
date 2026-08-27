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

import { TsonInternalError } from '../core/errors.js';
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
export function* parseDocument(input: ByteInput): Task<ParsedDocument> {
  const source = createDataStream(input);
  const positions = new WeakMap<CoreValue, Position>();
  const recorder: PositionRecorder = (value, position) => positions.set(value, position);

  const start = yield* source.next();
  if (start.kind !== 'document-start') {
    throw new TsonInternalError(`expected document-start, got '${start.kind}'`);
  }

  const root = yield* parseDataValue(source, recorder);

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
export function* parseDataValue(
  source: EventSource,
  recorder: PositionRecorder = noopRecorder,
): Task<DataValue> {
  const annotations: Annotation[] = [];
  for (;;) {
    const peeked = yield* source.peek();
    if (peeked.kind !== 'annotation-start') break;
    annotations.push(yield* parseAnnotation(source, recorder));
  }

  let typeRef: string | undefined;
  const afterAnnotations = yield* source.peek();
  if (afterAnnotations.kind === 'type-ref') {
    yield* source.next();
    typeRef = afterAnnotations.name;
  }

  const coreValue = yield* parseCoreValue(source, recorder);
  return {
    annotations,
    ...(typeRef !== undefined ? { typeRef } : {}),
    coreValue,
  };
}

/** `"@" unquoted-token [ ":" data-value ]` (§3.1, §7.4): one annotation, with or without a value. */
export function* parseAnnotation(
  source: EventSource,
  recorder: PositionRecorder = noopRecorder,
): Task<Annotation> {
  const start = yield* source.next();
  if (start.kind !== 'annotation-start') {
    throw new TsonInternalError(`expected annotation-start, got '${start.kind}'`);
  }

  let value: DataValue | undefined;
  const peeked = yield* source.peek();
  if (peeked.kind !== 'annotation-end') {
    value = yield* parseDataValue(source, recorder);
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
export function* parseCoreValue(
  source: EventSource,
  recorder: PositionRecorder = noopRecorder,
): Task<CoreValue> {
  const event = yield* source.next();
  const value = yield* reduceCoreEvent(source, event, recorder);
  recorder(value, event.position);
  return value;
}

function* reduceCoreEvent(
  source: EventSource,
  event: TsonEvent,
  recorder: PositionRecorder,
): Task<CoreValue> {
  switch (event.kind) {
    case 'token':
      return { kind: 'token', text: event.text, form: event.form } satisfies TokenValue;
    case 'absent':
      return { kind: 'absent' } satisfies AbsentValue;
    case 'empty-brace':
      return { kind: 'empty-brace' } satisfies EmptyBrace;
    case 'record-start':
      return yield* parseRecord(source, recorder);
    case 'map-start':
      return yield* parseMap(source, recorder);
    case 'array-start':
      return yield* parseArray(source, recorder);
    default:
      throw new TsonInternalError(`unexpected event reducing a core-value: '${event.kind}'`);
  }
}

/** `record = "{" ws field *( separator field ) ws "}"` (§2.5, §7.4). `record-start` already consumed. */
function* parseRecord(source: EventSource, recorder: PositionRecorder): Task<RecordValue> {
  const fields: RecordField[] = [];
  for (;;) {
    const event = yield* source.next();
    if (event.kind === 'record-end') break;
    if (event.kind !== 'field-name') {
      throw new TsonInternalError(`expected field-name or record-end, got '${event.kind}'`);
    }
    const value = yield* parseScopedValue(source, recorder);
    fields.push({ name: event.name, value });
  }
  return { kind: 'record', fields };
}

/** `map = "{" ws map-entry *( separator map-entry ) ws "}"` (§2.6, §7.4). `map-start` already consumed. */
function* parseMap(source: EventSource, recorder: PositionRecorder): Task<MapValue> {
  const entries: MapEntry[] = [];
  for (;;) {
    const peeked = yield* source.peek();
    if (peeked.kind === 'map-end') {
      yield* source.next();
      break;
    }
    const key = yield* parseDataValue(source, recorder);
    const arrow = yield* source.next();
    if (arrow.kind !== 'map-arrow') {
      throw new TsonInternalError(`expected map-arrow, got '${arrow.kind}'`);
    }
    const value = yield* parseScopedValue(source, recorder);
    entries.push({ key, value });
  }
  return { kind: 'map', entries };
}

/** `array = "[" ws [ scoped-value *( separator scoped-value ) ] ws "]"` (§2.7, §7.4). `array-start` already consumed. */
function* parseArray(source: EventSource, recorder: PositionRecorder): Task<ArrayValue> {
  const elements: ScopedValue[] = [];
  for (;;) {
    const peeked = yield* source.peek();
    if (peeked.kind === 'array-end') {
      yield* source.next();
      break;
    }
    elements.push(yield* parseScopedValue(source, recorder));
  }
  return { kind: 'array', elements };
}

/** `scoped-value = [ schema-directive ws ] data-value` (§2.3, §7.4). */
function* parseScopedValue(source: EventSource, recorder: PositionRecorder): Task<ScopedValue> {
  const peeked = yield* source.peek();
  let schemaRef: string | undefined;
  if (peeked.kind === 'schema-ref') {
    yield* source.next();
    schemaRef = peeked.uri;
  }
  const value = yield* parseDataValue(source, recorder);
  return {
    ...(schemaRef !== undefined ? { schemaRef } : {}),
    value,
  };
}
