/**
 * The raw token cursor shared by {@link dataValueGrammar.ts} and {@link schemaParser.ts} --
 * bounded two-token lookahead directly over a {@link Lexer}, with no event materialisation.
 *
 * This is the schema compiler's counterpart to `stream/dataStream.ts`'s own internal cursor:
 * same shape (a plain state object threaded through generator functions, `current`/`pending`
 * lookahead, `lastEnd` tracking for adjacency and separator checks), reimplemented here rather
 * than imported because `dataStream.ts` builds a *data* document's header and rejects `!!meta`
 * outright (§1.5) -- a schema document's header (`!!id`, mandatory `!!meta`, repeatable
 * `!!import`) and its body grammar (§12.1) are a different production entirely, and the schema
 * grammar additionally needs raw, single-token-at-a-time access to operators
 * (`~ ^ & | ( ) < > ? ; -`) the data grammar's event stream never models. §12.1 states the
 * schema grammar imports [TSON-DATA]'s `annotation`/`data-value`/`core-value`/directive
 * productions at the token level, which is exactly what this module and
 * `dataValueGrammar.ts` (built on it) provide.
 */

import { TsonInternalError, TsonParseError } from '../core/errors.js';
import {
  maxNestingDepthOf,
  nestingLimitRefusal,
  type NestingLimitOptions,
} from '../core/limits.js';
import { START, type Position } from '../core/position.js';
import type { ByteInput, Task } from '../io/bytes.js';
import { createLexer, currentToken, type Lexer } from '../lexer/lexer.js';
import { adjacentTo, type Token, type TokenType } from '../lexer/token.js';
import { isIriReference } from '../atom/network/uri.js';
import { isIdentifierText } from '../unicode/identifier-profile.js';
import { toNfc } from '../unicode/nfc.js';

/** The cursor's whole mutable state, threaded through this module's generator functions. */
export interface CursorState {
  readonly lexer: Lexer;
  /** The next not-yet-consumed token -- populated lazily by {@link peekToken}. */
  current: Token | undefined;
  /** A second lookahead token, buffered only transiently -- {@link peekSecond}. */
  pending: Token | undefined;
  /** End position of the most recently consumed token. */
  lastEnd: Position;
  /**
   * How many levels of nesting are currently open, maintained by {@link nested}.
   *
   * Mutable state on the cursor rather than a parameter threaded through thirty-five mutually
   * recursive productions. That is safe here for a reason worth stating, because the general rule
   * in this codebase is the opposite: a `CursorState` belongs to exactly one `parseSchemaDocument`
   * call, and one parse is a single generator chain that suspends and resumes as a unit. Two
   * parses never share a cursor, so two suspended `Task`s can never interleave on this counter.
   */
  depth: number;
  /** The limit {@link depth} is checked against (§9.1). */
  readonly maxNestingDepth: number;
}

/** Creates a {@link CursorState} over `input`. Nothing is read until driven. */
export function createCursor(input: ByteInput, options?: NestingLimitOptions): CursorState {
  return {
    lexer: createLexer(input),
    current: undefined,
    pending: undefined,
    lastEnd: START,
    depth: 0,
    maxNestingDepth: maxNestingDepthOf(options),
  };
}

/**
 * Runs `body` one level deeper, refusing (§9.1's fifth outcome, `TsonLimitRefusedError`) a
 * document that nests past the cursor's limit.
 *
 * Wrapped around each production that can re-enter itself -- `parseTypeRef` in the schema grammar
 * and `parseCoreValue` in the data-value grammar -- which between them sit on every cycle in
 * either grammar, so guarding those two bounds both. Without it a deeply nested annotation value
 * or type expression in a *schema document* exhausts the host call stack and escapes
 * `resolveSchema`/`compile` as an uncaught `RangeError`, which matters more than the data-side
 * case it mirrors: a schema is routinely fetched from somewhere else.
 *
 * The decrement is in a `finally` so a throw from deeper in the grammar cannot leave the counter
 * raised. The parse is over at that point, but a counter that only ever climbs is the kind of
 * thing that becomes wrong later.
 */
export function* nested<T>(state: CursorState, at: Token, body: () => Task<T>): Task<T> {
  if (state.depth >= state.maxNestingDepth) {
    throw nestingLimitRefusal(state.maxNestingDepth, at.start);
  }
  state.depth += 1;
  try {
    return yield* body();
  } finally {
    state.depth -= 1;
  }
}

function* fetchToken(state: CursorState): Task<Token> {
  const type = yield* state.lexer.nextToken();
  return currentToken(state.lexer, type);
}

export function* peekToken(state: CursorState): Task<Token> {
  state.current ??= yield* fetchToken(state);
  return state.current;
}

/** The token after {@link peekToken}, without consuming either. */
export function* peekSecond(state: CursorState): Task<Token> {
  state.pending ??= yield* fetchToken(state);
  return state.pending;
}

