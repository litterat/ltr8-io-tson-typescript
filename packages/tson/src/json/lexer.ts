/**
 * Converts JSON source bytes into a stream of {@link JsonTokenType}s — RFC 8259 §2–§7 under
 * [TSON-JSON] §3.1's accepted profile. A single hand-written scanner over UTF-8 bytes pulled from
 * a {@link ByteInput}, decoding UTF-8 itself and addressed one Unicode code point at a time —
 * never a host regex (`CLAUDE.md`'s number-grammar rule; this lexer is the JSON analogue of
 * `lexer/lexer.ts` and holds the same constraint for the same reason: a grammar expressed as a
 * regex is expressed in a dialect no other language shares).
 *
 * §3.1's profile, at the points that reach this layer:
 *
 * - **UTF-8, decoded here**, reusing `io/utf8.ts`'s {@link decodeCodePoint} — the same decoder the
 *   TSON text lexer uses, so a malformed sequence is refused identically by both encodings. A
 *   single leading BOM is discarded and counts toward neither line, column, nor byte offset; a BOM
 *   anywhere else is an ordinary character.
 * - **Strings decode to Unicode scalar sequences.** A well-formed `😀` pair is one
 * character — the pairing mechanism is JSON's own, and this profile accepts JSON's grammar; an
 * escape that would decode to a lone surrogate is refused, not repaired.
 * - **A number is kept as its exact source lexeme.** Nothing here converts it: §5.3 preserves an
 *   exact number's digits and scale, and §3.1 forbids rounding one silently.
 *
 * {@link JsonLexer.nextToken} returns only the {@link JsonTokenType}; the token's text and
 * position are read off the accessors beside it, valid until the next `nextToken` call — the same
 * shape `lexer/lexer.ts` settled on, so a caller that never retains a token pays no allocation for
 * one.
 *
 * Errors are fail-fast, thrown as {@link TsonLexError} (`core/errors.ts`) — every failure this
 * module raises is "malformed JSON text" in [TSON-JSON] §9.4's table, which is the *lexer* error
 * row; `json/stream.ts`'s structural failures are the *parser* row and throw
 * {@link TsonParseError} instead. Reusing the TSON text stack's own two error classes rather than
 * inventing a JSON-specific pair is a deliberate simplification — see `json/index.ts`'s own
 * top-of-package note and `IDIOM-DEBT.md`.
 */
import { TsonInternalError, TsonLexError } from '../core/errors.js';
import { START, position, type Position } from '../core/position.js';
// Referenced only from a TSDoc {@link} tag below, which the unused-vars rule cannot see -- see
// `core/diagnostic.ts`'s own copy of this note.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { NEED_INPUT, type ByteInput, type Task } from '../io/bytes.js';
import { decodeCodePoint } from '../io/utf8.js';

/**
 * The complete token vocabulary of RFC 8259 — six structural characters, three literal names, and
 * the two value tokens, plus `eof`. Closed by the RFC rather than by this implementation: §3.1
 * adds no JSON syntax and takes none away, so there is no comment, no trailing comma, no unquoted
 * member name, and no `NaN`/`Infinity` token here.
 */
export type JsonTokenType =
  | 'begin-object'
  | 'end-object'
  | 'begin-array'
  | 'end-array'
  | 'name-separator'
  | 'value-separator'
  | 'string'
  | 'number'
  | 'true'
  | 'false'
  | 'null'
  | 'eof';

/**
 * One lexical JSON token, as a retainable snapshot. `text` is the token's logical content: a
 * `string`'s escape-decoded value, a `number`'s exact source lexeme, every other kind's own
 * spelling.
 */
export interface JsonToken {
  readonly type: JsonTokenType;
  readonly text: string;
  readonly start: Position;
  readonly end: Position;
}

/**
 * The live scanner surface, structurally mirroring the reference implementation's own
 * `JsonLexer`. `text`/`start`/`end` describe whichever token {@link nextToken} most recently
 * produced.
 */
export interface JsonLexer {
  /** Scans the next token, suspending on {@link NEED_INPUT} whenever the byte source starves. */
  nextToken(): Task<JsonTokenType>;
  readonly text: string;
  readonly start: Position;
  readonly end: Position;
}

/** Builds a retainable {@link JsonToken} from a lexer's current accessors, given the type {@link JsonLexer.nextToken} just returned. */
export function currentJsonToken(lexer: JsonLexer, type: JsonTokenType): JsonToken {
  return { type, text: lexer.text, start: lexer.start, end: lexer.end };
}

