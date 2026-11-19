/**
 * Tier 2: decomposes TSON source bytes into a lazy, pull-based {@link TsonEvent} stream (§2, §3,
 * §7.4) — the same data grammar a Tier 3 parser reduces into a full document tree, but exposed
 * one event at a time via {@link EventSource.next}/{@link EventSource.peek} rather than
 * materialised into a tree. Memory held at any point is proportional to how many containers are
 * currently open (record/map/array nesting depth), never to the document's overall size.
 *
 * Driven directly off a {@link Lexer}'s `nextToken()`, one token at a time — the token stream
 * itself is never materialised. Recursion is replaced with an explicit **frame stack**
 * ({@link Frame}, an array used as a LIFO stack) so the whole point of this tier — cheap to run
 * over a document of any size — is not undone by a real call stack growing with nesting depth.
 *
 * ## The `{}` record/map lookahead (§2.8)
 *
 * Every other decision in the grammar is resolved by the current token alone. The one exception
 * is `{}` disambiguation: a record's first field name and a map's first key share one opening
 * delimiter, and the grammar only tells them apart by what follows the first thing inside — `:`
 * for a record, `=>` for a map. Fully parsing whatever comes first (which can itself be an
 * arbitrarily deep nested value) before checking which delimiter follows would force this module
 * to buffer arbitrarily deep before emitting anything, undermining the point of being lazy.
 * That's avoidable because record-field position requires the first thing after `{` to reduce to
 * a single bare token (no annotations, no type-ref, no nested container) — anything else can only
 * ever be valid as a map key. That collapses the lookahead to **at most two tokens**, decided the
 * instant `{` is seen:
 *
 * - `{` immediately followed by `@`, `!`, `{`, `[`, or `_` can only be a map — none of those can
 *   reduce to a bare field-name token, so one token of lookahead settles it. A document that's
 *   actually malformed here (e.g. an annotated key immediately followed by `:` instead of `=>`)
 *   still commits to a map at this point; the mismatch surfaces one token later instead, at the
 *   point `=>` is expected — a parse error either way, just anchored to a slightly later token
 *   than a full first-value-then-decide parse would report.
 * - `{` followed by a bare token needs exactly one more token of lookahead: if `:` comes next
 *   it's a record field name; if `=>` comes next it's a map key that happens to be an
 *   unannotated, untyped token. Nothing else is legal there.
 *
 * This lookahead is bounded (at most two tokens, held in `state.current`/`state.pending`)
 * regardless of document size or nesting depth.
 *
 * ## Header handling (§2.2)
 *
 * The header is one grammar for every document: an optional `!!id`, then any number of `!!import`s.
 * It is judged here in full -- a retired directive (`!!meta`, `!!schema`), an unknown one and an
 * `!!id` out of place are each refused, naming the rule they broke -- and it does not say what a
 * document is. The root's tag does ({@link DataStream.rootTag}): a root tagged `!schema` is a schema
 * document, any other a data document. Whether a document may be read at all is a
 * conformance-class question this tier is below: the Class 1 callers refuse a schema document, and
 * the schema parser requires one.
 *
 * `id`/`imports` are preserved on {@link DocumentStart} exactly as written, uninterpreted -- this
 * module performs no I/O, matching §3.3's "no parse-time I/O" and the "raw URI arguments,
 * uninterpreted" contract {@link DocumentStart} itself documents.
 *
 * ## References (§4, §7.4, §7.5)
 *
 * An unquoted token followed by an adjacent `<` heads a reference with arguments, and one followed
 * by an adjacent `!` is a sibling reference. Each is assembled whole from its tokens and delivered
 * as one {@link ReferenceEvent}, so every reader, skip and replay treats it as the one value it is.
 */

import { isIriReference } from '../atom/network/uri.js';
import { TsonInternalError, TsonParseError, TsonUnsupportedDocumentError } from '../core/errors.js';
import { START, type Position } from '../core/position.js';
import type {
  ApplicationReference,
  ReferenceArgument,
  SiblingReference,
} from '../ast/reference.js';
import { isQualifiedName, isSiblingField } from '../atom/referenceGrammar.js';
import type { ByteInput, Task } from '../io/bytes.js';
import { createLexer, currentToken, type Lexer } from '../lexer/lexer.js';
import { adjacentTo, type Token, type TokenType } from '../lexer/token.js';
import { isIdentifierText } from '../unicode/identifier-profile.js';
import { toNfc } from '../unicode/nfc.js';
import { isSchemaTag, type DocumentStart, type EventSource, type TsonEvent } from './event.js';

/**
 * An {@link EventSource} over a data document that can also say what kind of document it is
 * without consuming anything.
 */
export interface DataStream extends EventSource {
  /**
   * The root value's tag, looked for past the root's leading annotations, consuming nothing -- what
   * classifies a document (§2.2: a root tagged `!schema` is a schema document). `undefined` when the
   * root carries no type annotation.
   *
   * The events read stay in this stream, unconsumed: the root is stepped only until the event after
   * the root's annotations is ready, so a reader continuing from here receives every event as if
   * nothing had looked. The root's core value is never entered, so a schema map, whose sugar no data
   * frame reads, is classified without being parsed. What this reads beyond the header is the root's
   * annotations, whose values are parsed to find their end.
   */
  rootTag(): Task<string | undefined>;
}

