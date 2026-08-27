import type { Position } from '../core/position.js';
import type { Task } from '../io/bytes.js';
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
 * one core-value — either a single leaf event ({@link TokenEvent}, {@link AbsentEvent},
 * {@link EmptyBraceEvent}) or a matched {@link RecordStart}/{@link RecordEnd},
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
  | SchemaRef
  | RecordStart
  | FieldName
  | RecordEnd
  | MapStart
  | MapArrow
  | MapEnd
  | ArrayStart
  | ArrayEnd
  | TokenEvent
  | AbsentEvent
  | EmptyBraceEvent;

/**
 * Opens the event stream: the document's header directives (§2.2) — `id`/`schema`, the raw URI
 * arguments, uninterpreted — exactly as `ast.Document` carries them. Always the first event;
 * `!!meta` in the header is rejected before this or any other event is ever produced.
 */
export interface DocumentStart {
  readonly kind: 'document-start';
  readonly id?: string;
  readonly schema?: string;
  readonly position: Position;
}

/** Closes the event stream, once the document's root value is complete and only end-of-input remains. */
export interface DocumentEnd {
  readonly kind: 'document-end';
  readonly position: Position;
}

/**
 * `"@" unquoted-token [ ":" data-value ]` (§3.1): opens one annotation. If the annotation
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
 * `"!" type-name` (§3.2): a value's type reference, preserved uninterpreted — resolving it
 * against the built-in type vocabulary (§5) or a declared schema is a later layer's job. No
 * matching end event: a type reference is a bare name, never a nested value.
 */
export interface TypeRef {
  readonly kind: 'type-ref';
  readonly name: string;
  readonly position: Position;
}

/**
 * `"!!schema" ":" single-line-token` (§2.3, §3.3): a scoped-value's schema binding, preserved
 * uninterpreted. Precedes a record field's, map entry's, or array element's own data-value
 * events — never present at the document root or in map-key position, since those are a plain
 * `data-value`, not a `scoped-value`.
 */
export interface SchemaRef {
  readonly kind: 'schema-ref';
  readonly uri: string;
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

/** One record field's name (§2.5, §7.4): announces the field; its scoped-value events follow immediately. */
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

/** Closes an {@link ArrayStart}. Elements are back-to-back scoped-value event sequences, no per-element marker. */
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

/** `"_"` (§2.9): the explicitly-absent sentinel, distinct from any typed value including base-type null. */
export interface AbsentEvent {
  readonly kind: 'absent';
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
