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
 * The document header is a fixed directive sequence needing at most two directives of lookahead
 * and no backtracking: an optional `!!id`, then — for a data document — an optional `!!schema`.
 * If the token past an optional `!!id` is `!!meta`, the document is a *schema* document, which
 * this stream (a Class 1, data-only path) does not support; it raises
 * {@link TsonUnsupportedDocumentError} rather than mis-parsing the schema-map body that follows.
 *
 * `id`/`schema` are preserved on {@link DocumentStart} exactly as written, uninterpreted — this
 * module performs no URI syntax validation and no I/O, matching §3.3's "no parse-time I/O" and
 * the "raw URI arguments, uninterpreted" contract {@link DocumentStart} itself documents.
 */

import { parseIpv6Bytes } from '../atom/network/ipv6.js';
import { tryParseUri } from '../atom/network/uriGrammar.js';
import { TsonInternalError, TsonParseError, TsonUnsupportedDocumentError } from '../core/errors.js';
import { START, type Position } from '../core/position.js';
import type { ByteInput, Task } from '../io/bytes.js';
import { createLexer, currentToken, type Lexer } from '../lexer/lexer.js';
import { adjacentTo, type Token, type TokenType } from '../lexer/token.js';
import { isIdentifierText } from '../unicode/identifier-profile.js';
import type { DocumentStart, EventSource, TsonEvent } from './event.js';

/** Creates an {@link EventSource} over `input`. Nothing is read until {@link EventSource.next}/{@link EventSource.peek} is driven. */
export function createDataStream(input: ByteInput): EventSource {
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
  };
}

// ── State ────────────────────────────────────────────────────────────────

/**
 * The stream's whole mutable state, threaded through this module's generator functions instead
 * of captured by closure or spread across instance fields — a plain record of cursor position,
 * lookahead, the frame stack, and events produced but not yet handed to the caller.
 */
