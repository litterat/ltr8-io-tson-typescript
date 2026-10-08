/**
 * RFC 8259's structural grammar over `json/lexer.ts`, as a lazy pull-based {@link JsonEventSource}
 * — the JSON encoding's Tier 2, and the streaming counterpart to `json/tree.ts`'s nested
 * {@link JsonValue} model, matching `stream/dataStream.ts`'s own relationship to `ast/value.ts` on
 * the TSON text side.
 *
 * The only layer above the lexer that walks source text: it holds a frame stack and nothing else,
 * so memory stays proportional to nesting depth rather than to document size — `CLAUDE.md`'s
 * streaming constraint, restated for this encoding.
 *
 * **No token lookahead at all**, unlike `stream/dataStream.ts`. JSON's grammar is LL(1) on
 * already-lexed tokens and never needs a pushback: after `{` the next token is either `}` or a
 * member name and consuming it decides which. That is where `dataStream.ts` spends two tokens, on
 * the record-versus-map brace idiom — an ambiguity JSON does not draw at all (§4.1 leaves the
 * record/map decision to a typed *position*, which this layer has none of). `peek()` here holds
 * back a produced *event*, not a token.
 *
 * **There is no document-start event.** RFC 8259's `JSON-text` is one value with no header, unlike
 * a TSON text document's `!!id`/`!!schema` directives. {@link JsonEvent} does carry an
 * `end-of-document` member, and it is not merely "no more events": **producing it is what pulls
 * past the root value**, and so what rejects trailing content — `[1] 2` is refused there and
 * nowhere else, the same trap `facade/` keeps under `requireDocumentEnd` for the text encoding.
 *
 * **`null` is a value at this layer**, not the void sentinel: [TSON-JSON] §7 makes JSON `null`
 * the void sentinel's spelling *at a typed position*, and this layer has none — settling it here
 * would impose a schema's answer on a layer that has no schema. That reading belongs to the
 * schema-directed decode of §5–§8, layered above this event source rather than inside it.
 *
 * **Grammar only, three things follow directly from §3.1's own layering:** member names are not
 * deduped here (§3.1 makes a repeat an error whose *category* follows the position's type, a fact
 * this layer holds none of — `json/schemalessTree.ts` is where the raw tree read applies the
 * rule); no value is interpreted (a number is its lexeme, a string its decoded content); and no
 * member name is reserved (§3.2's `$`-namespace is a question about the position's type).
 *
 * **Nesting depth is bounded here** ([TSON-JSON] §10.1) — the one place every container opens, so
 * a refusal lands before any consumer descends. §10.1 states the bound is [TSON-DATA] §9.1's
 * `LimitsPolicy` "in JSON clothing, and the same policy applies with the same defaults", so this
 * reuses `core/limits.ts` directly rather than carrying a second default: a deployment that raises
 * the bound raises it for both encodings at once.
 */
import { TsonInternalError, TsonParseError } from '../core/errors.js';
import {
  maxNestingDepthOf,
  nestingLimitRefusal,
  type NestingLimitOptions,
} from '../core/limits.js';
import type { Position } from '../core/position.js';
import type { ByteInput, Task } from '../io/bytes.js';
import { createJsonLexer, type JsonLexer, type JsonTokenType } from './lexer.js';

/**
 * One structural event in a flat, pull-based decomposition of a JSON document. Every value
 * position (the document root, an object member's value, an array element) has the same
 * self-delimiting shape: exactly one core value, either a single leaf event
 * (`string`/`number`/`boolean`/`null`) or a matched `object-start`/`object-end` or
 * `array-start`/`array-end` pair. Inside an object, each member is a `member-name` followed
 * immediately by its value's events.
 *
 * Discriminated on `kind`, matching `stream/event.ts`'s own `TsonEvent`; every member carries a
 * `position`.
 */
export type JsonEvent =
  | JsonObjectStart
  | JsonMemberName
  | JsonObjectEnd
  | JsonArrayStart
  | JsonArrayEnd
  | JsonStringEvent
  | JsonNumberEvent
  | JsonBooleanEvent
  | JsonNullEvent
  | JsonEndOfDocument;

export interface JsonObjectStart {
  readonly kind: 'object-start';
  readonly position: Position;
}

/**
 * One object member's name: announces the member, and its value's events follow immediately.
 * `name` is the string's decoded content, so an escaped name and the same name written plainly are
 * one member name here — what makes §3.1's duplicate rule a rule about *names* rather than about
 * spellings. This layer does not apply the rule; see this file's own top note.
 */
export interface JsonMemberName {
  readonly kind: 'member-name';
  readonly name: string;
  readonly position: Position;
}

