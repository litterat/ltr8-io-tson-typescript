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
import { isIdentifierText } from '../unicode/identifier-profile.js';
import { toNfc } from '../unicode/nfc.js';

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

/** Directive arguments are IRI-references (§2.2.1, §3.3); validated with the same grammar the reader enforces. */
const DIRECTIVE_URI = createUriParser('iri_reference', {
  kind: 'iri_type',
  spec: 'RFC 3987',
  allowRelative: true,
  allowFragment: true,
  normalization: 'NONE',
});

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
   * A field name is an identifier at every layer, schemaless or governed (§2.5, §7.7), so `name`
   * is NFC-normalised and held to the identifier grammar, and written unquoted: §7.1 makes every
   * identifier a well-formed unquoted token, so no identifier needs quoting on its own account
   * and there is no second spelling to choose between. Quoting is relief from what the unquoted
   * form cannot spell, never a wider name set, so a `name` that is not an identifier has no legal
   * spelling at all and throws {@link TsonWriteError} rather than being quoted into a document
   * this implementation's own parser would reject. `_id` is one such: `_` is `XID_Continue` and
   * never `XID_Start`, so no identifier begins with one, and a key that is not a name belongs in
   * a map (§2.5).
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
   * @throws TsonWriteError when `uri` is not a valid IRI-reference (§3.3) -- caught at the write that
   *   caused it rather than at whoever reads the result.
   */
  documentId(uri: string): void;
  /**
   * `!!schema:"<uri>"` and its line terminator -- the schema governing the value that follows.
   * Legal in a document header and at a scoped-value position (§3.3); this emits it wherever the
   * caller currently is, exactly like every other method here.
   *
   * @throws TsonWriteError when `uri` is not a valid IRI-reference (§3.3).
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
  /** `_`, the void sentinel (§2.9) -- the format's one spelling of absence (§4.4, §7.3). */
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

const CODE_UNIT_NEL = 0x85;
const CODE_UNIT_LINE_SEPARATOR = 0x2028;
const CODE_UNIT_PARAGRAPH_SEPARATOR = 0x2029;

/**
 * Whether §7.2.2 excludes `codeUnit` raw from a single-line token, admitting it only through an
 * escape: everything below U+0020, and the three line terminators NEL, LINE SEPARATOR and
 * PARAGRAPH SEPARATOR. A single-line token is genuinely single-line -- every line terminator of
 * §7.2 rule 1 ends it -- which is why the three above are excluded raw and nothing else above
 * U+001F is.
 */
function mustEscapeRaw(codeUnit: number): boolean {
  return (
    codeUnit <= 0x1f ||
    codeUnit === CODE_UNIT_NEL ||
    codeUnit === CODE_UNIT_LINE_SEPARATOR ||
    codeUnit === CODE_UNIT_PARAGRAPH_SEPARATOR
  );
}

function hex4(codeUnit: number): string {
  return codeUnit.toString(16).padStart(4, '0');
}

/**
 * Escapes exactly what must be escaped for `text` to lex back to the same value -- `"`, `\`, and
 * every code unit §7.2.2 excludes raw from a single-line token (named escapes where the lexer
 * recognises one, `\uXXXX` otherwise) -- leaving everything else, including non-ASCII text,
 * literal. {@link mustEscapeRaw} is that exclusion, the three line terminators included: a token
 * carrying one of those raw is a document this implementation's own lexer refuses.
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
        out += mustEscapeRaw(code) ? `\\u${hex4(code)}` : c;
      }
    }
  }
  return out;
}

/**
 * One content line of a multi-line token, escaped so §7.2.3's own reading order (strip trailing
 * whitespace, then decode escapes) returns it unchanged. A line's trailing spaces/tabs are
 * written as a `\uXXXX` escape, since they would otherwise be stripped back off on read; every
 * code unit §7.2.2 excludes raw ({@link mustEscapeRaw}, the three line terminators included, each
 * of which would otherwise start a line the reader never sees as content) gets the same
 * treatment, tab among them -- always escaped here for uniformity, though the grammar itself
 * admits a literal one. A line that would otherwise read
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
    } else if (isTrailingBlank || mustEscapeRaw(code)) {
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

/**
 * `name`, NFC-normalised, checked against §7.7's identifier grammar -- the one form a field name
 * may take at either spelling (§2.5, §7.7). Throws {@link TsonWriteError} when it is not one.
 *
 * There is no spelling choice to make afterwards. §7.1 makes every identifier a well-formed
 * unquoted token, so an identifier never needs quoting on its own account, and quoting would not
 * rescue a name that is not one: quoting escapes a lexical accident -- relief from what the
 * unquoted form cannot spell -- and does not admit a broader name set. Writing a non-identifier
 * key quoted, as a lexical field name once allowed, now produces a document this implementation's
 * own parser rejects (`compiler/cursor.ts`'s `fieldNameText`), which is the silent failure this
 * throw exists to prevent. `_` is `XID_Continue` and never `XID_Start`, so `_id` and `_` fall
 * straight out of the production with no special case; a key that is not a name belongs in a map.
 *
 * The normalised text is what is written, because that is what identity and every later
 * comparison between names sees (§7.7).
 */
function fieldNameSpelling(name: string): string {
  const text = toNfc(name);
  if (!isIdentifierText(text)) {
    throw new TsonWriteError(
      `'${name}' is not an identifier, so it names no field (§2.5, §7.7): a name starts with an ` +
        "XID_Start character and continues with XID_Continue or '-', in NFC -- a key that is not " +
        "a name belongs in a map ('key => value')",
    );
  }
  return text;
}

/** Validates a directive argument against the same URI grammar the reader enforces (§3.3). */
function validateDirectiveUri(name: string, uri: string): void {
  try {
    DIRECTIVE_URI.read({ text: uri, form: 'single-line' });
  } catch (error) {
    if (error instanceof TsonAtomParseError || error instanceof TsonAtomValidationError) {
      throw new TsonWriteError(
        `'!!${name}' argument "${uri}" is not a valid IRI-reference (§3.3): ${error.message}`,
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
      emit(fieldNameSpelling(name));
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