/** Creates a {@link DataStream} over `input`. Nothing is read until {@link EventSource.next}/{@link EventSource.peek} is driven. */
export function createDataStream(input: ByteInput): DataStream {
  const state: StreamState = {
    lexer: createLexer(input),
    current: undefined,
    pending: undefined,
    lastEnd: START,
    frames: [],
    ready: [],
    started: false,
  };

  return {
    next: () => nextEvent(state),
    peek: () => peekEvent(state),
    rootTag: () => rootTagOf(state),
  };
}

/**
 * Refuses a schema document on a Class 1 path (§1.5, §2.2): consumes nothing, reads the root's tag
 * past its annotations, and throws {@link TsonUnsupportedDocumentError} at `at` when it is
 * `!schema`. The refusal is the caller's rather than the stream's, because the stream reads the
 * header for everyone and judges nobody -- the schema parser sits on the same grammar and requires
 * the tag this refuses.
 */
export function* requireDataDocument(stream: DataStream, at: Position): Task<void> {
  if (isSchemaTag(yield* stream.rootTag())) {
    throw new TsonUnsupportedDocumentError(
      'this is a TSON schema document (its root is tagged !schema); a Class 1 (data-format-only) ' +
        'processor does not support schema documents',
      at,
    );
  }
}

// ── State ────────────────────────────────────────────────────────────────

/**
 * The stream's whole mutable state, threaded through this module's generator functions instead
 * of captured by closure or spread across instance fields — a plain record of cursor position,
 * lookahead, the frame stack, and events produced but not yet handed to the caller.
 */
/**
 * The token cursor the reference productions ({@link referenceArguments}, {@link siblingReference})
 * run over: a lexer, at most two tokens of lookahead and the end of the last token consumed. The
 * stream's own state has this shape, and so does the schema grammar's cursor
 * (`compiler/cursor.ts`), so a reference in a schema payload is read by the one production the data
 * grammar reads it with (§7.4).
 */
export interface TokenCursor {
  readonly lexer: Lexer;
  /** The next not-yet-consumed token — populated lazily by {@link peekToken}. */
  current: Token | undefined;
  /** A second lookahead token, buffered only transiently to resolve `{}` disambiguation (§2.8). */
  pending: Token | undefined;
  /** End position of the most recently consumed token — what {@link consumeSeparatorOrCloseCheck} compares a fresh peek against. */
  lastEnd: Position;
}

interface StreamState extends TokenCursor {
  /** The explicit frame stack replacing recursion, LIFO (top = last element). */
  readonly frames: Frame[];
  /** Events produced but not yet returned from {@link EventSource.next}/{@link EventSource.peek}, FIFO. */
  readonly ready: TsonEvent[];
  started: boolean;
}

/**
 * One outstanding step of work, resumed in LIFO order — the stack-based stand-in for a recursive
 * call frame. A discriminated union rather than a class hierarchy: each variant is the state one
 * grammar production needs to resume, and {@link stepFrame} is the sole dispatcher.
 */
type Frame =
  /** Below the document root's `data-value`: checks for trailing content and closes the stream. */
  | { readonly kind: 'root' }
  /** `*annotation [tag] core-value` (§2.3) at the current cursor position. */
  | { readonly kind: 'data-value' }
  /** One `"@" qualified-name-token [ ":" data-value ]` (§3.1). */
  | { readonly kind: 'annotation-only' }
  /** A bare `core-value` (§2.3) — no annotation/type-ref layer. */
  | { readonly kind: 'core-value' }
  /** Closes the most recently opened annotation. */
  | { readonly kind: 'annotation-end' }
  /** Repeatable step for every record field after the first (whose name/colon disambiguation already ran). */
  | { readonly kind: 'record' }
  /** Repeatable step for every map entry: `after-entry` awaits the next key or close, `awaiting-arrow` awaits `=>`. */
  | { readonly kind: 'map'; readonly mode: 'after-entry' | 'awaiting-arrow' }
  /** Repeatable step for every array element; `first` skips the separator check the very first element never needs. */
  | { readonly kind: 'array'; readonly first: boolean };

function pushFrame(state: StreamState, frame: Frame): void {
  state.frames.push(frame);
}

// ── Driving the frame stack ─────────────────────────────────────────────

/** Runs frames until an event is ready or the stream is exhausted. */
function* fill(state: StreamState): Task<void> {
  while (state.ready.length === 0) {
    const frame = state.frames.pop();
    if (frame === undefined) return;
    yield* stepFrame(state, frame);
  }
}

function* nextEvent(state: StreamState): Task<TsonEvent> {
  yield* ensureStarted(state);
  yield* fill(state);
  const event = state.ready.shift();
  if (event === undefined) {
    throw new TsonInternalError('no more TSON stream events');
  }
  return event;
}

