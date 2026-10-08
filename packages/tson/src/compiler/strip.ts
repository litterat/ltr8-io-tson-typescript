/**
 * A schema document's reading form: the same declarations, in as few tokens as the syntax allows,
 * for a reader that reads a schema rather than resolving it -- a language model given one in a
 * prompt. It is valid syntax and is *not* a loadable schema.
 *
 * Four things are removed or shortened, and nothing else changes:
 *
 * - **`!!id`** goes: nothing resolves the copy, and a reading form claiming the identity of a
 *   document whose bytes it does not have would be a second document under one published name
 *   (§2.2.1).
 * - **A header reference's query** goes, and its `#fragment` stays. In an identifying URI the
 *   query holds nothing but `?sha256=` pins, which are verification metadata (§2.2.1).
 * - **A header reference to the spec's own library** -- `meta-kernel`, `meta` and `core` at any
 *   revision -- is shortened to its revision and name (`"37/meta"`). Any other reference keeps its
 *   URL, which is the only thing that tells a reader which schema it names.
 * - **The documentary annotations** (§3.1) go, wherever they are written: `@doc`, `@title` and
 *   `@examples`, which are for the schema's readers, and `@comment`, which is for its maintainers.
 *   {@link stripSchemaKeepingDocs} keeps the first three and drops only `@comment`. Every other
 *   annotation stays: several are checked and change what the schema means.
 *
 * **Whitespace is collapsed, never removed.** TSON has no comments, so the token stream is the
 * whole document, and the grammar reads adjacency (§7.5): some tokens must touch (`@doc:`,
 * `name?:`) and some must not. A run of whitespace between two tokens becomes one space, tokens
 * that touched still touch, and where a token was removed the two either side are separated. A
 * multi-line quoted token is rewritten single-line, with escapes, as the same text (§7.2.2).
 *
 * **One line per header directive and per declaration**, and the schema map's closing brace on its
 * own, so a reader can find an entry by its line; inside a declaration everything is on one line.
 * A line break stands only where whitespace already may.
 *
 * The output is lexed again and must give the token stream this intended, then parsed as a schema
 * document; either failing is a fault here ({@link TsonInternalError}), never a verdict on the
 * input. Unlike the readers, this holds the whole token list and output: a reading form is for a
 * document small enough to be read whole, and its line rule needs lookahead past a declaration.
 */
import { TsonInternalError } from '../core/errors.js';
import { fromString, runSync } from '../io/bytes.js';
import { canonicalizeIdentity } from '../link/identity.js';
import { createLexer, currentToken } from '../lexer/lexer.js';
import { adjacentTo, type Token } from '../lexer/token.js';
import { createEmitter, stringSink } from '../write/emitter.js';
import { parseSchemaDocument } from './schemaParser.js';

/** The annotations {@link stripSchema} removes: everything written for a person rather than a processor. */
const DOCUMENTARY: ReadonlySet<string> = new Set(['doc', 'title', 'examples', 'comment']);

/** The annotations {@link stripSchemaKeepingDocs} removes: the maintainers' notes alone. */
const MAINTAINERS: ReadonlySet<string> = new Set(['comment']);

/**
 * The reading form of `source`, a schema document.
 *
 * @throws TsonLexError for a token that does not lex, TsonParseError if `source` is not a
 *   well-formed schema document (both positioned).
 */
export function stripSchema(source: string): string {
  return strip(source, DOCUMENTARY);
}

/**
 * The reading form of `source` with its documentation kept -- `@doc`, `@title` and `@examples` --
 * for a reader that wants the schema explained; `@comment` still goes.
 *
 * @throws TsonLexError | TsonParseError as {@link stripSchema} does.
 */
export function stripSchemaKeepingDocs(source: string): string {
  return strip(source, MAINTAINERS);
}

function tokenize(source: string): Token[] {
  const lexer = createLexer(fromString(source));
  const tokens: Token[] = [];
  for (;;) {
    const type = runSync(lexer.nextToken());
    tokens.push(currentToken(lexer, type));
    if (type === 'eof') return tokens;
  }
}

function strip(source: string, removedAnnotations: ReadonlySet<string>): string {
  runSync(parseSchemaDocument(fromString(source)));
  const tokens = tokenize(source);
  const lineBreaks = lineBreaksOf(tokens);

  let out = '';
  const intended: Token[] = [];
  let previous: Token | undefined;
  let removed = false;
  let lineBreak = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || token.type === 'eof') break;
    lineBreak ||= lineBreaks[i] === true;
    const removable = removableLength(tokens, i, removedAnnotations);
    if (removable > 0) {
      removed = true;
      i += removable - 1;
      continue;
    }
    if (previous !== undefined && lineBreak) {
      out += '\n';
    } else if (previous !== undefined && (removed || !adjacentTo(previous, token))) {
      out += ' ';
    }
    const written = isDirectiveArgument(tokens, i)
      ? { ...token, text: shortened(token.text) }
      : token;
    out += spelling(written);
    intended.push(written);
    previous = token;
    removed = false;
    lineBreak = false;
  }
  out += '\n';
  verify(out, intended);
  return out;
}

/** Whether `tokens[i]` exists and has `type`. */
function is(tokens: readonly Token[], i: number, type: Token['type']): boolean {
  return tokens[i]?.type === type;
}

/**
 * Which tokens start a line: the token after each header directive, each declaration's first token
 * (its first annotation, or its name), and the schema map's closing brace.
 */
