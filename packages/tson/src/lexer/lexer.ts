import { TsonInternalError, TsonLexError } from '../core/errors.js';
import { START, position, type Position } from '../core/position.js';
import { NEED_INPUT, type ByteInput, type Task } from '../io/bytes.js';
import {
  isHorizontalSpace,
  isIgnorableFormat,
  isUnquotedTokenContinue,
  isUnquotedTokenNfc,
  isUnquotedTokenStart,
  isWsLineTerm,
} from '../unicode/index.js';
import type { Token, TokenForm, TokenType } from './token.js';

/**
 * Converts TSON source bytes into a stream of {@link TokenType}s per §7.2-§7.3.
 *
 * A single hand-written scanner over UTF-8 bytes pulled from a {@link ByteInput}, decoding
 * UTF-8 itself (§9.1) and addressed one Unicode code point at a time so a supplementary-plane
 * character — valid in an unquoted token per UAX #31 — is never split. At most two code points
 * of lookahead are ever buffered beyond the cursor: every lexical rule here needs to peek at
 * most one or two code points ahead of the current position (`"""` disambiguation, the `..`
 * range-vs-continuation check, `\r\n` pairing), never further — so memory held at any point is
 * bounded regardless of source size, independent of how much of the byte source has arrived.
 *
 * **Complete and frozen for the whole TSON series** (§1.3): higher parts introduce no new
 * tokens, modes, or character-classification rules.
 *
 * {@link Lexer.nextToken} returns only the {@link TokenType}; a token's text, form, and
 * position are read off the accessors beside it (`text`, `form`, `start`, `end`), each valid
 * until the next {@link Lexer.nextToken} call. Splitting them out this way means a caller that
 * never needs to retain a token — the common case in a streaming reader — pays no allocation
 * for one; {@link currentToken} builds a retainable {@link Token} for a caller that does.
 *
 * Errors are fail-fast (thrown as {@link TsonLexError}) rather than the "SHOULD continue
 * processing" recommendation of §8.1 — multi-error recovery belongs to a layer above this one.
 */
export interface Lexer {
  /**
   * Scans the next token, suspending on {@link NEED_INPUT} whenever the byte source starves.
   * Returns the token's {@link TokenType} only — read `text`/`form`/`start`/`end` immediately
   * afterward, before calling this again.
   */
  nextToken(): Task<TokenType>;
  /**
   * The most recently produced token's text (§2.4): for a quoted token, the decoded value —
   * escapes resolved and, for a multi-line token, common indentation stripped. For every other
   * kind, the exact source lexeme.
   */
  readonly text: string;
  /**
   * The most recently produced token's form, present only for the three kinds §2.4 assigns one.
   * Always `TokenForm | undefined` rather than optional (`?`) here: unlike {@link Token.form},
   * this is a getter that always exists, not a property that may be absent from an object.
   */
  readonly form: TokenForm | undefined;
  /** The most recently produced token's start position. */
  readonly start: Position;
  /** The most recently produced token's end position — the live cursor's own position. */
  readonly end: Position;
}

/**
 * Builds a retainable {@link Token} from a lexer's current accessors.
 *
 * Call this immediately after {@link Lexer.nextToken} settles, passing the {@link TokenType} it
 * returned — the accessors it reads are only valid until the next {@link Lexer.nextToken} call.
 */
export function currentToken(lexer: Lexer, type: TokenType): Token {
  const { text, form, start, end } = lexer;
  return form === undefined ? { type, text, start, end } : { type, text, form, start, end };
}

/** Creates a {@link Lexer} over `input`. Nothing is read until {@link Lexer.nextToken} is driven. */
export function createLexer(input: ByteInput): Lexer {
  const state: LexerState = {
    input,
    bytesDecoded: 0,
    sourceExhausted: false,
    bomChecked: false,
    lookahead: [],
    line: 1,
    col: 1,
    byteOffset: 0,
    tokenStart: START,
    tokenText: '',
    tokenForm: undefined,
    lastCodePoint: undefined,
  };

  return {
    nextToken: () => nextToken(state),
    get text() {
      return state.tokenText;
    },
    get form() {
      return state.tokenForm;
    },
    get start() {
      return state.tokenStart;
    },
    get end() {
      return position(state.line, state.col, state.byteOffset);
    },
  };
}

// ── Internal state ──────────────────────────────────────────────────────

/** One code point buffered ahead of the cursor, with the UTF-8 byte length it was decoded from. */
interface LookaheadEntry {
  readonly codePoint: number;
  readonly byteLength: number;
}

/**
 * The lexer's whole mutable state, threaded through the module's generator functions instead of
 * captured by closure — a plain record of cursor position, lookahead, and the most recently
 * produced token, mutated in place by the functions below.
 */