/** Creates a {@link JsonLexer} over `input`. Nothing is read until {@link JsonLexer.nextToken} is driven. */
export function createJsonLexer(input: ByteInput): JsonLexer {
  const state: State = {
    input,
    sourceExhausted: false,
    bomChecked: false,
    lookahead: undefined,
    line: 1,
    col: 1,
    byteOffset: 0,
    tokenStart: START,
    tokenText: '',
  };
  return {
    nextToken: () => nextToken(state),
    get text() {
      return state.tokenText;
    },
    get start() {
      return state.tokenStart;
    },
    get end() {
      return position(state.line, state.col, state.byteOffset);
    },
  };
}

// ── Internal state ──────────────────────────────────────────────────────────────────────────

interface Lookahead {
  readonly codePoint: number;
  readonly byteLength: number;
}

/** One code point of lookahead is all RFC 8259's grammar ever needs. */
interface State {
  readonly input: ByteInput;
  sourceExhausted: boolean;
  bomChecked: boolean;
  lookahead: Lookahead | undefined;
  line: number;
  col: number;
  byteOffset: number;
  tokenStart: Position;
  tokenText: string;
}

const BOM = 0xfeff;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

// ── Errors ───────────────────────────────────────────────────────────────────────────────────

function errorAtTokenStart(state: State, message: string): TsonLexError {
  return new TsonLexError(message, state.tokenStart);
}

function errorHere(state: State, message: string): TsonLexError {
  return new TsonLexError(message, position(state.line, state.col, state.byteOffset));
}

function hex(codePoint: number, digits: number): string {
  return codePoint.toString(16).toUpperCase().padStart(digits, '0');
}

// ── Cursor primitives ────────────────────────────────────────────────────────────────────────

function* ensureBuffered(state: State): Task<void> {
  if (state.lookahead !== undefined || state.sourceExhausted) return;
  // Only ever one code point ahead of the cursor, so the bytes decoded so far are exactly
  // `byteOffset` — nothing is buffered yet for this call to have run at all.
  const decoded = yield* decodeCodePoint(
    state.input,
    position(state.line, state.col, state.byteOffset),
  );
  if (decoded === undefined) {
    state.sourceExhausted = true;
  } else {
    state.lookahead = { codePoint: decoded.codePoint, byteLength: decoded.byteLength };
  }
}

/** The code point at the cursor without consuming it; `undefined` at end of input. */
function* peekCp(state: State): Task<number | undefined> {
  yield* ensureBuffered(state);
  return state.lookahead?.codePoint;
}

/**
 * Consumes and returns the code point at the cursor, counting its bytes and advancing
 * line/column. `\r\n` is one line break, the bump deferred to the paired `\n`'s own call; NEL/LS/
 * PS are ordinary characters here (RFC 8259 knows four whitespace characters, not [TSON-DATA]
 * §7.2's eleven), so only `\n` and a lone `\r` bump the line.
 */
function* advance(state: State): Task<number> {
  yield* ensureBuffered(state);
  const entry = state.lookahead;
  if (entry === undefined) {
    throw new TsonInternalError('advance() called with no buffered code point available');
  }
  state.lookahead = undefined;
  state.byteOffset += entry.byteLength;
  const cp = entry.codePoint;
  if (cp === 0x0a) {
    state.line += 1;
    state.col = 1;
  } else if (cp === 0x0d) {
    const next = yield* peekCp(state);
    if (next !== 0x0a) {
      state.line += 1;
      state.col = 1;
    }
  } else {
    state.col += 1;
  }
  return cp;
}

/** A single leading BOM is discarded invisibly (§3.1) — not counted toward line/column/byte offset. Runs once. */
function* stripLeadingBom(state: State): Task<void> {
  if (state.bomChecked) return;
  state.bomChecked = true;
  const cp = yield* peekCp(state);
  if (cp === BOM) {
    // Never reached `advance()`, so `byteOffset` was never bumped for it — simply drop it.
    state.lookahead = undefined;
  }
}

/** Space, horizontal tab, line feed, carriage return — RFC 8259's four, and no others. */
function isJsonWhitespace(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d;
}

function* skipWhitespace(state: State): Task<void> {
  for (;;) {
    const cp = yield* peekCp(state);
    if (cp === undefined || !isJsonWhitespace(cp)) return;
    yield* advance(state);
  }
}

// ── Strings (RFC 8259 §7, under §3.1's well-formedness rule) ───────────────────────────────────

function isHighSurrogate(cp: number): boolean {
  return cp >= 0xd800 && cp <= 0xdbff;
}
function isLowSurrogate(cp: number): boolean {
  return cp >= 0xdc00 && cp <= 0xdfff;
}

