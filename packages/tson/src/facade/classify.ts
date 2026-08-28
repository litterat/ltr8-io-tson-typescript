/**
 * `classifyDocument` -- data document or schema document, from a document's opening bytes.
 *
 * [TSON-DATA] §2.2 makes this a property of the header, not of the file extension: "a parser
 * consumes the `!!id` directive if present; if the next token is the directive `!!meta`, the
 * document is a schema document ... otherwise it is a data document. Classification therefore
 * requires at most two directives of lookahead, no value parsing, and no backtracking." §7.1
 * names the consumers that need exactly that -- "streams, previews, and content sniffers can
 * classify a document from its opening bytes".
 *
 * **This is that function, and it really does stop.** It reads at most two directives and then
 * returns; it never touches the body, so classifying a gigabyte document costs the same as
 * classifying a two-line one, and a document whose *body* is malformed still classifies. That is
 * the whole reason for it to exist separately from `parse`, which would have to read the value to
 * find out something the header already said.
 *
 * **The header itself is still checked**, because a sniffer that guesses is worse than one that
 * refuses: `!!` must be adjacent to its directive name (§7.5), the `:` must follow the name
 * immediately, and the argument must be a single-line quoted token (§3.3). A malformed header
 * raises `TsonLexError`/`TsonParseError` exactly as parsing would. What is deliberately *not*
 * checked is the argument's URI syntax -- `parse`/`parseSchemaDocument` reject an `!!id` that is
 * not a URI, and doing it here as well would mean a document that classifies but does not parse
 * is treated differently from one that neither classifies nor parses, for no gain to a caller
 * asking only which kind of document this is.
 */
import { createLexer, currentToken } from '../lexer/lexer.js';
import { adjacentTo, type Token, type TokenType } from '../lexer/token.js';
import { TsonParseError } from '../core/errors.js';
import type { ByteInput, Task } from '../io/bytes.js';
import {
  runOverAsyncSource,
  runOverBytes,
  type AsyncByteSource,
  type ByteSource,
} from './byteSource.js';

/** Which of §2.2's two document kinds a header declares. */
export type DocumentKind = 'data' | 'schema';

/** What {@link classifyDocument} could tell from a document's header alone. */
export interface DocumentClassification {
  readonly kind: DocumentKind;
  /**
   * The `!!id` directive's argument, when the header carries one. Uninterpreted: not canonicalised
   * (`@ltr8/tson/identity`'s `canonicalizeIdentity` does that) and not checked for URI syntax.
   */
  readonly id?: string;
  /**
   * The `!!meta` directive's argument -- the schema this schema document is written against.
   * Present only for `kind: 'schema'`, since a data document has no `!!meta` (§2.2).
   */
  readonly meta?: string;
}

interface Cursor {
  readonly next: () => Task<Token>;
}

function cursorOver(input: ByteInput): Cursor {
  const lexer = createLexer(input);
  return {
    *next(): Task<Token> {
      const type: TokenType = yield* lexer.nextToken();
      return currentToken(lexer, type);
    },
  };
}

/** `"!!" name` -- the two tokens §2.2's lookahead is counted in. `undefined` if `first` is not `!!`. */
function* directiveName(cursor: Cursor, first: Token): Task<Token | undefined> {
  if (first.type !== 'directive-token') return undefined;
  const name = yield* cursor.next();
  if (name.type !== 'unquoted-token') {
    throw new TsonParseError(
      `expected a directive name after '!!', found '${name.text}'`,
      name.start,
      { expected: 'a directive name', actual: name.text },
    );
  }
  if (!adjacentTo(first, name)) {
    throw new TsonParseError(
      "'!!' must be immediately adjacent to the directive name (no whitespace)",
      name.start,
    );
  }
  return name;
}

/** `":" single-line-token` -- the rest of a directive, once its name has been read (§3.3). */
function* directiveArgument(cursor: Cursor, name: Token): Task<string> {
  const colon = yield* cursor.next();
  if (colon.type !== 'colon' || !adjacentTo(name, colon)) {
    throw new TsonParseError(
      `expected ':' immediately after directive name '!!${name.text}'`,
      colon.start,
      { expected: ':', actual: colon.text },
    );
  }
  const arg = yield* cursor.next();
  if (arg.type === 'multi-line-token') {
    throw new TsonParseError(
      'a multi-line token is not permitted as a directive argument; use a single-line quoted token',
      arg.start,
    );
  }
  if (arg.type !== 'single-line-token') {
    throw new TsonParseError(
      `expected a single-line quoted token as the argument to '!!${name.text}', found '${arg.text}'`,
      arg.start,
      { expected: 'a single-line quoted token', actual: arg.text },
    );
  }
  return arg.text;
}

function* classifyTask(input: ByteInput): Task<DocumentClassification> {
  const cursor = cursorOver(input);

  // Directive one: `!!id`, if the document carries it. Anything else here is already the body of
  // a data document, or the `!!meta` of a schema one.
  let token = yield* cursor.next();
  let name = yield* directiveName(cursor, token);
  let id: string | undefined;
  if (name?.text === 'id') {
    id = yield* directiveArgument(cursor, name);
    token = yield* cursor.next();
    name = yield* directiveName(cursor, token);
  }

  // Directive two -- the one the whole classification turns on (§2.2's "kind dispatch").
  if (name?.text === 'meta') {
    return {
      kind: 'schema',
      ...(id === undefined ? {} : { id }),
      meta: yield* directiveArgument(cursor, name),
    };
  }
  return { kind: 'data', ...(id === undefined ? {} : { id }) };
}

/**
 * Classifies `source` as a data or schema document from its header alone (§2.2), reading at most
 * two directives and never the body.
 *
 * Synchronous for a complete `Uint8Array`; a streaming `source` (a web `ReadableStream` or any
 * other `AsyncIterable<Uint8Array>`) returns a `Promise` instead, and consumes only the chunks the
 * header needs -- which is what lets a caller classify an incoming stream before deciding what to
 * do with the rest of it.
 *
 * @throws TsonLexError | TsonParseError if the header itself is malformed. A malformed *body* is
 *   not an error here: it is never read.
 */
export function classifyDocument(source: Uint8Array): DocumentClassification;
export function classifyDocument(source: AsyncByteSource): Promise<DocumentClassification>;
export function classifyDocument(
  source: ByteSource,
): DocumentClassification | Promise<DocumentClassification> {
  return source instanceof Uint8Array
    ? runOverBytes(source, classifyTask)
    : runOverAsyncSource(source, classifyTask);
}
