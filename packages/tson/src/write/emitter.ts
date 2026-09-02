/**
 * Builds TSON source text incrementally -- the write-side counterpart to `lexer/lexer.ts`'s
 * read side, and just as agnostic of any particular value model: this module knows TSON's own
 * grammar (delimiters, separators, escaping) and nothing about an `ast.DataValue`, a
 * `tree.Value`, or a bound host object. `astWriter.ts`/`treeWriter.ts`/`bindingWriter.ts` are the
 * three layers that walk a value graph and drive this emitter, the same relationship
 * `TsonObjectWriter`/`TsonTreeWriter`/`AstWriter` have with `TsonDataEmitter` in the reference
 * implementation -- ported here as one `Emitter` rather than one emitter class, since nothing
 * about it needs Java's own-instance-per-write discipline: a plain closure over a scope stack and
 * a sink does the same job.
 *
 * **Separation, not commas.** Confirmed against §2.4 and this repo's own test literals: TSON
 * never requires a comma between sibling elements -- "zero-width separation is a parse error",
 * not "a comma is required" (`stream/dataStream.ts`'s own separator handling accepts either a
 * comma or a whitespace gap). This emitter always inserts a single space before every element
 * (including the first, right after an opening delimiter) and before a non-empty scope's closing
 * delimiter -- `{ x: 1 y: 2 }`, not `{x: 1, y: 2}` -- valid either way, matching this repo's own
 * established literal style.
 *
 * **Writes into a {@link TextSink}, which is what keeps a document off the heap.** Nothing here
 * buffers on its own beyond the open-scope element counts (one integer per nesting level, the
 * same bound the reader's own frame stack gives, per CLAUDE.md's "memory proportional to nesting
 * depth"); every method pushes its text straight to the sink. {@link stringSink} exists for the
 * common case of wanting the whole document as a `string`; a caller streaming to a file or a
 * socket supplies its own sink instead and never holds more than the emitter's own scope stack.
 *
 * Not reentrant across concurrent writes to the same sink -- single-use, like `Lexer`.
 */
import { TsonAtomParseError, TsonAtomValidationError, TsonWriteError } from '../core/errors.js';
import { createUriParser } from '../atom/network/uri.js';
import { isNfc } from '../unicode/nfc.js';
import { isUnquotedTokenContinue, isUnquotedTokenStart } from '../unicode/token-profile.js';

/** Where an {@link Emitter}'s text goes, one chunk at a time -- the port of Java's `Appendable`. */
export type TextSink = (chunk: string) => void;

/** A {@link TextSink} that accumulates into a `string`, for a caller that wants the whole document at once. */
export function stringSink(): { readonly sink: TextSink; readonly result: () => string } {
  const parts: string[] = [];
  return {
    sink: (chunk: string): void => {
      parts.push(chunk);
    },
    result: (): string => parts.join(''),
  };
}

/** Directive arguments are URIs (§3.3); validated with the same grammar the reader enforces. */
const DIRECTIVE_URI = createUriParser('uri', { kind: 'uri_type', spec: 'RFC 3986' });

/**
 * TSON's own grammar-level writing primitives -- delimiters, separators, escaping, and the
 * document header directives (§2.2, §3.3). One instance per document write; see {@link
 * createEmitter}.
 */
export interface Emitter {
  // ── Records and maps (both "{" "}", differing only in entry shape) ───────────────────────
  beginRecord(): void;
  endRecord(): void;
  beginMap(): void;
  endMap(): void;
  /**
   * `name:` -- inserts the inter-element separator itself; the value follows directly.
   *
   * A field name is lexical, not identifier-constrained (§2.5: "any token the production
   * admits names a field"), so `name` is written unquoted whenever its exact text survives
   * that round trip and quoted otherwise -- {@link canWriteFieldNameUnquoted} is the exact
   * predicate. The spec leaves the choice of spelling to the writer wherever both are legal;
   * this implementation always prefers unquoted and falls back to quoted only where unquoted
   * would not re-read as `name` itself. The case this exists for: `_id` cannot be spelled
   * unquoted at all, because a token-initial `_` is the absent sentinel (§2.9), not a token
   * character (§7.1) -- an unquoted `_id` lexes as `_` followed by a separate `id` token, not
   * as one field name.
   */
  field(name: string): void;
  /** Call before writing a map entry's key (itself a full data-value, §2.6). */
  beforeMapEntry(): void;
  /** `=>` between a map entry's key and value, once the key has been written. */
  mapArrow(): void;

  // ── Arrays (also used for tuples -- same "[" "]" shape, §2.7) ─────────────────────────────
  beginArray(): void;
  endArray(): void;
  /** Call before writing each array/tuple element. */
  beforeArrayElement(): void;