function* peekEvent(state: StreamState): Task<TsonEvent> {
  yield* ensureStarted(state);
  yield* fill(state);
  const event = state.ready[0];
  if (event === undefined) {
    throw new TsonInternalError('no more TSON stream events');
  }
  return event;
}

// ── Startup: header directives (§2.2) ───────────────────────────────────

/**
 * The document header (§2.2, §3.3): `[id-directive] *import-directive`, the same for a data document
 * and a schema document. `!!meta` and `!!schema` are retired and name `!!import` as their replacement,
 * and any other directive is refused. Shared with the schema grammar, which reads its header with this
 * production and decides the document's kind from the root's tag (§2.2).
 */
export function* parseHeader(
  state: TokenCursor,
): Task<{ readonly id?: string; readonly imports: string[] }> {
  let id: string | undefined;
  const imports: string[] = [];
  while (yield* check(state, 'directive-token')) {
    const bangbang = yield* peekToken(state);
    const name = yield* peekDirectiveName(state);
    switch (name) {
      case 'id':
        if (id !== undefined || imports.length > 0) {
          throw parseError(
            bangbang,
            "'!!id' must be the header's first directive, and appear once (§2.2)",
          );
        }
        id = yield* parseNamedDirective(state, 'id');
        break;
      case 'import':
        imports.push(yield* parseNamedDirective(state, 'import'));
        break;
      case 'meta':
      case 'schema':
        throw parseError(
          bangbang,
          `the '!!${name}' directive is retired: a document names the schemas it uses with ` +
            "'!!import', and a schema document says what it is by tagging its root '!schema' (§2.2)",
        );
      case undefined:
        // Not a directive name at all: the named parse says what is wrong with the token.
        yield* parseNamedDirective(state, 'import');
        break;
      default:
        throw parseError(
          bangbang,
          `unknown directive '!!${name}': a header holds an optional '!!id' then any number of '!!import's (§2.2)`,
        );
    }
  }
  return { ...(id !== undefined ? { id } : {}), imports };
}

function* ensureStarted(state: StreamState): Task<void> {
  if (state.started) return;
  state.started = true;

  const docStart = (yield* peekToken(state)).start;

  const { id, imports } = yield* parseHeader(state);

  const event: DocumentStart = {
    kind: 'document-start',
    position: docStart,
    imports,
    ...(id !== undefined ? { id } : {}),
  };
  state.ready.push(event);
  pushFrame(state, { kind: 'root' });
  pushFrame(state, { kind: 'data-value' });
}

/** See {@link DataStream.rootTag}. */
function* rootTagOf(state: StreamState): Task<string | undefined> {
  yield* ensureStarted(state);
  let scanned = 0;
  let depth = 0;
  for (;;) {
    while (scanned < state.ready.length) {
      const event: TsonEvent | undefined = state.ready[scanned];
      scanned++;
      if (event === undefined) break;
      switch (event.kind) {
        case 'document-start':
          break;
        case 'annotation-start':
          depth++;
          break;
        case 'annotation-end':
          depth--;
          break;
        default:
          if (depth === 0) return event.kind === 'type-ref' ? event.name : undefined;
      }
    }
    const top = state.frames[state.frames.length - 1];
    // The root's core value is next with no tag before it: the root is untagged, and is not entered.
    if (top === undefined || (depth === 0 && top.kind === 'core-value')) return undefined;
    state.frames.pop();
    yield* stepFrame(state, top);
  }
}

// ── Cursor primitives over Lexer.nextToken() (bounded 2-token lookahead) ─

function* fetchToken(state: TokenCursor): Task<Token> {
  const type = yield* state.lexer.nextToken();
  return currentToken(state.lexer, type);
}

function* peekToken(state: TokenCursor): Task<Token> {
  state.current ??= yield* fetchToken(state);
  return state.current;
}

/** The token after {@link peekToken}, without consuming either — the second of the at-most-two tokens of lookahead this stream keeps. */
function* peekSecond(state: TokenCursor): Task<Token> {
  state.pending ??= yield* fetchToken(state);
  return state.pending;
}

function* advance(state: TokenCursor): Task<Token> {
  const t = yield* peekToken(state);
  state.lastEnd = t.end;
  if (state.pending !== undefined) {
    state.current = state.pending;
    state.pending = undefined;
  } else {
    state.current = yield* fetchToken(state);
  }
  return t;
}

function* check(state: TokenCursor, type: TokenType): Task<boolean> {
  const t = yield* peekToken(state);
  return t.type === type;
}

/**
 * Consumes a token of `type`, or fails naming `construct` — the construct the position admits,
 * phrased as the author would say it (`"a record field's ':'"`), never the token class that would
 * have satisfied it.
 */
function* expect(state: TokenCursor, type: TokenType, construct: string): Task<Token> {
  const t = yield* peekToken(state);
  if (t.type !== type) throw mismatch(construct, t);
  return yield* advance(state);
}

/** The failure {@link expect} raises, for a throw site that decides on more than one token's type. */
function mismatch(construct: string, token: Token): TsonParseError {
  const actual = describe(token);
  return new TsonParseError(`expected ${construct}, found ${actual}`, token.start, {
    expected: construct,
    actual,
  });
}