interface LexerState {
  readonly input: ByteInput;
  /** Bytes decoded so far: `byteOffset`'s bytes plus the lookahead's, on the same base (a leading BOM counts toward neither). */
  bytesDecoded: number;
  sourceExhausted: boolean;
  /** Whether the once-only leading-BOM check (§7.1) has run. */
  bomChecked: boolean;
  /** Code points decoded but not yet consumed, front first. Never holds more than two entries. */
  readonly lookahead: LookaheadEntry[];
  line: number;
  col: number;
  byteOffset: number;
  tokenStart: Position;
  tokenText: string;
  tokenForm: TokenForm | undefined;
  /**
   * The last code point {@link advance} consumed, or `undefined` before the first. This is the
   * character on the near side of a whitespace run — half of what {@link skipWhitespace} needs to
   * decide whether an ignorable format control (§7.2 rule 1) sits at a token boundary or inside
   * what would otherwise be one token.
   */
  lastCodePoint: number | undefined;
}

// ── Code points ─────────────────────────────────────────────────────────

const BOM = 0xfeff;
const LF = 0x0a;
const CR = 0x0d;
const NEL = 0x85;
const LS = 0x2028;
const PS = 0x2029;
const TAB = 0x09;
const SPACE = 0x20;
const QUOTE = 0x22; // "
const BACKSLASH = 0x5c;
const UNDERSCORE = 0x5f;
const CP_LBRACE = 0x7b;
const CP_RBRACE = 0x7d;
const CP_LBRACKET = 0x5b;
const CP_RBRACKET = 0x5d;
const CP_COLON = 0x3a;
const CP_COMMA = 0x2c;
const CP_EQUAL = 0x3d;
const CP_BANG = 0x21;
const CP_DOT = 0x2e;
const CP_HYPHEN = 0x2d;
const CP_PLUS = 0x2b;
const CP_GREATER_THAN = 0x3e;
const CP_AT = 0x40;
const CP_AMPERSAND = 0x26;
const CP_LESS_THAN = 0x3c;
const CP_QUESTION = 0x3f;
const CP_TILDE = 0x7e;
const CP_PIPE = 0x7c;
const CP_SEMICOLON = 0x3b;
const CP_LPAREN = 0x28;
const CP_RPAREN = 0x29;
const CP_CARET = 0x5e;

function isLineTerminatorCp(cp: number): boolean {
  return cp === LF || cp === CR || cp === NEL || cp === LS || cp === PS;
}

// ── Code-point text buffer ──────────────────────────────────────────────

/**
 * The largest argument count handed to `String.fromCodePoint` at once — comfortably under every
 * JS engine's call-stack-depth limit for a spread argument list, which the naive
 * `String.fromCodePoint(...allCodePoints)` blows for a token of a few hundred thousand
 * characters. Flushing in chunks keeps a token of any length safe to build.
 */
const CODE_POINT_CHUNK = 8192;

/** Accumulates code points and renders them to a string, chunked so no call ever exceeds {@link CODE_POINT_CHUNK} arguments. */
interface CodePointBuffer {
  push(codePoint: number): void;
  build(): string;
}

function createCodePointBuffer(): CodePointBuffer {
  let result = '';
  let chunk: number[] = [];
  const flush = (): void => {
    if (chunk.length === 0) return;
    result += String.fromCodePoint(...chunk);
    chunk = [];
  };
  return {
    push(codePoint: number): void {
      chunk.push(codePoint);
      if (chunk.length >= CODE_POINT_CHUNK) flush();
    },
    build(): string {
      flush();
      return result;
    },
  };
}

// ── Errors ───────────────────────────────────────────────────────────────

function hex(codePoint: number, digits: number): string {
  return codePoint.toString(16).toUpperCase().padStart(digits, '0');
}

/** An error anchored to this token's own start — used for a malformed token discovered anywhere within it. */
function errorAtTokenStart(state: LexerState, message: string): TsonLexError {
  return new TsonLexError(message, state.tokenStart);
}

/** An error anchored to the live cursor's current position — used mid-token, where the offending character is what a caller needs pointed at. */
function errorHere(state: LexerState, message: string): TsonLexError {
  return new TsonLexError(message, position(state.line, state.col, state.byteOffset));
}

/**
 * A byte sequence that is not UTF-8 is rejected, never replaced (§7.1: a decoder MUST NOT
 * substitute U+FFFD and continue). The byte offset is the offending sequence's own first byte,
 * exactly; line and column name the live cursor, which is at most two code points behind it.
 */