/** Exactly four hexadecimal digits, as a value in `0..0xFFFF`. */
function* hex4(state: State): Task<number> {
  let value = 0;
  for (let i = 0; i < 4; i += 1) {
    const cp = yield* peekCp(state);
    const digit = cp === undefined ? -1 : hexDigitValue(cp);
    if (digit < 0) throw errorHere(state, 'a \\u escape takes four hexadecimal digits');
    yield* advance(state);
    value = (value << 4) | digit;
  }
  return value;
}

function hexDigitValue(cp: number): number {
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
  if (cp >= 0x41 && cp <= 0x46) return cp - 0x41 + 10;
  if (cp >= 0x61 && cp <= 0x66) return cp - 0x61 + 10;
  return -1;
}

/**
 * `\uXXXX`, the `u` already consumed — and its surrogate pairing, the whole of §3.1's string
 * well-formedness rule. A high surrogate must be followed by a `\u` escape naming a low one; a
 * high surrogate followed by anything else, and a low surrogate standing alone, name no scalar
 * value and are errors — the I-JSON (RFC 7493) reading, which RFC 8259 permits.
 */
function* scanUnicodeEscape(state: State): Task<string> {
  const first = yield* hex4(state);
  if (isLowSurrogate(first)) {
    throw errorHere(
      state,
      `\\u${hex(first, 4)} is a low surrogate with no high surrogate before it`,
    );
  }
  if (!isHighSurrogate(first)) {
    return String.fromCharCode(first);
  }
  if ((yield* peekCp(state)) !== BACKSLASH) {
    throw errorHere(
      state,
      `\\u${hex(first, 4)} is a high surrogate with no \\u escape after it to pair with`,
    );
  }
  yield* advance(state);
  if ((yield* peekCp(state)) !== 0x75 /* 'u' */) {
    throw errorHere(
      state,
      `\\u${hex(first, 4)} is a high surrogate and the escape after it is not \\u`,
    );
  }
  yield* advance(state);
  const second = yield* hex4(state);
  if (!isLowSurrogate(second)) {
    throw errorHere(
      state,
      `\\u${hex(second, 4)} follows the high surrogate \\u${hex(first, 4)} and is not a low surrogate`,
    );
  }
  return String.fromCharCode(first) + String.fromCharCode(second);
}

/** One escape sequence, the backslash already consumed. */
function* scanEscape(state: State): Task<string> {
  const cp = yield* peekCp(state);
  if (cp === undefined) throw errorAtTokenStart(state, 'the document ends inside a string');
  switch (cp) {
    // `\/` is JSON's own escape and stays here: this is a JSON lexer, and [TSON-DATA] §7.2.2's
    // decision to drop it from the text encoding (its own table had labelled it "(JSON compat)")
    // is a debt to this format that this format never owed itself.
    case QUOTE:
    case BACKSLASH:
    case 0x2f /* / */:
      yield* advance(state);
      return String.fromCodePoint(cp);
    case 0x62 /* b */:
      yield* advance(state);
      return '\b';
    case 0x66 /* f */:
      yield* advance(state);
      return '\f';
    case 0x6e /* n */:
      yield* advance(state);
      return '\n';
    case 0x72 /* r */:
      yield* advance(state);
      return '\r';
    case 0x74 /* t */:
      yield* advance(state);
      return '\t';
    case 0x75 /* u */:
      yield* advance(state);
      return yield* scanUnicodeEscape(state);
    default:
      throw errorHere(state, `'${String.fromCodePoint(cp)}' is not a JSON escape character`);
  }
}

/**
 * A quoted string, escape-decoded. Two rules beyond RFC 8259's grammar, both §3.1's: an unescaped
 * control character (U+0000–U+001F) is an error, and the decoded text is a sequence of Unicode
 * scalar values, so a lone surrogate escape is refused rather than repaired (see
 * {@link scanUnicodeEscape}).
 */
function* scanString(state: State): Task<string> {
  yield* advance(state); // opening quote
  let text = '';
  for (;;) {
    const cp = yield* peekCp(state);
    if (cp === undefined) throw errorAtTokenStart(state, 'the document ends inside a string');
    if (cp === QUOTE) {
      yield* advance(state);
      return text;
    }
    if (cp === BACKSLASH) {
      yield* advance(state);
      text += yield* scanEscape(state);
      continue;
    }
    if (cp < 0x20) {
      throw errorHere(state, `U+${hex(cp, 4)} must be escaped inside a string`);
    }
    yield* advance(state);
    text += String.fromCodePoint(cp);
  }
}

// ── Numbers (RFC 8259 §6) ────────────────────────────────────────────────────────────────────

function isDigit(cp: number | undefined): cp is number {
  return cp !== undefined && cp >= 0x30 && cp <= 0x39;
}

function* digits(state: State): Task<string> {
  let out = '';
  for (;;) {
    const cp = yield* peekCp(state);
    if (!isDigit(cp)) return out;
    out += String.fromCodePoint(yield* advance(state));
  }
}