/** A parse failure that states a rule rather than a substitution, so it carries no `expected`/`actual` pair. */
function parseError(token: Token, message: string): TsonParseError {
  return new TsonParseError(message, token.start);
}

/**
 * One written token as an author would point at it. A quoted token names its form, since its text
 * alone (`abc`) is indistinguishable from an unquoted one and the difference is often the whole
 * problem; everything else is its own text in quotes.
 */
function describe(t: Token): string {
  switch (t.type) {
    case 'eof':
      return 'end of input';
    case 'single-line-token':
    case 'multi-line-token':
      return `the quoted token '${t.text}'`;
    default:
      return `'${t.text}'`;
  }
}

function isStructuralDelimiter(type: TokenType): boolean {
  switch (type) {
    case 'lbrace':
    case 'rbrace':
    case 'lbracket':
    case 'rbracket':
    case 'colon':
    case 'comma':
      return true;
    default:
      return false;
  }
}

/** Every token type a `{` can be immediately followed by that can only ever be a map key (never a bare field name). */
function isAlwaysMapStart(type: TokenType): boolean {
  switch (type) {
    case 'at':
    case 'bang':
    case 'lbrace':
    case 'lbracket':
    case 'void-token':
      return true;
    default:
      return false;
  }
}

function isBareTokenType(type: TokenType): boolean {
  switch (type) {
    case 'unquoted-token':
    case 'single-line-token':
    case 'multi-line-token':
      return true;
    default:
      return false;
  }
}

/**
 * Whether `type` may spell a record field name: `field-name = unquoted-token / single-line-token`
 * (§7.4).
 *
 * Narrower than {@link isBareTokenType} by one form. A map key is a *value* and keeps all three,
 * so the two predicates part company exactly at the brace dispatch, where one consumed token and
 * one of lookahead decide which reading a `{` opens (§2.8).
 */
function isFieldNameTokenType(type: TokenType): boolean {
  return type === 'unquoted-token' || type === 'single-line-token';
}

function tokenFormOf(type: TokenType): 'unquoted' | 'single-line' | 'multi-line' {
  switch (type) {
    case 'unquoted-token':
      return 'unquoted';
    case 'single-line-token':
      return 'single-line';
    case 'multi-line-token':
      return 'multi-line';
    default:
      throw new TsonInternalError(`not a bare-token type: ${type}`);
  }
}

function sameStart(a: Position, b: Position): boolean {
  return a.line === b.line && a.column === b.column && a.offset === b.offset;
}

/**
 * Between elements of a record/map/array (§2.4): a separator (whitespace, a comma, or both) is
 * required unless the closing delimiter is immediately next. **A comma may follow a value**, so a
 * separator landing right before the closing delimiter simply ends the list -- a trailing comma
 * is ordinary, not a syntax error. What still fails is a comma with nothing behind it: a comma
 * following another comma is caught one level up, where the caller tries to parse the next
 * element and finds a comma sitting in value position, which needs no rule of its own (§2.4) --
 * a comma is not a value.
 */
function* consumeSeparatorOrCloseCheck(state: TokenCursor, closing: TokenType): Task<boolean> {
  if (yield* check(state, closing)) return false;

  const t = yield* peekToken(state);
  let sawSeparator = !sameStart(t.start, state.lastEnd);
  if (yield* check(state, 'comma')) {
    yield* advance(state);
    sawSeparator = true;
  }
  if (!sawSeparator) {
    const here = yield* peekToken(state);
    throw parseError(here, 'adjacent values must be separated by whitespace, a comma, or both');
  }
  return !(yield* check(state, closing));
}

/** Looks ahead at an upcoming `!!name` directive's name without consuming anything. */
function* peekDirectiveName(state: TokenCursor): Task<string | undefined> {
  const name = yield* peekSecond(state);
  return name.type === 'unquoted-token' ? name.text : undefined;
}

/** `"!!" name ":" single-line-token`, requiring the directive name to equal `expectedName` (§3.3). */
function* parseNamedDirective(state: TokenCursor, expectedName: string): Task<string> {
  const bangbang = yield* expect(state, 'directive-token', 'a directive');
  const name = yield* peekToken(state);
  if (name.type !== 'unquoted-token') {
    throw parseError(name, `expected a directive name after '!!', found ${describe(name)}`);
  }
  if (!adjacentTo(bangbang, name)) {
    throw parseError(
      name,
      "'!!' must be immediately adjacent to the directive name (no whitespace)",
    );
  }
  if (name.text !== expectedName) {
    throw parseError(
      name,
      `directive '!!${name.text}' is not permitted here (expected '!!${expectedName}')`,
    );
  }
  yield* advance(state); // name

  const colon = yield* peekToken(state);
  if (colon.type !== 'colon' || !adjacentTo(name, colon)) {
    throw parseError(colon, `expected ':' immediately after directive name '!!${expectedName}'`);
  }
  yield* advance(state); // ':'

  const arg = yield* peekToken(state);
  if (arg.type === 'multi-line-token') {
    throw parseError(
      arg,
      'a multi-line token is not permitted as a directive argument; use a single-line quoted token',
    );
  }
  if (arg.type !== 'single-line-token') {
    throw parseError(
      arg,
      `expected a single-line quoted token as the argument to '!!${expectedName}', found ${describe(arg)}`,
    );
  }
  yield* advance(state); // argument

  // §3.3: a directive's argument is a URI. The check runs against the same hand-written RFC 3986
  // grammar the `!uri` atom uses, unconstrained, so the two layers can never disagree about what a
  // URI is. Without it a document like `!!id:"not a uri"` parses clean through to document-end.
  if (!isIriReference(arg.text)) {
    throw new TsonParseError(
      `'!!${expectedName}' argument '${arg.text}' is not a valid IRI-reference (§3.3)`,
      arg.start,
      { expected: 'an IRI-reference', actual: arg.text },
    );
  }

  return arg.text;
}