interface StreamState {
  readonly lexer: Lexer;
  /** The next not-yet-consumed token — populated lazily by {@link peekToken}. */
  current: Token | undefined;
  /** A second lookahead token, buffered only transiently to resolve `{}` disambiguation (§2.8). */
  pending: Token | undefined;
  /** End position of the most recently consumed token — what {@link consumeSeparatorOrCloseCheck} compares a fresh peek against. */
  lastEnd: Position;
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
  /** `*annotation [type-ref] core-value` (§2.3) at the current cursor position. */
  | { readonly kind: 'data-value' }
  /** One `"@" unquoted-token [ ":" data-value ]` (§3.1). */
  | { readonly kind: 'annotation-only' }
  /** A bare `core-value` (§2.3) — no annotation/type-ref layer. */
  | { readonly kind: 'core-value' }
  /** Closes the most recently opened annotation. */
  | { readonly kind: 'annotation-end' }
  /** `[ schema-directive ws ] data-value` (§2.3): a record field value, map entry value, or array element. */
  | { readonly kind: 'scoped-value' }
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

function* ensureStarted(state: StreamState): Task<void> {
  if (state.started) return;
  state.started = true;

  const docStart = (yield* peekToken(state)).start;

  let id: string | undefined;
  if ((yield* check(state, 'directive-token')) && (yield* peekDirectiveName(state)) === 'id') {
    id = yield* parseNamedDirective(state, 'id');
  }

  if ((yield* check(state, 'directive-token')) && (yield* peekDirectiveName(state)) === 'meta') {
    const metaStart = (yield* peekToken(state)).start;
    yield* parseNamedDirective(state, 'meta');
    throw new TsonUnsupportedDocumentError(
      'this is a TSON schema document (header contains !!meta); a Class 1 (data-format-only) ' +
        'processor does not support schema documents',
      metaStart,
    );
  }

  let schema: string | undefined;
  if (yield* check(state, 'directive-token')) {
    const bangbang = yield* peekToken(state);
    const name = yield* peekDirectiveName(state);
    if (name === 'schema') {
      schema = yield* parseNamedDirective(state, 'schema');
    } else {
      const second = yield* peekSecond(state);
      const label = name ?? describe(second);
      throw parseError(
        bangbang,
        `directive '!!${label}' is not permitted here (expected '!!schema' or the start of the document's value)`,
      );
    }
  }

  const event: DocumentStart = {
    kind: 'document-start',
    position: docStart,
    ...(id !== undefined ? { id } : {}),
    ...(schema !== undefined ? { schema } : {}),
  };
  state.ready.push(event);
  pushFrame(state, { kind: 'root' });
  pushFrame(state, { kind: 'data-value' });
}

// ── Cursor primitives over Lexer.nextToken() (bounded 2-token lookahead) ─

function* fetchToken(state: StreamState): Task<Token> {
  const type = yield* state.lexer.nextToken();
  return currentToken(state.lexer, type);
}

function* peekToken(state: StreamState): Task<Token> {
  state.current ??= yield* fetchToken(state);
  return state.current;
}

/** The token after {@link peekToken}, without consuming either — the second of the at-most-two tokens of lookahead this stream keeps. */
function* peekSecond(state: StreamState): Task<Token> {
  state.pending ??= yield* fetchToken(state);
  return state.pending;
}

function* advance(state: StreamState): Task<Token> {
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

function* check(state: StreamState, type: TokenType): Task<boolean> {
  const t = yield* peekToken(state);
  return t.type === type;
}

/**
 * Consumes a token of `type`, or fails naming `construct` — the construct the position admits,
 * phrased as the author would say it (`"a record field's ':'"`), never the token class that would
 * have satisfied it.
 */
function* expect(state: StreamState, type: TokenType, construct: string): Task<Token> {
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
    case 'absent-token':
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
 * required unless the closing delimiter is immediately next; a trailing separator right before
 * the closing delimiter is likewise a parse error.
 */
function* consumeSeparatorOrCloseCheck(state: StreamState, closing: TokenType): Task<boolean> {
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
  if (yield* check(state, closing)) {
    const here = yield* peekToken(state);
    throw parseError(here, `a trailing separator is not permitted before ${describe(here)}`);
  }
  return true;
}

/** Looks ahead at an upcoming `!!name` directive's name without consuming anything. */
function* peekDirectiveName(state: StreamState): Task<string | undefined> {
  const name = yield* peekSecond(state);
  return name.type === 'unquoted-token' ? name.text : undefined;
}

/** `"!!" name ":" single-line-token`, requiring the directive name to equal `expectedName` (§3.3). */
function* parseNamedDirective(state: StreamState, expectedName: string): Task<string> {
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
  if (tryParseUri(arg.text, isIpv6Candidate) === undefined) {
    throw new TsonParseError(
      `'!!${expectedName}' argument '${arg.text}' is not a valid URI (§3.3)`,
      arg.start,
      { expected: 'a URI', actual: arg.text },
    );
  }

  return arg.text;
}

/** The IPv6 literal recogniser RFC 3986's `IP-literal` host form needs. */
function isIpv6Candidate(candidate: string): boolean {
  return parseIpv6Bytes(candidate) !== undefined;
}

/** `"!" unquoted-token` (§3.2), rejecting the schema-only type-expression forms (array brackets, `<...>`, `?`) that have no role in a data value. */
function* parseTypeRefName(state: StreamState): Task<string> {
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
  if (!isIdentifierText(name.text)) {
    // §3.2: "the type name is an unquoted token whose text matches the identifier grammar
    // (§7.7); `!42x` is a parse error, not a reference to an undeclared type."
    throw parseError(
      name,
      `'${name.text}' is not an identifier, so it names no type (§3.2, §7.7): a name starts with ` +
        `an XID_Start character and continues with XID_Continue or '-', in NFC`,
    );
  }
  yield* advance(state); // name

  const next = yield* peekToken(state);
  if (next.type === 'less-than') {
    throw parseError(
      next,
      `'!${name.text}<...>' applies type arguments, which is schema syntax and not available in a ` +
        `data value (§3.2): a data type-ref is a bare name. Name the application in the schema ` +
        `('my_type => ${name.text}<...>') and write '!my_type' here`,
    );
  }
  if (next.type === 'question' && adjacentTo(name, next)) {
    throw parseError(
      next,
      `'!${name.text}?' uses the optional suffix, which is schema syntax and not available in a ` +
        `data value (§3.2): optionality is a field's state where the schema declares it, and a ` +
        `value that is absent is written '_' (§2.9)`,
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

/** `field-name = unquoted-token / single-line-token` (§7.4): the multi-line form names no field. */
function* expectFieldNameToken(state: StreamState, construct: string): Task<Token> {
  const name = yield* peekToken(state);
  if (!isFieldNameTokenType(name.type)) {
    throw mismatch(construct, name);
  }
  yield* advance(state);
  return name;
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
    case 'scoped-value':
      yield* stepScopedValue(state);
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
  if (!isIdentifierText(name.text)) {
    // §3.1's name is the same `identifier` the type-ref position takes (§7.7); a token that
    // fails the grammar names no annotation, and the position admits no quoted form to fall
    // back on.
    throw parseError(
      name,
      `'${name.text}' is not an identifier, so it names no annotation (§3.1, §7.7): a name ` +
        `starts with an XID_Start character and continues with XID_Continue or '-', in NFC`,
    );
  }
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
    case 'absent-token':
      yield* advance(state);
      state.ready.push({ kind: 'absent', position: t.start });
      return;
    case 'unquoted-token':
    case 'single-line-token':
    case 'multi-line-token':
      yield* advance(state);
      state.ready.push({
        kind: 'token',
        text: t.text,
        form: tokenFormOf(t.type),
        position: t.start,
      });
      return;
    default:
      throw parseError(
        t,
        `expected a value (record, map, array, empty braces, the absent sentinel '_', or a token), ` +
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
      if (!isFieldNameTokenType(t1.type)) {
        throw mismatch('a record field name', t1);
      }
      yield* advance(state); // field-name token
      yield* advance(state); // ':'
      state.ready.push({ kind: 'record-start', position: lbrace.start });
      state.ready.push({ kind: 'field-name', name: t1.text, position: t1.start });
      pushFrame(state, { kind: 'record' });
      pushFrame(state, { kind: 'scoped-value' });
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
      pushFrame(state, { kind: 'scoped-value' });
      return;
    }
    throw parseError(
      t1,
      `a value inside curly braces must be followed by ':' (record) or '=>' (map), found ${describe(t2)}`,
    );
  }

  throw parseError(
    t1,
    `expected a value (record, map, array, empty braces, the absent sentinel '_', or a token), ` +
      `found ${describe(t1)}`,
  );
}

function* stepAnnotationEnd(state: StreamState): Task<void> {
  const t = yield* peekToken(state);
  state.ready.push({ kind: 'annotation-end', position: t.start });
}

function* stepScopedValue(state: StreamState): Task<void> {
  if (yield* check(state, 'directive-token')) {
    const bangbang = yield* peekToken(state);
    const name = yield* peekDirectiveName(state);
    if (name !== 'schema') {
      const second = yield* peekSecond(state);
      const label = name ?? describe(second);
      throw parseError(
        bangbang,
        `directive '!!${label}' is not permitted here (only '!!schema' is)`,
      );
    }
    const pos = bangbang.start;
    const uri = yield* parseNamedDirective(state, 'schema');
    state.ready.push({ kind: 'schema-ref', uri, position: pos });
  }
  pushFrame(state, { kind: 'data-value' });
}

function* stepRecord(state: StreamState): Task<void> {
  if (yield* check(state, 'rbrace')) {
    const rb = yield* advance(state);
    state.ready.push({ kind: 'record-end', position: rb.start });
    return;
  }
  yield* consumeSeparatorOrCloseCheck(state, 'rbrace');
  const name = yield* expectFieldNameToken(state, 'a record field name');
  yield* expect(state, 'colon', "a record field's ':'");
  state.ready.push({ kind: 'field-name', name: name.text, position: name.start });
  pushFrame(state, { kind: 'record' });
  pushFrame(state, { kind: 'scoped-value' });
}

function* stepMap(state: StreamState, mode: 'after-entry' | 'awaiting-arrow'): Task<void> {
  if (mode === 'after-entry') {
    if (yield* check(state, 'rbrace')) {
      const rb = yield* advance(state);
      state.ready.push({ kind: 'map-end', position: rb.start });
      return;
    }
    yield* consumeSeparatorOrCloseCheck(state, 'rbrace');
    pushFrame(state, { kind: 'map', mode: 'awaiting-arrow' });
    pushFrame(state, { kind: 'data-value' }); // the next key
    return;
  }
  const arrow = yield* expect(state, 'map-arrow-token', "a map entry's '=>'");
  state.ready.push({ kind: 'map-arrow', position: arrow.start });
  pushFrame(state, { kind: 'map', mode: 'after-entry' });
  pushFrame(state, { kind: 'scoped-value' });
}

function* stepArray(state: StreamState, first: boolean): Task<void> {
  if (yield* check(state, 'rbracket')) {
    const rb = yield* advance(state);
    state.ready.push({ kind: 'array-end', position: rb.start });
    return;
  }
  if (!first) {
    yield* consumeSeparatorOrCloseCheck(state, 'rbracket');
  }
  pushFrame(state, { kind: 'array', first: false });
  pushFrame(state, { kind: 'scoped-value' });
}