  // ── Annotations (§3.1) ─────────────────────────────────────────────────────────────────────
  /**
   * `@name ` -- a valueless annotation. The trailing space is required, not cosmetic: §3.1 makes
   * the single character after the name the whole of the boundary rule, so with no `:` at least
   * one whitespace character MUST follow, or the name runs into whatever comes next.
   */
  annotation(name: string): void;
  /**
   * `@name:` -- opens an annotation carrying a value; the caller writes exactly one data-value
   * next, then calls {@link endAnnotation}. Nothing follows the `:` here: whitespace after it is
   * optional, and omitting it keeps the common `@doc:"..."` form compact.
   */
  beginAnnotation(name: string): void;
  /** Closes the annotation opened by {@link beginAnnotation}: a single separating space. */
  endAnnotation(): void;

  // ── Header directives (§2.2, §3.3) ─────────────────────────────────────────────────────────
  /**
   * `!!id:"<uri>"` and its line terminator -- the document's own identity, and the *first* line
   * when present (§2.2). The terminator is not cosmetic: §2.2.1 bounds the content-hash input at
   * the id line's own terminator.
   *
   * @throws TsonWriteError when `uri` is not a valid URI (§3.3) -- caught at the write that
   *   caused it rather than at whoever reads the result.
   */
  documentId(uri: string): void;
  /**
   * `!!schema:"<uri>"` and its line terminator -- the schema governing the value that follows.
   * Legal in a document header and at a scoped-value position (§3.3); this emits it wherever the
   * caller currently is, exactly like every other method here.
   *
   * @throws TsonWriteError when `uri` is not a valid URI (§3.3).
   */
  schemaRef(uri: string): void;

  // ── Type annotations (§3.2) ────────────────────────────────────────────────────────────────
  /**
   * `!name ` -- at most one per value, which this enforces: `data-value = *annotation [type-ref]
   * core-value` admits exactly one, and a second is a parse error in the document that results.
   * The pending flag clears the moment a core-value starts, so a nested value's own type-ref (or
   * an annotation's) is unaffected.
   *
   * @throws TsonWriteError on a second type-ref for one value.
   */
  typeRef(name: string): void;

  // ── Leaf tokens ─────────────────────────────────────────────────────────────────────────────
  /** `null`, the base type (§4.1) -- distinct from {@link absentValue}. */
  nullValue(): void;
  /** `_`, the absent sentinel (§2.9) -- distinct from {@link nullValue}. */
  absentValue(): void;
  booleanValue(value: boolean): void;
  /**
   * Writes `text` as-is, unquoted -- the caller is responsible for `text` already being valid
   * unquoted-token content (a plain number's digits, an enum's name, ...). Never used for
   * arbitrary strings; see {@link quotedString}.
   */
  unquotedToken(text: string): void;
  /** Writes `text` as a quoted, escaped single-line string token (§7.2.2). */
  quotedString(text: string): void;
  /** Writes `text` as a multi-line string token (§7.2.3), with no common indentation at all. */
  multiLineString(text: string): void;
}

/** A C0 control character, the range §7.2.2 requires escaped. */
function isControl(codeUnit: number): boolean {
  return codeUnit <= 0x1f;
}

function hex4(codeUnit: number): string {
  return codeUnit.toString(16).padStart(4, '0');
}

/**
 * Escapes exactly what must be escaped for `text` to lex back to the same value -- `"`, `\`, and
 * C0 control characters (named escapes where the lexer recognises one, `\uXXXX` otherwise) --
 * leaving everything else, including non-ASCII text, literal.
 */
function escapeSingleLine(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    switch (c) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\b':
        out += '\\b';
        break;
      case '\f':
        out += '\\f';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default: {
        const code = text.charCodeAt(i);
        out += isControl(code) ? `\\u${hex4(code)}` : c;
      }
    }
  }
  return out;
}

/**
 * One content line of a multi-line token, escaped so §7.2.3's own reading order (strip trailing
 * whitespace, then decode escapes) returns it unchanged. A line's trailing spaces/tabs are
 * written as a `\uXXXX` escape, since they would otherwise be stripped back off on read; every
 * other control character (tab included -- always escaped here for uniformity, though the
 * grammar itself admits a literal one) gets the same treatment. A line that would otherwise read
 * as the closing delimiter (`"""` right after its own leading whitespace) has its first quote
 * escaped instead.
 */