function malformed(state: LexerState, sequenceStart: number, detail: string): TsonLexError {
  return new TsonLexError(
    `the document is not valid UTF-8: ${detail}`,
    position(state.line, state.col, sequenceStart),
  );
}

// ── UTF-8 decoding (§9.1) ───────────────────────────────────────────────

function* nextByte(state: LexerState): Task<number | undefined> {
  while (!state.input.ensure()) {
    if (state.input.ended) return undefined;
    yield NEED_INPUT;
  }
  state.bytesDecoded += 1;
  return state.input.read();
}

/**
 * One code point decoded from {@code state.input}'s bytes, or `undefined` at end of input.
 *
 * UTF-8 only (§9.1 permits UTF-16/UTF-32 but only requires UTF-8; this lexer reads UTF-8
 * exclusively). Overlong forms, encoded surrogates, and values above U+10FFFF are rejected on
 * the same terms as a structurally invalid sequence — two spellings of one character is §9.4's
 * confusability problem one layer down.
 */
function* decodeCodePoint(state: LexerState): Task<number | undefined> {
  const sequenceStart = state.bytesDecoded;
  const first = yield* nextByte(state);
  if (first === undefined) return undefined;
  if (first < 0x80) return first;

  let continuations: number;
  let codePoint: number;
  if ((first & 0xe0) === 0xc0) {
    continuations = 1;
    codePoint = first & 0x1f;
  } else if ((first & 0xf0) === 0xe0) {
    continuations = 2;
    codePoint = first & 0x0f;
  } else if ((first & 0xf8) === 0xf0) {
    continuations = 3;
    codePoint = first & 0x07;
  } else {
    throw malformed(
      state,
      sequenceStart,
      `0x${hex(first, 2)} is not a valid first byte of a UTF-8 sequence`,
    );
  }

  for (let i = 0; i < continuations; i += 1) {
    const next = yield* nextByte(state);
    if (next === undefined) {
      throw malformed(state, sequenceStart, 'the document ends in the middle of a UTF-8 sequence');
    }
    if ((next & 0xc0) !== 0x80) {
      throw malformed(state, sequenceStart, `0x${hex(next, 2)} is not a UTF-8 continuation byte`);
    }
    codePoint = (codePoint << 6) | (next & 0x3f);
  }

  const shortestForm = continuations === 1 ? 0x80 : continuations === 2 ? 0x800 : 0x10000;
  if (codePoint < shortestForm) {
    throw malformed(
      state,
      sequenceStart,
      `U+${hex(codePoint, 4)} is written in ${String(continuations + 1)} bytes where UTF-8 requires the shortest form`,
    );
  }
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
    throw malformed(
      state,
      sequenceStart,
      `U+${hex(codePoint, 4)} is a surrogate code point, which UTF-8 does not encode`,
    );
  }
  if (codePoint > 0x10ffff) {
    throw malformed(
      state,
      sequenceStart,
      `U+${hex(codePoint, 4)} is beyond the last Unicode code point`,
    );
  }
  return codePoint;
}

// ── Cursor primitives ────────────────────────────────────────────────────

/** Decodes code points until the lookahead holds at least `count` entries, or the input is exhausted. */
function* ensureBuffered(state: LexerState, count: number): Task<void> {
  while (state.lookahead.length < count && !state.sourceExhausted) {
    const start = state.bytesDecoded;
    const codePoint = yield* decodeCodePoint(state);
    if (codePoint === undefined) {
      state.sourceExhausted = true;
    } else {
      state.lookahead.push({ codePoint, byteLength: state.bytesDecoded - start });
    }
  }
}

/** Looks `ahead` code points past the cursor without consuming; `undefined` past the end. Never called with `ahead > 1` — the most any rule here needs (§7.2's lookahead rules). */
function* peekAt(state: LexerState, ahead: number): Task<number | undefined> {
  yield* ensureBuffered(state, ahead + 1);
  return state.lookahead[ahead]?.codePoint;
}

/**
 * Consumes and returns the code point at the cursor, counting its byte length into `byteOffset`
 * (counted from the decoder, never re-derived from the decoded value — see this module's own
 * doc comment) and advancing line/column tracking.
 *
 * `\r` defers its line bump to a following `\n`'s own call, so `\r\n` counts as one line
 * terminator; NEL/LS/PS bump immediately, matching `\n`.
 */
function* advance(state: LexerState): Task<number> {
  yield* ensureBuffered(state, 1);
  const entry = state.lookahead.shift();
  if (entry === undefined) {
    throw new TsonInternalError('advance() called with no buffered code point available');
  }
  state.byteOffset += entry.byteLength;
  const codePoint = entry.codePoint;

  if (codePoint === LF || codePoint === NEL || codePoint === LS || codePoint === PS) {
    state.line += 1;
    state.col = 1;
  } else if (codePoint === CR) {
    const next = yield* peekAt(state, 0);
    if (next === LF) {
      // Deferred to the paired LF's own advance() call above.
    } else {
      state.line += 1;
      state.col = 1;
    }
  } else {
    state.col += 1;
  }
  state.lastCodePoint = codePoint;
  return codePoint;
}