export function* advance(state: CursorState): Task<Token> {
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

export function* check(state: CursorState, type: TokenType): Task<boolean> {
  const t = yield* peekToken(state);
  return t.type === type;
}

/** Consumes a token of `type`, or fails naming `construct` -- the construct the position admits, never the token class that would have satisfied it. */
export function* expect(state: CursorState, type: TokenType, construct: string): Task<Token> {
  const t = yield* peekToken(state);
  if (t.type !== type) throw mismatch(construct, t);
  return yield* advance(state);
}

/** The failure {@link expect} raises, for a throw site that decides on more than one token's type. */
export function mismatch(construct: string, token: Token): TsonParseError {
  const actual = describe(token);
  return new TsonParseError(`expected ${construct}, found ${actual}`, token.start, {
    expected: construct,
    actual,
  });
}

/** A parse failure that states a rule rather than a substitution, so it carries no `expected`/`actual` pair. */
export function parseError(token: Token, message: string): TsonParseError {
  return new TsonParseError(message, token.start);
}

/** One written token as an author would point at it. */
export function describe(t: Token): string {
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

export function isBareTokenType(type: TokenType): boolean {
  switch (type) {
    case 'unquoted-token':
    case 'single-line-token':
    case 'multi-line-token':
      return true;
    default:
      return false;
  }
}

export function tokenFormOf(type: TokenType): 'unquoted' | 'single-line' | 'multi-line' {
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

/** Every token type `{` can be immediately followed by that can only ever be a map key (never a bare field name) -- §2.8. */
export function isAlwaysMapStart(type: TokenType): boolean {
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

export function samePosition(a: Position, b: Position): boolean {
  return a.line === b.line && a.column === b.column && a.offset === b.offset;
}

/**
 * Between elements of a record/map/array (§2.4): a separator (whitespace, a comma, or both) is
 * required unless the closing delimiter is immediately next. **A comma may follow a value**, so a
 * separator that lands right before the closing delimiter simply ends the list -- a trailing
 * comma is ordinary, not a syntax error. What still fails is a comma with nothing behind it: a
 * comma following another comma is caught one level up, where the caller tries to parse the next
 * element and finds a comma sitting in value position, which needs no rule of its own (§2.4) --
 * a comma is not a value. Shared verbatim by the schema grammar's own comma/whitespace-separated
 * lists (type params, type args, record entries, removal names, tuple/array elements) -- §12.1
 * states plainly that a comma may follow the last element of every list in that grammar too.
 */
export function* consumeSeparatorOrCloseCheck(
  state: CursorState,
  closing: TokenType,
): Task<boolean> {
  if (yield* check(state, closing)) return false;

  const t = yield* peekToken(state);
  let sawSeparator = !samePosition(t.start, state.lastEnd);
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
export function* peekDirectiveName(state: CursorState): Task<string | undefined> {
  const name = yield* peekSecond(state);
  return name.type === 'unquoted-token' ? name.text : undefined;
}

/** `"!!" name ":" single-line-token` (§3.3), requiring the directive name to equal `expectedName`. */
export function* parseNamedDirective(state: CursorState, expectedName: string): Task<string> {
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

  // §3.3: a directive's argument is a URI, checked against the same hand-written RFC 3986
  // grammar the `!uri` atom uses -- so this layer and that one can never disagree about what a
  // URI is.
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
 * Whether `type` may spell a field name: `field-name = unquoted-token / single-line-token`
 * (§2.5, §7.4). Narrower than {@link isBareTokenType} by one form -- a map key is a *value* and
 * keeps all three, so the two predicates part company exactly at the §2.8 brace dispatch, where
 * one consumed token and one of lookahead decide which reading a `{` opens.
 */
export function isFieldNameTokenType(type: TokenType): boolean {
  return type === 'unquoted-token' || type === 'single-line-token';
}

/**
 * A field name is an identifier at every layer, schemaless or governed (§2.5, §7.7): `token`'s
 * decoded text, NFC-normalised, matched in full against the identifier grammar. Quoting escapes a
 * lexical accident -- it is relief from what the unquoted form cannot spell, never a wider name
 * set -- so both of {@link isFieldNameTokenType}'s spellings are held to exactly this one check,
 * and it is the *normalised* text that identity and every later comparison sees.
 *
 * Throws naming `construct` when `token`'s form is not one a field name may take at all, and
 * with a dedicated message when the form is right but the decoded text fails the identifier
 * grammar -- the position §2.5 says a key that is not a name belongs in instead.
 */
export function fieldNameText(token: Token, construct: string): string {
  if (!isFieldNameTokenType(token.type)) {
    throw mismatch(construct, token);
  }
  const text = toNfc(token.text);
  if (!isIdentifierText(text)) {
    throw parseError(
      token,
      `'${token.text}' is not an identifier, so it names no field (§2.5, §7.7): a name starts ` +
        "with an XID_Start character and continues with XID_Continue or '-', in NFC -- a key " +
        "that is not a name belongs in a map ('key => value')",
    );
  }
  return text;
}

/** `field-name = unquoted-token / single-line-token` (§2.5, §7.4), held to the identifier grammar (§7.7). */
export function* expectFieldNameToken(state: CursorState, construct: string): Task<Token> {
  const name = yield* peekToken(state);
  const text = fieldNameText(name, construct);
  yield* advance(state);
  return text === name.text ? name : { ...name, text };
}