function lineBreaksOf(tokens: readonly Token[]): boolean[] {
  const breaks: boolean[] = new Array<boolean>(tokens.length).fill(false);
  let i = 0;
  while (is(tokens, i, 'directive-token')) {
    i += 4; // !! name : "..."
    breaks[i] = true;
  }
  while (is(tokens, i, 'at')) i += annotationLength(tokens, i);
  let depth = 0;
  for (i++; depth > 0 || !is(tokens, i, 'rbrace'); i++) {
    if (depth === 0) {
      const arrow = entryArrow(tokens, i);
      if (arrow > 0) {
        breaks[i] = true;
        i = arrow;
        continue;
      }
    }
    const type = tokens[i]?.type;
    if (type === 'lbrace' || type === 'lbracket' || type === 'lparen') depth++;
    else if (type === 'rbrace' || type === 'rbracket' || type === 'rparen') depth--;
  }
  breaks[i] = true;
  return breaks;
}

/** The index of the `=>` of the declaration starting at `i` -- its annotations, then its name -- or 0 if none starts there. */
function entryArrow(tokens: readonly Token[], i: number): number {
  while (is(tokens, i, 'at')) i += annotationLength(tokens, i);
  return is(tokens, i, 'unquoted-token') && is(tokens, i + 1, 'map-arrow-token') ? i + 1 : 0;
}

/** How many tokens from `i` are removed -- an `!!id` directive or one of `annotations` -- or 0. */
function removableLength(
  tokens: readonly Token[],
  i: number,
  annotations: ReadonlySet<string>,
): number {
  const token = tokens[i];
  if (token?.type === 'directive-token' && named(tokens, i + 1, 'id')) return 4; // !! id : "..."
  if (token?.type === 'at' && annotations.has(tokens[i + 1]?.text ?? '')) {
    return annotationLength(tokens, i);
  }
  return 0;
}

/** The tokens of the annotation starting at `i`: `@name`, then `:value` if it has one (§3.1). */
function annotationLength(tokens: readonly Token[], i: number): number {
  const name = tokens[i + 1];
  const colon = tokens[i + 2];
  if (name === undefined || colon?.type !== 'colon' || !adjacentTo(name, colon)) {
    return 2;
  }
  return 3 + valueLength(tokens, i + 3);
}

/** The tokens of the value starting at `i`: a type-ref and then one token, or one bracketed group. */
function valueLength(tokens: readonly Token[], start: number): number {
  let i = start;
  if (is(tokens, i, 'bang')) i += 2;
  let depth = 0;
  do {
    const type = tokens[i]?.type;
    if (type === 'lbrace' || type === 'lbracket' || type === 'lparen') depth++;
    else if (type === 'rbrace' || type === 'rbracket' || type === 'rparen') depth--;
    i++;
  } while (depth > 0);
  return i - start;
}

function named(tokens: readonly Token[], i: number, name: string): boolean {
  const token = tokens[i];
  return token?.type === 'unquoted-token' && token.text === name;
}

/** Whether `tokens[i]` is a header directive's argument -- `!! name : "..."`. */
function isDirectiveArgument(tokens: readonly Token[], i: number): boolean {
  return i >= 3 && is(tokens, i - 3, 'directive-token') && is(tokens, i - 1, 'colon');
}

/** `reference` without its query, and shortened to `<revision>/<name>` if the spec's library names it. */
function shortened(reference: string): string {
  const unpinned = withoutQuery(reference);
  let identity: string;
  try {
    identity = canonicalizeIdentity(unpinned);
  } catch {
    return unpinned; // not an identity at all, so not the library's: the spelling stays
  }
  // `tson.io/<year>/<revision>/m/<meta-kernel|meta|core>.tn` (§2.2.1)
  const [host, year, revision, directory, file, ...rest] = identity.split('/');
  if (host !== 'tson.io' || directory !== 'm' || file === undefined || rest.length > 0) {
    return unpinned;
  }
  if (year === undefined || revision === undefined) return unpinned;
  if (!isDigits(year, 4) || !isDigits(revision)) return unpinned;
  const library = file.endsWith('.tn') ? file.slice(0, -3) : '';
  return library === 'meta-kernel' || library === 'meta' || library === 'core'
    ? `${revision}/${library}`
    : unpinned;
}

function isDigits(text: string, length?: number): boolean {
  if (text.length === 0) return false;
  if (length !== undefined && text.length !== length) return false;
  for (const char of text) {
    if (char < '0' || char > '9') return false;
  }
  return true;
}

/** `reference` without its query component -- in an identifying URI, only ever hash pins. */
function withoutQuery(reference: string): string {
  const query = reference.indexOf('?');
  if (query < 0) return reference;
  const fragment = reference.indexOf('#', query);
  return reference.slice(0, query) + (fragment < 0 ? '' : reference.slice(fragment));
}

/** The token as written: a lexeme as it was, a quoted token re-quoted single-line from its decoded text. */
function spelling(token: Token): string {
  if (token.type !== 'single-line-token' && token.type !== 'multi-line-token') return token.text;
  const { sink, result } = stringSink();
  createEmitter(sink).quotedString(token.text);
  return result();
}

/** The output lexes to `intended`, every quoted token single-line, and parses as a schema document. */
function verify(stripped: string, intended: readonly Token[]): void {
  const fault = (reason: string): TsonInternalError => new TsonInternalError(reason);
  const relexed = tokenize(stripped);
  let same = relexed.length === intended.length + 1;
  for (let i = 0; same && i < intended.length; i++) {
    const want = intended[i];
    const got = relexed[i];
    if (want === undefined || got === undefined) {
      same = false;
      break;
    }
    const type = want.type === 'multi-line-token' ? 'single-line-token' : want.type;
    same = got.type === type && got.text === want.text;
  }
  if (!same) throw fault('the stripped schema does not lex to the tokens it was written from');
  try {
    runSync(parseSchemaDocument(fromString(stripped)));
  } catch (error) {
    throw new TsonInternalError(
      `the stripped schema does not parse: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