/**
 * A single leading BOM is discarded invisibly — not counted toward line/column/byte offset
 * (§7.1: "not a character at offset zero"). A BOM anywhere else falls through to "unrecognised
 * character" naturally. Runs once, on the first {@link nextToken} call.
 */
function* stripLeadingBom(state: LexerState): Task<void> {
  if (state.bomChecked) return;
  state.bomChecked = true;
  const first = yield* peekAt(state, 0);
  if (first === BOM) {
    const entry = state.lookahead.shift();
    if (entry !== undefined) state.bytesDecoded -= entry.byteLength;
  }
}

// ── Whitespace (§7.2 rule 1, §7.4's `ws`/`ws1`) ─────────────────────────

/** An ignorable format control found mid-run, with the position it started at, for {@link requireTokenBoundary}'s error. */
interface IgnorableOccurrence {
  readonly control: number;
  readonly at: Position;
}

/**
 * Consumes the `Pattern_White_Space` run before a token, holding UAX #31 requirement R3a-1's two
 * treatments apart (§7.2 rule 1).
 *
 * **LRM and RLM are not horizontal space.** R3a-1 sorts `Pattern_White_Space` into end-of-line and
 * horizontal space (ordinary separators, unconditionally legal) and *ignorable format controls* —
 * LRM (U+200E) and RLM (U+200F), the two members carrying `Default_Ignorable_Code_Point` — which
 * are consumed and contribute nothing (they neither separate nor join tokens) but are legal only
 * where a token boundary already exists: adjacent to horizontal space or a line terminator, at the
 * start or end of a line, or between two tokens a structural or special token already separates.
 * Folding them into ordinary whitespace instead is what would let `[1<LRM>2]` read as two elements
 * and `ad<LRM>min` lex as two tokens — an insertion that plainly changes the document's meaning,
 * and invisibly (§9.5 rests on this being refused).
 *
 * The check follows R3a-1's own stated strategy: since these controls are legal only where a
 * boundary would, in their absence, already exist, a control is consumed unconditionally and a
 * run holding no *real* separator is illegal exactly when the code points on either side of the
 * whole run would otherwise have continued one unquoted token — decided once, after the run ends,
 * by looking at the code point last advanced past before this call ({@link
 * LexerState.lastCodePoint}) and whatever code point the cursor now sits on.
 */
function* skipWhitespace(state: LexerState): Task<void> {
  const precedingCodePoint = state.lastCodePoint;
  let sawRealSeparator = false;
  let ignorable: IgnorableOccurrence | undefined;
  for (;;) {
    const cp = yield* peekAt(state, 0);
    if (cp === undefined) break;
    if (isIgnorableFormat(cp)) {
      ignorable ??= { control: cp, at: position(state.line, state.col, state.byteOffset) };
    } else if (isHorizontalSpace(cp) || isWsLineTerm(cp)) {
      sawRealSeparator = true;
    } else {
      break;
    }
    yield* advance(state);
  }
  if (ignorable !== undefined && !sawRealSeparator) {
    yield* requireTokenBoundary(state, precedingCodePoint, ignorable);
  }
}

/**
 * Refuses an ignorable format control that stands inside what would otherwise be one unquoted
 * token, rather than at a boundary — see {@link skipWhitespace}. Both neighbours continuing a
 * token is what says the two would have been one token without it; a run adjacent to real
 * horizontal space or a line terminator never reaches here, {@link skipWhitespace} calling this
 * only once the whole run has been found to hold no such separator.
 */
function* requireTokenBoundary(
  state: LexerState,
  precedingCodePoint: number | undefined,
  ignorable: IgnorableOccurrence,
): Task<void> {
  const following = yield* peekAt(state, 0);
  if (!continuesAToken(precedingCodePoint) || !continuesAToken(following)) return;
  if (following === CP_DOT && (yield* peekAt(state, 1)) === CP_DOT) return; // `..` terminates the token regardless (§7.2 rule 3)
  // Both continuesAToken checks above are type predicates, so precedingCodePoint and following
  // are narrowed to `number` here — no assertion needed to hand them to String.fromCodePoint.
  throw new TsonLexError(
    `${nameOfIgnorableFormat(ignorable.control)} stands between '${String.fromCodePoint(precedingCodePoint)}' and ` +
      `'${String.fromCodePoint(following)}', which without it are one token — an ignorable format ` +
      `control may only stand where a token boundary already exists. Remove it, or quote the token to keep it ` +
      `as content`,
    ignorable.at,
  );
}

