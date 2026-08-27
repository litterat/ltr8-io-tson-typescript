/**
 * A source position: 1-based line, 1-based column counted in Unicode **code points**
 * (TSON is a Unicode-first grammar, §7.1), and a 0-based **UTF-8 byte** offset from the
 * start of the document, measured after any leading BOM has been stripped (§8.1).
 *
 * Three properties are load-bearing and easy to get wrong in JavaScript:
 *
 * - `column` counts code points, never UTF-16 code units. A supplementary-plane character
 *   occupies one column but two units of a JS string, so a column derived from
 *   `String.prototype.length` is wrong for any document containing one.
 * - `offset` counts UTF-8 bytes as the decoder consumes them, and is never re-derived from
 *   an already-decoded value: a length computed that way is only correct while the input is
 *   well-formed, which is exactly the case where an offset matters least.
 * - Both are recorded at the *start* of the construct being reported.
 *
 * JavaScript numbers give this a 2^53 range where the reference implementation's `int`
 * capped it at 2 GiB.
 */
export interface Position {
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column, counted in Unicode code points. */
  readonly column: number;
  /** 0-based offset in UTF-8 bytes, after any leading BOM. */
  readonly offset: number;
}

/** The position a document starts at, before anything has been consumed. */
export const START: Position = Object.freeze({ line: 1, column: 1, offset: 0 });

/** Construct a {@link Position}. */
export function position(line: number, column: number, offset: number): Position {
  return { line, column, offset };
}

/** Render a position as `line:column`, the form error messages use. */
export function formatPosition(p: Position): string {
  return `${String(p.line)}:${String(p.column)}`;
}