/**
 * A qualified name at a naming position (§7.4): one identifier, or several joined by `.`, each
 * matched as the identifier grammar matches a name (§7.7). A leading, trailing or doubled `.` and a
 * segment that is no identifier are parse errors.
 */
export function requireQualifiedName(name: Token, role: string, section: string): void {
  if (isQualifiedName(name.text)) return;
  const segments = name.text.split('.');
  const bad = segments.find((segment) => !isIdentifierText(segment));
  const why =
    bad === undefined
      ? ''
      : bad.length === 0
        ? ' (a segment between the dots is empty)'
        : ` ('${bad}' is not an identifier)`;
  throw parseError(
    name,
    `'${name.text}' is not a qualified name, so it names no ${role} (${section}, §7.7)${why}: ` +
      "each segment starts with an XID_Start character and continues with XID_Continue or '-', in NFC",
  );
}

/** `"!" qualified-name-token` (§3.2), rejecting the schema-only type-expression forms (array brackets, `<...>`, `?`) that have no role in a data value. */
export function* parseTypeRefName(state: TokenCursor): Task<string> {
  const bang = yield* advance(state);
  const name = yield* peekToken(state);
  if (name.type !== 'unquoted-token') {
    if (name.type === 'lbracket' && adjacentTo(bang, name)) {
      throw parseError(
        name,
        "'![...]' writes an array type, which is schema syntax and not available in a data value " +
          "(§3.2); write the array itself, or name the type in the schema ('my_type => [...]') and " +
          "write '!my_type' here",
      );
    }
    throw parseError(name, `expected a type name after '!', found ${describe(name)}`);
  }
  if (!adjacentTo(bang, name)) {
    throw parseError(name, "'!' must be immediately adjacent to the type name (no whitespace)");
  }
  // §3.2: "the type name is an unquoted token whose text matches the qualified-name grammar
  // (§7.7); `!42x` is a parse error, not a reference to an undeclared type."
  requireQualifiedName(name, 'type', '§3.2');
  yield* advance(state); // name

  const next = yield* peekToken(state);
  if (next.type === 'less-than') {
    throw parseError(
      next,
      `'!${name.text}<...>' applies type arguments, which is not available on a tag (§3.2): a ` +
        `tag is '!' and a qualified name and nothing more. Write the application where a value ` +
        `stands, or name it in the schema ('my_type => ${name.text}<...>') and write '!my_type' here`,
    );
  }
  if (next.type === 'bang' && adjacentTo(name, next)) {
    throw parseError(
      next,
      `'!${name.text}!' marks a type's name as a sibling reference, and a tag names a type (§7.4): ` +
        "a tag is '!' and a qualified name, never a reference to a field",
    );
  }
  if (next.type === 'question' && adjacentTo(name, next)) {
    throw parseError(
      next,
      `'!${name.text}?' uses the optional suffix, which is schema syntax and not available in a ` +
        `data value (§3.2): optionality is a field's state where the schema declares it, and a ` +
        `value that is void is written '_' (§2.9)`,
    );
  }
  if (!isStructuralDelimiter(next.type) && adjacentTo(name, next)) {
    throw parseError(
      next,
      `expected whitespace after type name '${name.text}' before ${describe(next)}`,
    );
  }
  return name.text;
}

// ── A reference (§4, §7.4, §7.5) ─────────────────────────────────────────

/**
 * Whether the token just consumed, `head`, opens a reference's argument list: the next token is a
 * `<` adjacent to it. A `<` with whitespace before it opens nothing and is refused, as is one after
 * a quoted token, which is never a reference (§7.5).
 */
export function* opensArguments(state: TokenCursor, head: Token): Task<boolean> {
  const next = yield* peekToken(state);
  if (next.type !== 'less-than') return false;
  if (!adjacentTo(head, next)) {
    throw parseError(
      next,
      `'<' opens a reference's argument list only adjacent to the name it applies (§7.5): write ` +
        `'${head.text}<...>' with no whitespace before '<'`,
    );
  }
  if (head.type !== 'unquoted-token') {
    throw parseError(
      next,
      "a quoted token is never a reference, so '<' cannot apply it: write the qualified name unquoted",
    );
  }
  return true;
}

