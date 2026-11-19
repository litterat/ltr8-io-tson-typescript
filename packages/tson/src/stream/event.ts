import type { Position } from '../core/position.js';
import type { Task } from '../io/bytes.js';
import type { CoreReference } from '../ast/reference.js';
import type { TokenForm } from '../lexer/token.js';

/**
 * One structural event in Tier 2's flat, pull-based decomposition of a data document (§2, §3,
 * §7.4) — the streaming counterpart to `ast/value.js`'s nested `Document`/`DataValue` tree. A
 * data stream emits these lazily, one token of lookahead at a time (two, only to resolve the
 * `{}` record/map ambiguity, §2.8), so a consumer can rebuild the identical structure Tier 3
 * builds without ever holding more than one open container's worth of state in memory.
 *
 * Every value position (document root, record field, map key/value, array element, an
 * annotation's own value) has the same self-delimiting shape in the stream: zero or more
 * {@link AnnotationStart}/{@link AnnotationEnd} pairs, an optional {@link TypeRef}, then exactly
 * one core-value — either a single leaf event ({@link TokenEvent}, {@link ReferenceEvent},
 * {@link VoidEvent}, {@link EmptyBraceEvent}) or a matched {@link RecordStart}/{@link RecordEnd},
 * {@link MapStart}/{@link MapEnd}, or {@link ArrayStart}/{@link ArrayEnd} pair.
 *
 * Discriminated on `kind`; every member carries a `position`.
 */
export type TsonEvent =
  | DocumentStart
  | DocumentEnd
  | AnnotationStart
  | AnnotationEnd
  | TypeRef
  | RecordStart
  | FieldName
  | RecordEnd
  | MapStart
  | MapArrow
  | MapEnd
  | ArrayStart
  | ArrayEnd
  | TokenEvent
  | ReferenceEvent
  | VoidEvent
  | EmptyBraceEvent;

/**
 * Opens the event stream: the document's header directives (§2.2) — its `!!id` and its `!!import`s
 * in header order, the raw URI arguments, uninterpreted — exactly as `ast.Document` carries them.
 * Always the first event.
 *
 * The header does not classify a document: a schema document is one whose root is tagged `!schema`
 * (§2.2), which the events after this one say, and which {@link DataStream.rootTag} reads without
 * consuming anything. A retired or unknown directive, or one out of place, is refused before this
 * or any other event is produced.
 */
export interface DocumentStart {
  readonly kind: 'document-start';
  readonly id?: string;
  readonly imports: readonly string[];
  readonly position: Position;
}

/**
 * The root tag that makes a document a schema document (§2.2): the kernel root's `schema`,
 * whatever the document imports. The tag says what the document is before any import is read, so
 * classification matches this spelling rather than looking a name up.
 */
export const SCHEMA_TAG = 'schema';

/** Whether `rootTag`, a root's tag or its absence, makes the document a schema document (§2.2). */
export function isSchemaTag(rootTag: string | undefined): boolean {
  return rootTag === SCHEMA_TAG;
}

/** Closes the event stream, once the document's root value is complete and only end-of-input remains. */
export interface DocumentEnd {
  readonly kind: 'document-end';
  readonly position: Position;
}

/**
 * `"@" qualified-name-token [ ":" data-value ]` (§3.1): opens one annotation. If the annotation
 * carries a value, that value's own event sequence follows immediately; either way an
 * {@link AnnotationEnd} closes it before the next sibling annotation, an optional
 * {@link TypeRef}, or the enclosing value's core-value.
 */
export interface AnnotationStart {
  readonly kind: 'annotation-start';
  readonly name: string;
  readonly position: Position;
}

/** Closes an {@link AnnotationStart}. */
export interface AnnotationEnd {
  readonly kind: 'annotation-end';
  readonly position: Position;
}

/**
 * `"!" qualified-name-token` (§3.2): a value's type reference, preserved uninterpreted — resolving
 * it against the built-in type vocabulary (§5) or a declared schema is a later layer's job. No
 * matching end event: a type reference is a qualified name, never a nested value.
 */
export interface TypeRef {
  readonly kind: 'type-ref';
  readonly name: string;
  readonly position: Position;
}