/** Whether `cp` would carry on an unquoted token — the test for "these two would have been one token". */
function continuesAToken(cp: number | undefined): cp is number {
  return cp !== undefined && isUnquotedTokenContinue(cp);
}

/** The two ignorable format controls, spelled for a message; nothing else reaches here. */
function nameOfIgnorableFormat(control: number): string {
  return control === 0x200e ? 'U+200E LEFT-TO-RIGHT MARK' : 'U+200F RIGHT-TO-LEFT MARK';
}

function* skipSpacesTabs(state: LexerState): Task<void> {
  for (;;) {
    const cp = yield* peekAt(state, 0);
    if (cp !== SPACE && cp !== TAB) return;
    yield* advance(state);
  }
}

function* consumeLineTerminator(state: LexerState): Task<void> {
  const cp = yield* peekAt(state, 0);
  if (cp === CR) {
    yield* advance(state);
    if ((yield* peekAt(state, 0)) === LF) yield* advance(state);
  } else {
    yield* advance(state);
  }
}

// ── Unquoted tokens (§7.1, §7.2.1) ──────────────────────────────────────

/**
 * Finishes an unquoted token: checks it is NFC-normalized (§7.2.1 — unquoted tokens only; a
 * quoted token's exact content is exempt) and rejects it otherwise, guarded by `maxCodePoint` so
 * a plain ASCII token — the overwhelming common case — never pays for the allocating
 * `normalize()` call.
 */
function finishUnquoted(
  state: LexerState,
  buffer: CodePointBuffer,
  maxCodePoint: number,
): TokenType {
  const text = buffer.build();
  if (!isUnquotedTokenNfc(text, maxCodePoint)) {
    throw errorAtTokenStart(state, `unquoted token '${text}' is not NFC-normalized`);
  }
  return finish(state, 'unquoted-token', text, 'unquoted');
}

/** Consumes unquoted-continuation characters, stopping before a `..` run (§7.2 rule 3). Returns the running maximum code point seen, for {@link finishUnquoted}'s guarded NFC check. */
function* scanUnquotedContinuation(
  state: LexerState,
  buffer: CodePointBuffer,
  maxCodePointIn: number,
): Task<number> {
  let maxCodePoint = maxCodePointIn;
  for (;;) {
    const cp = yield* peekAt(state, 0);
    if (cp === undefined) return maxCodePoint;
    if (cp === CP_DOT) {
      if ((yield* peekAt(state, 1)) === CP_DOT) return maxCodePoint;
      buffer.push(yield* advance(state));
      if (cp > maxCodePoint) maxCodePoint = cp;
      continue;
    }
    if (!isUnquotedTokenContinue(cp)) return maxCodePoint;
    buffer.push(yield* advance(state));
    if (cp > maxCodePoint) maxCodePoint = cp;
  }
}

function* lexUnquoted(state: LexerState): Task<TokenType> {
  const buffer = createCodePointBuffer();
  const first = yield* advance(state);
  buffer.push(first);
  const maxCodePoint = yield* scanUnquotedContinuation(state, buffer, first);
  return finishUnquoted(state, buffer, maxCodePoint);
}

// ── Compound-token lookahead (§7.2.4) ───────────────────────────────────

function* lexEqualsOrMapArrow(state: LexerState): Task<TokenType> {
  yield* advance(state); // '='
  if ((yield* peekAt(state, 0)) === CP_GREATER_THAN) {
    yield* advance(state);
    return finish(state, 'map-arrow-token', '=>');
  }
  return finish(state, 'equal', '=');
}

function* lexBangOrDirective(state: LexerState): Task<TokenType> {
  yield* advance(state); // '!'
  if ((yield* peekAt(state, 0)) === CP_BANG) {
    yield* advance(state);
    return finish(state, 'directive-token', '!!');
  }
  return finish(state, 'bang', '!');
}

function* lexDotOrRangeOrUnquoted(state: LexerState): Task<TokenType> {
  yield* advance(state); // '.'
  const next = yield* peekAt(state, 0);
  if (next === CP_DOT) {
    yield* advance(state);
    return finish(state, 'range-token', '..');
  }
  if (next !== undefined && isUnquotedTokenContinue(next)) {
    const buffer = createCodePointBuffer();
    buffer.push(CP_DOT);
    const maxCodePoint = yield* scanUnquotedContinuation(state, buffer, CP_DOT);
    return finishUnquoted(state, buffer, maxCodePoint);
  }
  throw errorAtTokenStart(
    state,
    `unexpected character '.': a bare '.' has no grammar role; write "." (quoted) for a literal dot`,
  );
}