/**
 * The reference `head` heads, its argument list next at the cursor: `"<" ws type-args ws ">"`, each
 * argument a qualified name (a reference, itself possibly applied) or any other token (a value),
 * separated as an array's elements are. Assembled whole, so the stream delivers one value.
 */
export function* referenceArguments(state: TokenCursor, head: Token): Task<ApplicationReference> {
  requireApplicable(head);
  yield* advance(state); // '<'
  const args: ReferenceArgument[] = [];
  const first = yield* peekToken(state);
  if (first.type === 'greater-than') {
    throw parseError(
      first,
      `an argument list holds at least one argument, and '${head.text}<>' holds none`,
    );
  }
  args.push(yield* referenceArgument(state));
  while (yield* consumeSeparatorOrCloseCheck(state, 'greater-than')) {
    args.push(yield* referenceArgument(state));
  }
  yield* expect(state, 'greater-than', "a reference's closing '>'");
  return { kind: 'application', name: head.text, arguments: args };
}

/** `type-arg = application / token` (§7.4). */
function* referenceArgument(state: TokenCursor): Task<ReferenceArgument> {
  const t = yield* peekToken(state);
  switch (t.type) {
    case 'unquoted-token': {
      yield* advance(state);
      if (yield* marksSibling(state, t)) {
        throw parseError(
          t,
          `a sibling reference ('${t.text}!') stands only at a record field's type ([TSON-SCHEMA] §5.2), not at a template argument`,
        );
      }
      const applied = yield* opensArguments(state, t);
      if (isQualifiedName(t.text)) {
        return {
          kind: 'reference',
          reference: applied ? yield* referenceArguments(state, t) : { kind: 'name', name: t.text },
        };
      }
      if (applied) requireApplicable(t);
      return { kind: 'value', text: t.text, form: 'unquoted' };
    }
    case 'single-line-token':
    case 'multi-line-token':
      yield* advance(state);
      yield* opensArguments(state, t);
      return { kind: 'value', text: t.text, form: tokenFormOf(t.type) };
    default:
      throw mismatch(
        "a reference's argument: a qualified name, an application or a token (no structure stands in an argument list in data)",
        t,
      );
  }
}

/**
 * Whether the token just consumed, `head`, is marked as a sibling reference (§7.4): the next token
 * is a `!` adjacent to it. A prefix `!` is adjacent to the token after it and so is never adjacent
 * to the one before. A quoted token is never a reference, so a `!` after one is refused.
 */
export function* marksSibling(state: TokenCursor, head: Token): Task<boolean> {
  const next = yield* peekToken(state);
  // A multi-line token's end is past its closing line's terminator, where the next line starts, so
  // a prefix `!` opening that line would read as adjacent to it.
  if (next.type !== 'bang' || !adjacentTo(head, next) || head.type === 'multi-line-token') {
    return false;
  }
  if (head.type !== 'unquoted-token') {
    throw parseError(
      next,
      "a quoted token is never a reference, so '!' cannot mark it as a sibling reference: a " +
        'sibling is a field named by one unquoted identifier',
    );
  }
  return true;
}

/**
 * The sibling reference `head` and the `!` next at the cursor spell: `sibling-ref = unquoted-token
 * "!"`, the token one identifier (a single segment), and the `!` followed by whitespace (§7.5) or
 * the end of the document. The whitespace is what keeps a postfix `!` apart from a prefix one, so
 * `a!b`, `kind!}`, `kind!]` and `kind!?` are refused here. Assembled whole.
 */
export function* siblingReference(state: TokenCursor, head: Token): Task<SiblingReference> {
  if (!isSiblingField(head.text)) {
    throw parseError(
      head,
      `'${head.text}!' is no sibling reference -- the '!' marks one field of the same record, ` +
        'named by one identifier, a single segment (§7.4)',
    );
  }
  const bang = yield* advance(state);
  const next = yield* peekToken(state);
  if (next.type !== 'eof' && adjacentTo(bang, next)) {
    throw parseError(
      next,
      `a sibling reference's '!' must be followed by whitespace (§7.5): write '${head.text}! ' before ${describe(next)}`,
    );
  }
  return { kind: 'sibling', field: head.text };
}

function requireApplicable(head: Token): void {
  if (!isQualifiedName(head.text)) {
    throw parseError(
      head,
      `'${head.text}' is no qualified name, so it takes no argument list -- each segment between the dots is an identifier (§7.7)`,
    );
  }
}

/**
 * A field name is any single-line token (§2.5, §7.4): `token`'s decoded text, NFC-normalised so
 * that identity and every later comparison sees one spelling. What a field name may be is its
 * record's to say -- a value of the record's `name_type`, the series' identifier for a schemaless
 * record (§7.7) -- so the grammar admits the token and the reader judges the name.
 */
function fieldNameText(token: Token, construct: string): string {
  if (!isFieldNameTokenType(token.type)) {
    throw mismatch(construct, token);
  }
  return toNfc(token.text);
}

/** `field-name = unquoted-token / single-line-token` (§2.5, §7.4). */
function* expectFieldNameToken(state: StreamState, construct: string): Task<Token> {
  const name = yield* peekToken(state);
  const text = fieldNameText(name, construct);
  yield* advance(state);
  return text === name.text ? name : { ...name, text };
}

