/**
 * `tson strip [--keep-docs] <schema>` -- a schema document's reading form (`stripSchema`): no
 * `!!id`, no `?sha256=` pins, no documentary annotations, the spec's own library shortened,
 * whitespace collapsed. `--keep-docs` keeps `@doc`, `@title` and `@examples`. The file is never
 * rewritten, since the result is not a loadable schema.
 *
 * A file that is not a well-formed schema document is a verdict on the input (exit 1, reported as
 * `file:line:col: message`); a file that cannot be read is a usage failure (exit 2). A stripper
 * fault -- output that does not re-lex or re-parse -- is not a verdict and propagates to `main`,
 * which reports it as an internal error.
 */
import { readFile } from 'node:fs/promises';
import {
  formatPosition,
  stripSchema,
  stripSchemaKeepingDocs,
  TsonLexError,
  TsonParseError,
  TsonUnsupportedDocumentError,
} from '@ltr8/tson';
import { describeError } from '../problem.js';

export type StripResult =
  /** The reading form, ready to print. */
  | { readonly kind: 'stripped'; readonly text: string }
  /** The file is not a well-formed schema document: `message` is `file:line:col: message`. */
  | { readonly kind: 'malformed'; readonly message: string }
  /** The file could not be read. */
  | { readonly kind: 'unreadable'; readonly message: string };

export async function runStrip(file: string, keepDocs: boolean): Promise<StripResult> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(file);
  } catch (error) {
    return { kind: 'unreadable', message: `cannot read ${file}: ${describeError(error)}` };
  }
  let source: string;
  try {
    // `ignoreBOM` keeps a byte-order mark in the text: the lexer owns what a BOM means (§7.1).
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { kind: 'malformed', message: `${file}: not valid UTF-8` };
  }
  try {
    return {
      kind: 'stripped',
      text: keepDocs ? stripSchemaKeepingDocs(source) : stripSchema(source),
    };
  } catch (error) {
    if (
      error instanceof TsonLexError ||
      error instanceof TsonParseError ||
      error instanceof TsonUnsupportedDocumentError
    ) {
      // The error's message already ends ` at line:col`; the location leads instead.
      const where = formatPosition(error.position);
      const text = error.message.endsWith(` at ${where}`)
        ? error.message.slice(0, -` at ${where}`.length)
        : error.message;
      return { kind: 'malformed', message: `${file}:${where}: ${text}` };
    }
    throw error;
  }
}