/**
 * A number, kept as its exact source lexeme (§5.3, §3.1) — nothing here converts it. The grammar
 * is RFC 8259's exactly: an optional minus, an integer part with no leading zero, an optional
 * fraction of at least one digit, an optional exponent of at least one digit.
 */
function* scanNumber(state: State): Task<string> {
  let text = '';
  if ((yield* peekCp(state)) === 0x2d /* - */) {
    text += String.fromCodePoint(yield* advance(state));
  }

  const first = yield* peekCp(state);
  if (first === 0x30 /* 0 */) {
    text += String.fromCodePoint(yield* advance(state));
    const next = yield* peekCp(state);
    if (isDigit(next)) {
      throw errorHere(
        state,
        "a number's integer part is a single '0' or starts with a nonzero digit",
      );
    }
  } else if (isDigit(first)) {
    text += yield* digits(state);
  } else {
    throw errorHere(state, 'a number needs at least one digit before its fraction or exponent');
  }

  if ((yield* peekCp(state)) === 0x2e /* . */) {
    text += String.fromCodePoint(yield* advance(state));
    if (!isDigit(yield* peekCp(state))) {
      throw errorHere(state, "a fraction needs at least one digit after its '.'");
    }
    text += yield* digits(state);
  }

  const e = yield* peekCp(state);
  if (e === 0x65 /* e */ || e === 0x45 /* E */) {
    text += String.fromCodePoint(yield* advance(state));
    const sign = yield* peekCp(state);
    if (sign === 0x2b || sign === 0x2d) {
      text += String.fromCodePoint(yield* advance(state));
    }
    if (!isDigit(yield* peekCp(state))) {
      throw errorHere(state, 'an exponent needs at least one digit');
    }
    text += yield* digits(state);
  }
  return text;
}

// ── Literal names ────────────────────────────────────────────────────────────────────────────

/**
 * One of `true`/`false`/`null`, matched whole. The failure names the literal that was nearly
 * written rather than the character that broke it: `nul` and `None` are both somebody reaching
 * for `null`.
 */
function* scanLiteral(state: State, spelling: string, type: JsonTokenType): Task<JsonTokenType> {
  for (let i = 0; i < spelling.length; i += 1) {
    if ((yield* peekCp(state)) !== spelling.codePointAt(i)) {
      throw errorAtTokenStart(
        state,
        `'${spelling}' is the only JSON literal that starts this way, and this is not it`,
      );
    }
    yield* advance(state);
  }
  return finish(state, type, spelling);
}

function finish(state: State, type: JsonTokenType, text: string): JsonTokenType {
  state.tokenText = text;
  return type;
}

function* single(state: State, type: JsonTokenType, spelling: string): Task<JsonTokenType> {
  yield* advance(state);
  return finish(state, type, spelling);
}

/**
 * A code point named the way a reader would recognise it: as itself where it is printable, as
 * `U+XXXX` where it is not.
 */
function describe(cp: number): string {
  return cp > 0x20 && cp !== 0x7f ? `'${String.fromCodePoint(cp)}'` : `U+${hex(cp, 4)}`;
}

/** Scans the next token, including a trailing `eof` once the input is exhausted. */
function* nextToken(state: State): Task<JsonTokenType> {
  yield* stripLeadingBom(state);
  yield* skipWhitespace(state);
  state.tokenStart = position(state.line, state.col, state.byteOffset);

  const cp = yield* peekCp(state);
  if (cp === undefined) return finish(state, 'eof', '');

  switch (cp) {
    case 0x7b /* { */:
      return yield* single(state, 'begin-object', '{');
    case 0x7d /* } */:
      return yield* single(state, 'end-object', '}');
    case 0x5b /* [ */:
      return yield* single(state, 'begin-array', '[');
    case 0x5d /* ] */:
      return yield* single(state, 'end-array', ']');
    case 0x3a /* : */:
      return yield* single(state, 'name-separator', ':');
    case 0x2c /* , */:
      return yield* single(state, 'value-separator', ',');
    case QUOTE:
      return finish(state, 'string', yield* scanString(state));
    case 0x74 /* t */:
      return yield* scanLiteral(state, 'true', 'true');
    case 0x66 /* f */:
      return yield* scanLiteral(state, 'false', 'false');
    case 0x6e /* n */:
      return yield* scanLiteral(state, 'null', 'null');
    default:
      if (cp === 0x2d || (cp >= 0x30 && cp <= 0x39)) {
        return finish(state, 'number', yield* scanNumber(state));
      }
      throw errorAtTokenStart(state, `${describe(cp)} is not the start of any JSON value`);
  }
}