// ── The frame steps ──────────────────────────────────────────────────────

function* stepFrame(state: StreamState, frame: Frame): Task<void> {
  switch (frame.kind) {
    case 'root':
      yield* stepRoot(state);
      return;
    case 'data-value':
      yield* stepDataValue(state);
      return;
    case 'annotation-only':
      yield* stepAnnotationOnly(state);
      return;
    case 'core-value':
      yield* stepCoreValue(state);
      return;
    case 'annotation-end':
      yield* stepAnnotationEnd(state);
      return;
    case 'record':
      yield* stepRecord(state);
      return;
    case 'map':
      yield* stepMap(state, frame.mode);
      return;
    case 'array':
      yield* stepArray(state, frame.first);
      return;
  }
}

function* stepRoot(state: StreamState): Task<void> {
  const t = yield* peekToken(state);
  if (t.type !== 'eof') {
    throw parseError(t, `unexpected content after the document's value: ${describe(t)}`);
  }
  state.ready.push({ kind: 'document-end', position: t.start });
}

function* stepDataValue(state: StreamState): Task<void> {
  const t = yield* peekToken(state);
  if (t.type === 'at') {
    pushFrame(state, { kind: 'data-value' }); // continue this position once the annotation closes
    pushFrame(state, { kind: 'annotation-only' });
    return;
  }
  if (t.type === 'bang') {
    const name = yield* parseTypeRefName(state);
    state.ready.push({ kind: 'type-ref', name, position: t.start });
    pushFrame(state, { kind: 'core-value' });
    return;
  }
  pushFrame(state, { kind: 'core-value' });
}

function* stepAnnotationOnly(state: StreamState): Task<void> {
  const at = yield* advance(state);
  const name = yield* peekToken(state);
  if (name.type !== 'unquoted-token') {
    throw parseError(name, `expected an annotation name after '@', found ${describe(name)}`);
  }
  if (!adjacentTo(at, name)) {
    throw parseError(
      name,
      "'@' must be immediately adjacent to the annotation name (no whitespace)",
    );
  }
  // §3.1's name is a qualified name (§7.4), matched segment by segment as a tag's is; a token that
  // fails the grammar names no annotation, and the position admits no quoted form to fall back on.
  requireQualifiedName(name, 'annotation', '§3.1');
  yield* advance(state); // name

  const afterName = yield* peekToken(state);
  if (afterName.type === 'colon' && adjacentTo(name, afterName)) {
    yield* advance(state); // ':'
    state.ready.push({ kind: 'annotation-start', name: name.text, position: at.start });
    pushFrame(state, { kind: 'annotation-end' });
    pushFrame(state, { kind: 'data-value' }); // the annotation's own value
    return;
  }

  // Valueless: at least one whitespace character MUST follow the annotation name (§3.1).
  if (adjacentTo(name, afterName)) {
    throw parseError(
      afterName,
      `expected whitespace after annotation name '${name.text}' (or an adjacent ':' to give it a value)`,
    );
  }
  state.ready.push({ kind: 'annotation-start', name: name.text, position: at.start });
  state.ready.push({ kind: 'annotation-end', position: afterName.start });
}

function* stepCoreValue(state: StreamState): Task<void> {
  const t = yield* peekToken(state);
  switch (t.type) {
    case 'lbrace':
      yield* parseBraceValue(state);
      return;
    case 'lbracket':
      yield* advance(state);
      state.ready.push({ kind: 'array-start', position: t.start });
      pushFrame(state, { kind: 'array', first: true });
      return;
    case 'void-token':
      yield* advance(state);
      state.ready.push({ kind: 'void', position: t.start });
      return;
    case 'unquoted-token':
    case 'single-line-token':
    case 'multi-line-token':
      yield* advance(state);
      if (yield* opensArguments(state, t)) {
        state.ready.push({
          kind: 'reference',
          reference: yield* referenceArguments(state, t),
          position: t.start,
        });
      } else if (yield* marksSibling(state, t)) {
        state.ready.push({
          kind: 'reference',
          reference: yield* siblingReference(state, t),
          position: t.start,
        });
      } else {
        state.ready.push({
          kind: 'token',
          text: t.text,
          form: tokenFormOf(t.type),
          position: t.start,
        });
      }
      return;
    case 'directive-token': {
      const name = yield* peekDirectiveName(state);
      throw parseError(
        t,
        `directive '!!${name ?? ''}' is not permitted here: a directive stands only in the document header (§2.2, §3.3)`,
      );
    }
    default:
      throw parseError(
        t,
        `expected a value (record, map, array, empty braces, the void sentinel '_', or a token), ` +
          `found ${describe(t)}`,
      );
  }
}

