import type { Position } from '../core/position.js';

/**
 * The complete lexical token vocabulary of the TSON series (§7.2, §7.3) — one member per kind
 * the lexer can produce, plus `eof`. This is the whole vocabulary for the whole series: higher
 * parts (the schema grammar) introduce no new tokens or lexer modes (§1.3).
 *
 * The kebab-case spellings below are chosen to match the conformance test suite's own
 * vocabulary wherever the suite tests at this grain: `single-line-token`, `multi-line-token`,
 * `unquoted-token` are exactly the `kind:` strings the suite's lexer-vector sidecars carry
 * (`.references/ltr8-io-tson-test-suite/tests/lexer/valid/*-expected.tn`). The suite's sidecars
 * additionally collapse `lbrace`/`rbrace`/`lbracket`/`rbracket`/`colon`/`comma` into one coarser
 * `structural-delimiter` category and every reserved special character into `special-token` —
 * that coarsening is a property of the conformance harness's comparison, not of this type, which
 * stays as granular as the source token actually is so no information is lost porting it forward.
 */
export type TokenType =
  /** `"..."` — a single-line quoted token (§7.2.2). */
  | 'single-line-token'
  /** `"""..."""` — a multi-line quoted token (§7.2.3). */
  | 'multi-line-token'
  /** An unquoted token: identifiers, numbers, dates, etc. (§7.1, §7.3). */
  | 'unquoted-token'
  /** `_` — the absent sentinel (§2.9). */
  | 'absent-token'
  /** `{` (§7.2 rule 4). */
  | 'lbrace'
  /** `}` (§7.2 rule 4). */
  | 'rbrace'
  /** `[` (§7.2 rule 4). */
  | 'lbracket'
  /** `]` (§7.2 rule 4). */
  | 'rbracket'
  /** `:` — the record field separator, and the annotation/directive argument separator (§7.2 rule 4). */
  | 'colon'
  /** `,` — the optional value separator (§7.2 rule 4). */
  | 'comma'
  /** `=>` — the map entry separator (§7.2.4). */
  | 'map-arrow-token'
  /** `!!` — begins a configuration directive (§3.3, §7.2.4). */
  | 'directive-token'
  /** `..` — the range token (§7.2.4). Reserved; no role in data values. */
  | 'range-token'
  /** `!` — type annotation prefix (§3.2), or the first character of `!!` (§7.2.4). */
  | 'bang'
  /** `@` — annotation prefix (§3.1). */
  | 'at'
  /** `&` — reserved by the schema grammar; a parse error in a data value (§7.2.5). */
  | 'ampersand'
  /** `<` — reserved by the schema grammar; a parse error in a data value (§7.2.5). */
  | 'less-than'
  /** `>` — reserved by the schema grammar; a parse error in a data value (§7.2.5). */
  | 'greater-than'
  /** `?` — reserved by the schema grammar; a parse error in a data value (§7.2.5). */
  | 'question'
  /** `~` — reserved by the schema grammar; a parse error in a data value (§7.2.5). */
  | 'tilde'
  /** `=` not followed by `>`. Reserved; not a map arrow (§7.2.4, §7.2.5). */
  | 'equal'
  /** `|` — reserved by the schema grammar; a parse error in a data value (§7.2.5). */
  | 'pipe'
  /** `;` — reserved by the schema grammar; a parse error in a data value (§7.2.5). */
  | 'semicolon'
  /** `(` — reserved by the schema grammar; a parse error in a data value (§7.2.5). */
  | 'lparen'
  /** `)` — reserved by the schema grammar; a parse error in a data value (§7.2.5). */
  | 'rparen'
  /** `^` — reserved by the schema grammar; a parse error in a data value (§7.2.5). */
  | 'caret'
  /** `-` not immediately followed by an unquoted-continuation character (§7.2.4, §7.2.5). */
  | 'minus'
  /** End of input. */
  | 'eof';

/**
 * The three token forms of §2.4: "text plus form". Form is consulted exactly once, by base type
 * resolution (§4), and is otherwise not meaning — kept on a token purely so a later layer can
 * tell `42` (unquoted) from `"42"` (single-line quoted) from `"""42"""` (multi-line quoted).
 *
 * These spellings (`unquoted`, `single-line`, `multi-line`) are the exact strings the
 * conformance suite's parser-layer vectors compare a token core-value's `form` field against.
 */
export type TokenForm = 'unquoted' | 'single-line' | 'multi-line';

/**
 * A single lexical token (§7.2, §7.3).
 *
 * `text` is the token's logical content: for `single-line-token` and `multi-line-token` this is
 * the decoded value — escape sequences resolved and, for a multi-line token, common indentation
 * stripped (§2.4, §7.2.2, §7.2.3). For every other kind, `text` is the exact source lexeme (an
 * unquoted token is stored exactly as written, which is what base type resolution and
 * numeric-representation preservation require, §4.3).
 *
 * `form` is present only for the three kinds §2.4 assigns a form to (`single-line-token`,
 * `multi-line-token`, `unquoted-token`) and absent for every other kind, structural delimiters
 * and special tokens included.
 *
 * `start` and `end` are the positions the token spans, both recorded at construction rather than
 * derived later — a diagnostic reports a position, and the parser enforces §7.5's adjacency
 * rules (`!`, `@`, `!!` MUST be adjacent to their operand) by comparing one token's `end` against
 * the next token's `start`, which is exactly what {@link adjacentTo} does.
 */
export interface Token {
  readonly type: TokenType;
  readonly text: string;
  readonly form?: TokenForm;
  readonly start: Position;
  readonly end: Position;
}

/**
 * Whether `second` begins exactly where `first` ends — no character, let alone whitespace,
 * between them.
 *
 * The load-bearing adjacency check of §7.5: a type annotation's `!`, an annotation's `@`, and a
 * directive's `!!` each MUST be adjacent to the unquoted token that names them, and this is the
 * one comparison every such rule reduces to.
 */
export function adjacentTo(first: Token, second: Token): boolean {
  return (
    first.end.line === second.start.line &&
    first.end.column === second.start.column &&
    first.end.offset === second.start.offset
  );
}