function* lexSignOrUnquoted(state: LexerState, signCp: number): Task<TokenType> {
  yield* advance(state); // sign
  const next = yield* peekAt(state, 0);
  if (next !== undefined && isUnquotedTokenContinue(next)) {
    const buffer = createCodePointBuffer();
    buffer.push(signCp);
    const maxCodePoint = yield* scanUnquotedContinuation(state, buffer, signCp);
    return finishUnquoted(state, buffer, maxCodePoint);
  }
  if (signCp === CP_HYPHEN) {
    return finish(state, 'minus', '-');
  }
  throw errorAtTokenStart(
    state,
    `unexpected character '+': a bare '+' has no grammar role; write "+" (quoted) for a literal plus sign`,
  );
}

// ── Special tokens (§7.2.5) ─────────────────────────────────────────────

/** The closed special-token set (§7.2.5), less `!` and `-`, which reach their token kinds only through the compound-lookahead dispatch above. */
function specialTokenType(cp: number): TokenType | undefined {
  switch (cp) {
    case CP_AT:
      return 'at';
    case CP_AMPERSAND:
      return 'ampersand';
    case CP_LESS_THAN:
      return 'less-than';
    case CP_GREATER_THAN:
      return 'greater-than';
    case CP_QUESTION:
      return 'question';
    case CP_TILDE:
      return 'tilde';
    case CP_PIPE:
      return 'pipe';
    case CP_SEMICOLON:
      return 'semicolon';
    case CP_LPAREN:
      return 'lparen';
    case CP_RPAREN:
      return 'rparen';
    case CP_CARET:
      return 'caret';
    default:
      return undefined;
  }
}

// ── Escape decoding, shared by single-line and multi-line tokens ───────
// (§7.2.2; multi-line applies this after whitespace stripping, §7.2.3 rule 5)
// Both always report against this token's own start: decoding runs after the live cursor has
// already moved past the whole token, so there is no "current position" left to report against.