/** The one place `{}` disambiguation happens (§2.8) — see this module's own doc comment. */
function* parseBraceValue(state: StreamState): Task<void> {
  const lbrace = yield* advance(state);
  const t1 = yield* peekToken(state);

  if (t1.type === 'rbrace') {
    yield* advance(state);
    state.ready.push({ kind: 'empty-brace', position: lbrace.start });
    return;
  }

  if (isAlwaysMapStart(t1.type)) {
    state.ready.push({ kind: 'map-start', position: lbrace.start });
    pushFrame(state, { kind: 'map', mode: 'awaiting-arrow' });
    pushFrame(state, { kind: 'data-value' }); // the (possibly annotated/typed/nested) first key
    return;
  }

  if (isBareTokenType(t1.type)) {
    const t2 = yield* peekSecond(state);
    if (t2.type === 'colon') {
      // §2.8: the record interpretation is selected only when the consumed data-value is a bare
      // token whose decoded text is an identifier -- anything else is a parse error, not a
      // silent fallback to a map, so the author rewrites `:` as `=>` themselves (§2.5).
      const name = fieldNameText(t1, 'a record field name');
      yield* advance(state); // field-name token
      yield* advance(state); // ':'
      state.ready.push({ kind: 'record-start', position: lbrace.start });
      state.ready.push({ kind: 'field-name', name, position: t1.start });
      pushFrame(state, { kind: 'record' });
      pushFrame(state, { kind: 'data-value' });
      return;
    }
    if (
      (t2.type === 'less-than' || (t2.type === 'bang' && t1.type === 'unquoted-token')) &&
      adjacentTo(t1, t2)
    ) {
      // A reference as the first key: the entry's own frame reads it, and the arrow after it.
      state.ready.push({ kind: 'map-start', position: lbrace.start });
      pushFrame(state, { kind: 'map', mode: 'awaiting-arrow' });
      pushFrame(state, { kind: 'data-value' });
      return;
    }
    if (t2.type === 'map-arrow-token') {
      yield* advance(state); // key token
      yield* advance(state); // '=>'
      state.ready.push({ kind: 'map-start', position: lbrace.start });
      state.ready.push({
        kind: 'token',
        text: t1.text,
        form: tokenFormOf(t1.type),
        position: t1.start,
      });
      state.ready.push({ kind: 'map-arrow', position: t2.start });
      pushFrame(state, { kind: 'map', mode: 'after-entry' });
      pushFrame(state, { kind: 'data-value' });
      return;
    }
    throw parseError(
      t1,
      `a value inside curly braces must be followed by ':' (record) or '=>' (map), found ${describe(t2)}`,
    );
  }

  throw parseError(
    t1,
    `expected a value (record, map, array, empty braces, the void sentinel '_', or a token), ` +
      `found ${describe(t1)}`,
  );
}

function* stepAnnotationEnd(state: StreamState): Task<void> {
  const t = yield* peekToken(state);
  state.ready.push({ kind: 'annotation-end', position: t.start });
}

function* stepRecord(state: StreamState): Task<void> {
  if (yield* check(state, 'rbrace')) {
    const rb = yield* advance(state);
    state.ready.push({ kind: 'record-end', position: rb.start });
    return;
  }
  if (!(yield* consumeSeparatorOrCloseCheck(state, 'rbrace'))) {
    // A trailing comma (§2.4) consumed cleanly right up to the close.
    const rb = yield* advance(state);
    state.ready.push({ kind: 'record-end', position: rb.start });
    return;
  }
  const name = yield* expectFieldNameToken(state, 'a record field name');
  yield* expect(state, 'colon', "a record field's ':'");
  state.ready.push({ kind: 'field-name', name: name.text, position: name.start });
  pushFrame(state, { kind: 'record' });
  pushFrame(state, { kind: 'data-value' });
}

function* stepMap(state: StreamState, mode: 'after-entry' | 'awaiting-arrow'): Task<void> {
  if (mode === 'after-entry') {
    if (yield* check(state, 'rbrace')) {
      const rb = yield* advance(state);
      state.ready.push({ kind: 'map-end', position: rb.start });
      return;
    }
    if (!(yield* consumeSeparatorOrCloseCheck(state, 'rbrace'))) {
      // A trailing comma (§2.4) consumed cleanly right up to the close.
      const rb = yield* advance(state);
      state.ready.push({ kind: 'map-end', position: rb.start });
      return;
    }
    pushFrame(state, { kind: 'map', mode: 'awaiting-arrow' });
    pushFrame(state, { kind: 'data-value' }); // the next key
    return;
  }
  const arrow = yield* expect(state, 'map-arrow-token', "a map entry's '=>'");
  state.ready.push({ kind: 'map-arrow', position: arrow.start });
  pushFrame(state, { kind: 'map', mode: 'after-entry' });
  pushFrame(state, { kind: 'data-value' });
}

function* stepArray(state: StreamState, first: boolean): Task<void> {
  if (yield* check(state, 'rbracket')) {
    const rb = yield* advance(state);
    state.ready.push({ kind: 'array-end', position: rb.start });
    return;
  }
  if (!first && !(yield* consumeSeparatorOrCloseCheck(state, 'rbracket'))) {
    // A trailing comma (§2.4) consumed cleanly right up to the close.
    const rb = yield* advance(state);
    state.ready.push({ kind: 'array-end', position: rb.start });
    return;
  }
  pushFrame(state, { kind: 'array', first: false });
  pushFrame(state, { kind: 'data-value' });
}