export interface JsonObjectEnd {
  readonly kind: 'object-end';
  readonly position: Position;
}

export interface JsonArrayStart {
  readonly kind: 'array-start';
  readonly position: Position;
}

export interface JsonArrayEnd {
  readonly kind: 'array-end';
  readonly position: Position;
}

export interface JsonStringEvent {
  readonly kind: 'string';
  readonly value: string;
  readonly position: Position;
}

/** A number, as its exact source lexeme — nothing at this layer converts it (§5.3, §3.1). */
export interface JsonNumberEvent {
  readonly kind: 'number';
  readonly literal: string;
  readonly position: Position;
}

export interface JsonBooleanEvent {
  readonly kind: 'boolean';
  readonly value: boolean;
  readonly position: Position;
}

/** `null` — a JSON value here; the void sentinel only once a typed position reads it (§7). */
export interface JsonNullEvent {
  readonly kind: 'null';
  readonly position: Position;
}

/**
 * The document's one value is complete and only end of input remains. **Pulling this is what
 * rejects trailing content** — a consumer that stops at the root value's last event has not
 * finished reading the document.
 */
export interface JsonEndOfDocument {
  readonly kind: 'end-of-document';
  readonly position: Position;
}

/**
 * A pull-based {@link JsonEvent} source with one event of lookahead — the contract the layers
 * above this module consume, matching `stream/event.ts`'s `EventSource`. Both methods return
 * {@link Task}: the whole read stack is suspendable-but-sync-shaped (`io/bytes.ts`).
 */
export interface JsonEventSource {
  /** Consumes and returns the next event. */
  next(): Task<JsonEvent>;
  /** Returns the next event without consuming it — repeated calls with no intervening `next()` return the same event. */
  peek(): Task<JsonEvent>;
}

// ── The grammar ──────────────────────────────────────────────────────────────────────────────

type GrammarState =
  | 'root-value'
  | 'object-first-member'
  | 'object-member'
  | 'object-value'
  | 'object-separator'
  | 'array-first-element'
  | 'array-element'
  | 'array-separator'
  | 'document-end'
  | 'done';

interface StreamState {
  readonly lexer: JsonLexer;
  readonly maxDepth: number;
  /** One entry per open container, deepest last: `true` for an object, `false` for an array. */
  frames: boolean[];
  depth: number;
  grammar: GrammarState;
  lookahead: JsonEvent | undefined;
}

/**
 * Creates a {@link JsonEventSource} over `input`, bounding nesting depth per {@link options}
 * (defaulting to [TSON-DATA] §9.1's own default, shared with the text encoding).
 */
export function createJsonStream(input: ByteInput, options?: NestingLimitOptions): JsonEventSource {
  const state: StreamState = {
    lexer: createJsonLexer(input),
    maxDepth: maxNestingDepthOf(options),
    frames: [],
    depth: 0,
    grammar: 'root-value',
    lookahead: undefined,
  };
  return {
    *next(): Task<JsonEvent> {
      if (state.lookahead !== undefined) {
        const event = state.lookahead;
        state.lookahead = undefined;
        return event;
      }
      return yield* advanceGrammar(state);
    },
    *peek(): Task<JsonEvent> {
      state.lookahead ??= yield* advanceGrammar(state);
      return state.lookahead;
    },
  };
}

function unexpected(found: JsonTokenType, at: Position, expected: string): TsonParseError {
  return new TsonParseError(`${expected}, and ${describeToken(found)} is not one`, at, {
    expected,
    actual: describeToken(found),
  });
}

function describeToken(type: JsonTokenType): string {
  switch (type) {
    case 'begin-object':
      return "'{'";
    case 'end-object':
      return "'}'";
    case 'begin-array':
      return "'['";
    case 'end-array':
      return "']'";
    case 'name-separator':
      return "':'";
    case 'value-separator':
      return "','";
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'true':
      return "'true'";
    case 'false':
      return "'false'";
    case 'null':
      return "'null'";
    case 'eof':
      return 'the end of the document';
  }
}

function* advanceGrammar(state: StreamState): Task<JsonEvent> {
  switch (state.grammar) {
    case 'root-value':
    case 'object-value':
    case 'array-first-element':
    case 'array-element':
      return yield* value(state);
    case 'object-first-member':
    case 'object-member':
      return yield* member(state);
    case 'object-separator':
      return yield* objectSeparator(state);
    case 'array-separator':
      return yield* arraySeparator(state);
    case 'document-end':
      return yield* endOfDocument(state);
    case 'done':
      throw new TsonInternalError("the document's events are exhausted");
  }
}