function isHighSurrogateUnit(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogateUnit(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function hexDigitValue(char: string): number {
  const c = char.charCodeAt(0);
  if (c >= 0x30 && c <= 0x39) return c - 0x30; // 0-9
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10; // A-F
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10; // a-f
  return -1;
}

/** Reads four hex digits starting at `text[idx]`, returning the value and the index past them. */
function readHex4(state: LexerState, text: string, idx: number): readonly [number, number] {
  if (idx + 4 > text.length) throw errorAtTokenStart(state, 'incomplete unicode escape');
  let value = 0;
  for (let k = 0; k < 4; k += 1) {
    const digit = hexDigitValue(text.charAt(idx + k));
    if (digit < 0) throw errorAtTokenStart(state, 'invalid hex digit in unicode escape');
    value = (value << 4) | digit;
  }
  return [value, idx + 4];
}

/** Decodes a `\uXXXX` escape (surrogate pairs included) starting just past the `u`. Returns the decoded text and the index past it. */
function decodeUnicodeEscape(
  state: LexerState,
  text: string,
  idx: number,
): readonly [string, number] {
  const [unit, afterFirst] = readHex4(state, text, idx);
  if (isHighSurrogateUnit(unit)) {
    if (
      afterFirst + 1 < text.length &&
      text.charAt(afterFirst) === '\\' &&
      text.charAt(afterFirst + 1) === 'u'
    ) {
      const [unit2, afterSecond] = readHex4(state, text, afterFirst + 2);
      if (!isLowSurrogateUnit(unit2)) {
        throw errorAtTokenStart(
          state,
          'high surrogate escape not followed by a low surrogate escape',
        );
      }
      return [String.fromCharCode(unit, unit2), afterSecond];
    }
    throw errorAtTokenStart(state, 'high surrogate escape not followed by a low surrogate escape');
  }
  if (isLowSurrogateUnit(unit)) {
    throw errorAtTokenStart(state, 'lone low surrogate escape');
  }
  return [String.fromCharCode(unit), afterFirst];
}

/** Decodes one escape sequence starting at `text[i] === '\\'`. Returns the decoded text and the index past it. */
function decodeEscapeSequence(
  state: LexerState,
  text: string,
  i: number,
): readonly [string, number] {
  const idx = i + 1; // skip the backslash
  if (idx >= text.length) throw errorAtTokenStart(state, 'unterminated escape sequence');
  const e = text.charAt(idx);
  switch (e) {
    case '"':
      return ['"', idx + 1];
    case '\\':
      return ['\\', idx + 1];
    case '/':
      return ['/', idx + 1];
    case 'b':
      return ['\b', idx + 1];
    case 'f':
      return ['\f', idx + 1];
    case 'n':
      return ['\n', idx + 1];
    case 'r':
      return ['\r', idx + 1];
    case 't':
      return ['\t', idx + 1];
    case 's':
      return [' ', idx + 1];
    case 'u':
      return decodeUnicodeEscape(state, text, idx + 1);
    default:
      throw errorAtTokenStart(state, `invalid escape sequence '\\${e}'`);
  }
}

/**
 * `raw` with every escape sequence replaced by what it denotes — `raw` itself when it holds
 * none, which is the common case and the whole reason for the check: decoding would otherwise
 * build a second copy of a token's text to discover that it already had the right one.
 */
function decodeAllEscapes(state: LexerState, raw: string): string {
  if (!raw.includes('\\')) return raw;
  let result = '';
  let i = 0;
  while (i < raw.length) {
    const c = raw.charAt(i);
    if (c === '\\') {
      const [text, next] = decodeEscapeSequence(state, raw, i);
      result += text;
      i = next;
    } else {
      result += c;
      i += 1;
    }
  }
  return result;
}

// ── Quoted tokens (§7.2.2, §7.2.3) ──────────────────────────────────────

function* lexSingleLineToken(state: LexerState): Task<TokenType> {
  const buffer = createCodePointBuffer();
  let escaped = false;
  for (;;) {
    const cp = yield* peekAt(state, 0);
    if (cp === undefined) throw errorAtTokenStart(state, 'unterminated single-line token');
    if (cp === QUOTE) {
      yield* advance(state);
      break;
    }
    if (cp === BACKSLASH) {
      escaped = true;
      buffer.push(yield* advance(state));
      if ((yield* peekAt(state, 0)) === undefined) {
        throw errorHere(state, 'unterminated escape sequence');
      }
      buffer.push(yield* advance(state));
      continue;
    }
    if (cp < 0x20) {
      throw errorHere(
        state,
        `control character U+${hex(cp, 4)} not permitted unescaped in a single-line token`,
      );
    }
    if (cp === NEL || cp === LS || cp === PS) {
      throw errorHere(
        state,
        `line terminator U+${hex(cp, 4)} not permitted unescaped in a single-line token; use \\u${hex(cp, 4)}`,
      );
    }
    buffer.push(yield* advance(state));
  }
  const text = buffer.build();
  return finish(
    state,
    'single-line-token',
    escaped ? decodeAllEscapes(state, text) : text,
    'single-line',
  );
}

/** Reads characters up to (not including) the next line terminator or end of input. */
function* readRawLine(state: LexerState): Task<string> {
  const buffer = createCodePointBuffer();
  for (;;) {
    const cp = yield* peekAt(state, 0);
    if (cp === undefined || isLineTerminatorCp(cp)) return buffer.build();
    buffer.push(yield* advance(state));
  }
}

function leadingWhitespace(line: string): string {
  let i = 0;
  while (i < line.length && (line.charAt(i) === ' ' || line.charAt(i) === '\t')) i += 1;
  return line.slice(0, i);
}

function stripTrailing(line: string): string {
  let end = line.length;
  while (end > 0 && (line.charAt(end - 1) === ' ' || line.charAt(end - 1) === '\t')) end -= 1;
  return line.slice(0, end);
}

function isBlankLine(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    const c = line.charAt(i);
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** The longest prefix `a` and `b` share, compared character by character — a tab never matches a space (§7.2.3 rule 2). */
function commonCharPrefix(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charAt(i) === b.charAt(i)) i += 1;
  return a.slice(0, i);
}

/** Strips the longest leading portion of `line` that matches `prefix` character by character; never an error, even for a partial match (§7.2.3 rule 2). */
function removePrefix(line: string, prefix: string): string {
  let i = 0;
  while (i < prefix.length && i < line.length && line.charAt(i) === prefix.charAt(i)) i += 1;
  return line.slice(i);
}

/**
 * Decides whether one line of a multi-line token is the closing delimiter. Must be handed the
 * line content *after* its leading whitespace is removed (§7.2.3 permits an indented closing
 * `"""`) — testing the raw line instead makes every indented closing delimiter unmatched and
 * every multi-line token spuriously "unterminated".
 */
function isClosingDelimiterContent(trimmed: string): boolean {
  if (!trimmed.startsWith('"""')) return false;
  const rest = trimmed.slice(3);
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest.charAt(i);
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** The common leading-whitespace prefix of every non-blank content line and the closing delimiter line (§7.2.3 rule 2). Blank lines do not participate. */
function computeCommonPrefix(contentLines: readonly string[], closingIndent: string): string {
  let common = closingIndent;
  for (const line of contentLines) {
    if (isBlankLine(line)) continue;
    common = commonCharPrefix(common, leadingWhitespace(line));
  }
  return common;
}

/** Scans the raw content lines of a multi-line token up to and including the closing delimiter line, consuming its trailing line terminator too. */
function* scanMultilineBody(
  state: LexerState,
): Task<{ readonly contentLines: readonly string[]; readonly closingIndent: string }> {
  const contentLines: string[] = [];
  for (;;) {
    if ((yield* peekAt(state, 0)) === undefined) {
      throw errorAtTokenStart(state, 'unterminated multi-line token');
    }
    const rawLine = yield* readRawLine(state);
    const indent = leadingWhitespace(rawLine);
    const afterIndent = rawLine.slice(indent.length);
    if (isClosingDelimiterContent(afterIndent)) {
      if ((yield* peekAt(state, 0)) !== undefined) yield* consumeLineTerminator(state);
      return { contentLines, closingIndent: indent };
    }
    contentLines.push(rawLine);
    if ((yield* peekAt(state, 0)) === undefined) {
      throw errorAtTokenStart(state, 'unterminated multi-line token');
    }
    yield* consumeLineTerminator(state);
  }
}

function* lexMultilineToken(state: LexerState): Task<TokenType> {
  // The opening """ is already consumed.
  yield* skipSpacesTabs(state);
  const afterOpen = yield* peekAt(state, 0);
  if (afterOpen !== undefined && !isLineTerminatorCp(afterOpen)) {
    throw errorHere(state, 'content not permitted after the opening """ of a multi-line token');
  }
  if (afterOpen !== undefined) yield* consumeLineTerminator(state);

  const { contentLines, closingIndent } = yield* scanMultilineBody(state);
  const prefix = computeCommonPrefix(contentLines, closingIndent);

  const decodedLines = contentLines.map((line) =>
    decodeAllEscapes(state, stripTrailing(removePrefix(line, prefix))),
  );
  return finish(state, 'multi-line-token', decodedLines.join('\n'), 'multi-line');
}

function* lexQuoted(state: LexerState): Task<TokenType> {
  yield* advance(state); // opening '"'
  const p0 = yield* peekAt(state, 0);
  const p1 = yield* peekAt(state, 1);
  if (p0 === QUOTE && p1 === QUOTE) {
    yield* advance(state);
    yield* advance(state);
    return yield* lexMultilineToken(state);
  }
  return yield* lexSingleLineToken(state);
}

// ── Token finish and main entry ─────────────────────────────────────────

function finish(state: LexerState, type: TokenType, text: string, form?: TokenForm): TokenType {
  state.tokenText = text;
  state.tokenForm = form;
  return type;
}

/** Scans the next token (§7.2, §7.3), including a trailing `eof` once the input is exhausted. */
function* nextToken(state: LexerState): Task<TokenType> {
  yield* stripLeadingBom(state);
  yield* skipWhitespace(state);
  state.tokenStart = position(state.line, state.col, state.byteOffset);

  const cp = yield* peekAt(state, 0);
  if (cp === undefined) return finish(state, 'eof', '');

  if (cp === QUOTE) return yield* lexQuoted(state);
  if (cp === UNDERSCORE) {
    yield* advance(state);
    return finish(state, 'absent-token', '_');
  }
  if (cp === CP_LBRACE) {
    yield* advance(state);
    return finish(state, 'lbrace', '{');
  }
  if (cp === CP_RBRACE) {
    yield* advance(state);
    return finish(state, 'rbrace', '}');
  }
  if (cp === CP_LBRACKET) {
    yield* advance(state);
    return finish(state, 'lbracket', '[');
  }
  if (cp === CP_RBRACKET) {
    yield* advance(state);
    return finish(state, 'rbracket', ']');
  }
  if (cp === CP_COLON) {
    yield* advance(state);
    return finish(state, 'colon', ':');
  }
  if (cp === CP_COMMA) {
    yield* advance(state);
    return finish(state, 'comma', ',');
  }
  if (cp === CP_EQUAL) return yield* lexEqualsOrMapArrow(state);
  if (cp === CP_BANG) return yield* lexBangOrDirective(state);
  if (cp === CP_DOT) return yield* lexDotOrRangeOrUnquoted(state);
  if (cp === CP_HYPHEN || cp === CP_PLUS) return yield* lexSignOrUnquoted(state, cp);
  if (isUnquotedTokenStart(cp)) return yield* lexUnquoted(state);

  const special = specialTokenType(cp);
  if (special !== undefined) {
    yield* advance(state);
    return finish(state, special, String.fromCodePoint(cp));
  }

  throw errorAtTokenStart(state, `unrecognised character U+${hex(cp, 4)}`);
}