function escapeMultiLineContent(line: string): string {
  let trailing = line.length;
  while (
    trailing > 0 &&
    (line.charAt(trailing - 1) === ' ' || line.charAt(trailing - 1) === '\t')
  ) {
    trailing -= 1;
  }
  let out = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line.charAt(i);
    const code = line.charCodeAt(i);
    const isTrailingBlank = i >= trailing;
    if (c === '\\') {
      out += '\\\\';
    } else if (isTrailingBlank || c === '\r' || isControl(code)) {
      out += `\\u${hex4(code)}`;
    } else {
      out += c;
    }
  }
  let indent = 0;
  while (indent < out.length && (out.charAt(indent) === ' ' || out.charAt(indent) === '\t')) {
    indent += 1;
  }
  if (out.startsWith('"""', indent)) {
    return out.slice(0, indent) + '\\u0022' + out.slice(indent + 1);
  }
  return out;
}

const CODE_POINT_FULL_STOP = 0x2e;
const CODE_POINT_HYPHEN = 0x2d;
const CODE_POINT_PLUS = 0x2b;

/** `.`, `-`, `+` -- the three token-profile extension characters that trigger compound-token lookahead at a token boundary (§7.2.4). */
function isBoundarySign(codePoint: number): boolean {
  return (
    codePoint === CODE_POINT_FULL_STOP ||
    codePoint === CODE_POINT_HYPHEN ||
    codePoint === CODE_POINT_PLUS
  );
}

/**
 * Whether `name` can be written as an unquoted token and read back as the field name `name`,
 * unchanged -- the predicate {@link createEmitter}'s `field` applies to choose between an
 * unquoted and a quoted spelling. Field names are lexical (§2.5): `field-name = unquoted-token
 * / single-line-token`, with no identifier constraint, so the question is purely "does this
 * text lex back to one unquoted token equal to itself", answered against §7.1's profile and
 * §7.2's lexer rather than §7.7's identifier grammar.
 *
 * Checked in order, each a distinct way an unquoted spelling stops meaning `name`:
 *
 * 1. **Empty.** `unquoted-token = unquoted-start *unquoted-char` (§7.1) requires at least one
 *    character; there is no empty unquoted token to write.
 * 2. **First character not a token-start character**, `XID_Start ∪ Nd ∪ { - + . }` (§7.1). This
 *    is what excludes a token-initial `_`: underscore is `XID_Continue` but not `XID_Start`,
 *    and is reserved to the absent sentinel (§2.9) -- `_id` unquoted lexes as the absent token
 *    `_` followed by a second, separate token `id`, never as one field name.
 * 3. **A lone boundary sign.** `.`, `-`, and `+` reach the token profile only to serve the
 *    number grammar, and the lexer's own compound-token lookahead (§7.2.4) requires the
 *    character immediately after one to already be in the continuation set before it will
 *    start an unquoted token at all: with nothing (or something else) after it, `.` and `+`
 *    are lexer errors and `-` is the special subtraction token -- never a field-name token. A
 *    name that is exactly `.`, `-`, or `+`, or that starts with one followed by a
 *    non-continuation character, therefore fails here.
 * 4. **A later character outside the continuation set**, `XID_Continue ∪ { - + . }` (§7.1).
 * 5. **Two adjacent `.` characters anywhere.** The lexer's termination rule (§7.2 rule 3) stops
 *    an unquoted token before a run of consecutive dots, emitting a separate range token
 *    instead (§7.2.4) -- `a..b` would round-trip as `a`, `..`, `b`, not one field name.
 * 6. **Not NFC-normalized.** An unquoted token that isn't NFC in the source text is a lexer
 *    error (§7.2.1); only a quoted token is exempt from that requirement.
 *
 * Every legal identifier passes every check (§7.1: "every identifier is a well-formed unquoted
 * token"), so this only ever chooses quoting for spellings identifiers already couldn't use.
 */
/** `text`'s code points, decoded the way `for...of` already does -- one entry per Unicode scalar value, surrogate pairs included, never a lone UTF-16 unit. */
function toCodePoints(text: string): number[] {
  const codePoints: number[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    // `character` is one code point yielded by iterating `text`, so `codePointAt(0)` is always
    // defined; the guard keeps this total without asserting.
    if (codePoint !== undefined) codePoints.push(codePoint);
  }
  return codePoints;
}

function canWriteFieldNameUnquoted(name: string): boolean {
  const codePoints = toCodePoints(name);
  if (codePoints.length === 0) return false;

  const first = codePoints[0];
  if (first === undefined || !isUnquotedTokenStart(first)) return false;

  if (isBoundarySign(first)) {
    const second = codePoints[1];
    if (second === undefined || !isUnquotedTokenContinue(second)) return false;
  }

  for (let i = 1; i < codePoints.length; i += 1) {
    const codePoint = codePoints[i];
    if (codePoint === undefined || !isUnquotedTokenContinue(codePoint)) return false;
  }
  for (let i = 0; i + 1 < codePoints.length; i += 1) {
    if (codePoints[i] === CODE_POINT_FULL_STOP && codePoints[i + 1] === CODE_POINT_FULL_STOP) {
      return false;
    }
  }

  return isNfc(name);
}