/**
 * One value at whichever position is due — for `{`/`[`, only its opening event. `array-first-
 * element` is the one value position that may instead be a closer, an empty array being the only
 * container whose emptiness is decided where a value would stand.
 */
function* value(state: StreamState): Task<JsonEvent> {
  const token = yield* state.lexer.nextToken();
  const at = state.lexer.start;

  if (token === 'end-array' && state.grammar === 'array-first-element') {
    return closeArray(state, at);
  }

  switch (token) {
    case 'begin-object':
      push(state, true, at);
      state.grammar = 'object-first-member';
      return { kind: 'object-start', position: at };
    case 'begin-array':
      push(state, false, at);
      state.grammar = 'array-first-element';
      return { kind: 'array-start', position: at };
    case 'string':
      return completed(state, { kind: 'string', value: state.lexer.text, position: at });
    case 'number':
      return completed(state, { kind: 'number', literal: state.lexer.text, position: at });
    case 'true':
      return completed(state, { kind: 'boolean', value: true, position: at });
    case 'false':
      return completed(state, { kind: 'boolean', value: false, position: at });
    case 'null':
      return completed(state, { kind: 'null', position: at });
    default: {
      const expected =
        state.grammar === 'root-value'
          ? 'a JSON document is one value'
          : state.grammar === 'object-value'
            ? "a member's value is due"
            : state.grammar === 'array-first-element'
              ? "an element or ']' is due"
              : 'an element is due';
      throw unexpected(token, at, expected);
    }
  }
}

/** A member name and the `:` after it, leaving the member's own value due. */
function* member(state: StreamState): Task<JsonEvent> {
  const token = yield* state.lexer.nextToken();
  const at = state.lexer.start;

  if (token === 'end-object' && state.grammar === 'object-first-member') {
    return closeObject(state, at);
  }
  if (token !== 'string') {
    throw unexpected(
      token,
      at,
      token === 'end-object'
        ? 'a member name is due -- JSON admits no trailing comma'
        : 'a member name is due, and a member name is a quoted string',
    );
  }
  const name: JsonMemberName = { kind: 'member-name', name: state.lexer.text, position: at };
  const separator = yield* state.lexer.nextToken();
  if (separator !== 'name-separator') {
    throw unexpected(separator, state.lexer.start, "':' separates a member name from its value");
  }
  state.grammar = 'object-value';
  return name;
}

function* objectSeparator(state: StreamState): Task<JsonEvent> {
  const token = yield* state.lexer.nextToken();
  const at = state.lexer.start;
  if (token === 'value-separator') {
    state.grammar = 'object-member';
    return yield* advanceGrammar(state);
  }
  if (token === 'end-object') return closeObject(state, at);
  throw unexpected(token, at, "',' or '}' follows a member's value");
}

function* arraySeparator(state: StreamState): Task<JsonEvent> {
  const token = yield* state.lexer.nextToken();
  const at = state.lexer.start;
  if (token === 'value-separator') {
    state.grammar = 'array-element';
    return yield* advanceGrammar(state);
  }
  if (token === 'end-array') return closeArray(state, at);
  throw unexpected(token, at, "',' or ']' follows an element");
}

function closeObject(state: StreamState, at: Position): JsonEvent {
  pop(state);
  return completed(state, { kind: 'object-end', position: at });
}

function closeArray(state: StreamState, at: Position): JsonEvent {
  pop(state);
  return completed(state, { kind: 'array-end', position: at });
}

/** Marks the value just produced complete and moves to whatever follows one at this depth. */
function completed(state: StreamState, event: JsonEvent): JsonEvent {
  state.grammar =
    state.depth === 0 ? 'document-end' : inObject(state) ? 'object-separator' : 'array-separator';
  return event;
}

/** The pull past the root value, which is what rejects trailing content. */
function* endOfDocument(state: StreamState): Task<JsonEvent> {
  const token = yield* state.lexer.nextToken();
  if (token !== 'eof') {
    throw unexpected(
      token,
      state.lexer.start,
      'a JSON document is one value, and this one is complete',
    );
  }
  state.grammar = 'done';
  return { kind: 'end-of-document', position: state.lexer.start };
}

// ── The frame stack, and §10.1's depth bound ────────────────────────────────────────────────

function push(state: StreamState, object: boolean, at: Position): void {
  if (state.depth === state.maxDepth) {
    throw nestingLimitRefusal(state.maxDepth, at);
  }
  state.frames[state.depth] = object;
  state.depth += 1;
}

function pop(state: StreamState): void {
  state.depth -= 1;
}

function inObject(state: StreamState): boolean {
  const frame = state.frames[state.depth - 1];
  if (frame === undefined) {
    throw new TsonInternalError('inObject() called at depth zero');
  }
  return frame;
}