/**
 * Opens a `record` (§2.5). Field order in the stream is preserved and duplicates are not
 * detected here — a resolver-layer concern, the same deferral `ast.RecordValue` documents.
 */
export interface RecordStart {
  readonly kind: 'record-start';
  readonly position: Position;
}

/** One record field's name (§2.5, §7.4): announces the field; its data-value events follow immediately. */
export interface FieldName {
  readonly kind: 'field-name';
  readonly name: string;
  readonly position: Position;
}

/** Closes a {@link RecordStart}. */
export interface RecordEnd {
  readonly kind: 'record-end';
  readonly position: Position;
}

/**
 * Opens a `map` (§2.6). Entry order in the stream is preserved and duplicate keys are not
 * detected or deduplicated here — a resolver-layer concern, the same deferral `ast.MapValue`
 * documents.
 */
export interface MapStart {
  readonly kind: 'map-start';
  readonly position: Position;
}

/** `"=>"` (§2.6, §7.2.4): marks the transition from a map entry's key events to its value events. */
export interface MapArrow {
  readonly kind: 'map-arrow';
  readonly position: Position;
}

/** Closes a {@link MapStart}. */
export interface MapEnd {
  readonly kind: 'map-end';
  readonly position: Position;
}

/** Opens an `array` (§2.7). Never ambiguous with a record/map — `[` is unmistakable. */
export interface ArrayStart {
  readonly kind: 'array-start';
  readonly position: Position;
}

/** Closes an {@link ArrayStart}. Elements are back-to-back data-value event sequences, no per-element marker. */
export interface ArrayEnd {
  readonly kind: 'array-end';
  readonly position: Position;
}

/**
 * A leaf `token` core-value (§2.4, §7.4) — the streaming counterpart to `ast.TokenValue`,
 * reusing the same {@link TokenForm}. `text` is already escape-decoded and, for multi-line
 * tokens, common-indentation-stripped; unresolved and uninterpreted.
 */
export interface TokenEvent {
  readonly kind: 'token';
  readonly text: string;
  readonly form: TokenForm;
  readonly position: Position;
}

/**
 * A `reference` core-value (§7.4) that is no bare name, assembled whole by the stream and delivered as
 * one value: a qualified name with an adjacent argument list, `geo.address<T>` or
 * `map<text list<int32>>`, or a sibling reference, `kind!`. A qualified name without arguments is a
 * {@link TokenEvent}, and a reader at a reference-typed position rolls either into one reference.
 *
 * One event, not a pair: an argument is a reference or a token and never a structure, so a reference
 * is small, and assembling it before it is emitted keeps every reader, skip and replay treating it
 * as the one value it is. `reference` carries each argument as the grammar classified it.
 */
export interface ReferenceEvent {
  readonly kind: 'reference';
  readonly reference: CoreReference;
  readonly position: Position;
}

/** `"_"` (§2.9): the explicitly-void sentinel, the format's one spelling of absence and distinct from every typed value -- including the unquoted token `null`, an ordinary string under base type resolution (§4.4). */
export interface VoidEvent {
  readonly kind: 'void';
  readonly position: Position;
}

/**
 * `"{" ws "}"` (§2.8): deliberately its own event, not resolved to an empty record or map here —
 * the same deferral to a later layer that `ast.EmptyBrace` documents.
 */
export interface EmptyBraceEvent {
  readonly kind: 'empty-brace';
  readonly position: Position;
}

/**
 * A pull-based {@link TsonEvent} source with one event of lookahead — the contract the
 * schema-compiled reader stack consumes directly, rather than depending on a concrete streaming
 * implementation.
 *
 * Both methods return a {@link Task}: the whole read stack is suspendable-but-sync-shaped (see
 * `io/bytes.js`), and a source backed by real, possibly-incomplete input can starve mid-event.
 * `peek` observes the next event without consuming it — repeated calls with no intervening
 * `next()` yield the same event.
 */
export interface EventSource {
  /** Consumes and returns the next event. */
  next(): Task<TsonEvent>;
  /** Returns the next event without consuming it. */
  peek(): Task<TsonEvent>;
}