/** Validates a directive argument against the same URI grammar the reader enforces (§3.3). */
function validateDirectiveUri(name: string, uri: string): void {
  try {
    DIRECTIVE_URI.read({ text: uri, form: 'single-line' });
  } catch (error) {
    if (error instanceof TsonAtomParseError || error instanceof TsonAtomValidationError) {
      throw new TsonWriteError(
        `'!!${name}' argument "${uri}" is not a valid URI (§3.3): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Builds a fresh {@link Emitter} writing into `sink`. */
export function createEmitter(sink: TextSink): Emitter {
  const scopeElementCounts: number[] = [];
  let typeRefPending = false;
  let pendingTypeRef: string | undefined;

  function emit(text: string): void {
    if (text.length > 0) sink(text);
  }

  function startCoreValue(): void {
    typeRefPending = false;
    pendingTypeRef = undefined;
  }

  function beforeElement(): void {
    const depth = scopeElementCounts.length;
    if (depth > 0) {
      emit(' ');
      scopeElementCounts[depth - 1] = (scopeElementCounts[depth - 1] ?? 0) + 1;
    }
  }

  function open(delimiter: string): void {
    startCoreValue();
    emit(delimiter);
    scopeElementCounts.push(0);
  }

  function close(delimiter: string): void {
    const count = scopeElementCounts.pop() ?? 0;
    if (count > 0) emit(' ');
    emit(delimiter);
  }

  function directive(name: string, uri: string): void {
    validateDirectiveUri(name, uri);
    emit('!!');
    emit(name);
    emit(':');
    emit('"');
    emit(escapeSingleLine(uri));
    emit('"');
    emit('\n');
  }

  return {
    beginRecord: () => {
      open('{');
    },
    endRecord: () => {
      close('}');
    },
    beginMap: () => {
      open('{');
    },
    endMap: () => {
      close('}');
    },
    field: (name: string) => {
      beforeElement();
      if (canWriteFieldNameUnquoted(name)) {
        emit(name);
      } else {
        emit('"');
        emit(escapeSingleLine(name));
        emit('"');
      }
      emit(': ');
    },
    beforeMapEntry: () => {
      beforeElement();
    },
    mapArrow: () => {
      emit(' => ');
    },
    beginArray: () => {
      open('[');
    },
    endArray: () => {
      close(']');
    },
    beforeArrayElement: () => {
      beforeElement();
    },
    annotation: (name: string) => {
      emit('@');
      emit(name);
      emit(' ');
    },
    beginAnnotation: (name: string) => {
      emit('@');
      emit(name);
      emit(':');
    },
    endAnnotation: () => {
      emit(' ');
    },
    documentId: (uri: string) => {
      directive('id', uri);
    },
    schemaRef: (uri: string) => {
      directive('schema', uri);
    },
    typeRef: (name: string) => {
      if (typeRefPending) {
        throw new TsonWriteError(
          `two type annotations on one value ('!${pendingTypeRef ?? ''}' then '!${name}'): ` +
            '§3.2 admits at most one, so the result would not parse',
        );
      }
      typeRefPending = true;
      pendingTypeRef = name;
      emit('!');
      emit(name);
      emit(' ');
    },
    nullValue: () => {
      startCoreValue();
      emit('null');
    },
    absentValue: () => {
      startCoreValue();
      emit('_');
    },
    booleanValue: (value: boolean) => {
      startCoreValue();
      emit(value ? 'true' : 'false');
    },
    unquotedToken: (text: string) => {
      startCoreValue();
      emit(text);
    },
    quotedString: (text: string) => {
      startCoreValue();
      emit('"');
      emit(escapeSingleLine(text));
      emit('"');
    },
    multiLineString: (text: string) => {
      startCoreValue();
      emit('"""\n');
      for (const line of text.split('\n')) {
        emit(escapeMultiLineContent(line));
        emit('\n');
      }
      // §7.2.3 puts the closing delimiter on its own line: only spaces and tabs may follow it
      // before the line ends. Whatever comes next -- an element separator, a map arrow, a
      // closing brace -- therefore starts on the next line, so the terminator is written here
      // rather than left to a caller that has no way to know it is owed one.
      emit('"""\n');
    },
  };
}
