/**
 * Classifies an error a read/resolve/link/compile call threw into what this CLI does with it --
 * the layer that keeps `EXIT.INVALID` (the tool ran, the input was bad) apart from `EXIT.FAULT`
 * (the tool did not reach a verdict), which is this whole work package's own stated distinction.
 *
 * **Why this exists at all, rather than just trusting `validate()`'s collected `diagnostics`.**
 * `@ltr8/tson`'s `validate()` now holds to its own contract in full: a base-syntax failure
 * (malformed UTF-8, an unlexable token, a structural parse error) and a construct the library has
 * no reader for both reach the collector as diagnostics rather than being thrown past it, so the
 * common path through `commands/validate.ts` never enters this classifier at all. What is left
 * for it is the calls that are genuinely fail-fast -- `readTree`, and every schema-side
 * resolve/link/compile call, none of which collect -- plus the ones this CLI makes against a
 * *schema* document rather than a data one (`isInvalidSchemaError` below).
 *
 * It also stays as the second half of the same classification for data reads, because the two
 * routes must agree: a document that throws `TsonLexError` here is classified `'invalid'` with a
 * `VALIDATION_ERROR` diagnostic, which is the identical shape `validate()` would have collected.
 * A caller cannot tell which route their document took, and should not be able to.
 *
 * The one distinction neither route may lose is `TsonNotImplementedError`. `compile()`'s reader
 * cache is lazy (`compiler/compile.ts`'s own doc -- a deliberate divergence from the reference
 * implementation's eager compile), so a gap in this library surfaces only when a value of that
 * type is actually read. Thrown, it lands here as `'not-implemented'`; collected, it carries the
 * `NOT_IMPLEMENTED` code that `commands/validate.ts` reads off the diagnostic list. Either way it
 * escalates the run past `EXIT.INVALID` to `EXIT.FAULT`, because nothing was checked -- reporting
 * a library gap as "your document is invalid" is the one answer that is simply false.
 */
import {
  TsonLexError,
  TsonNotImplementedError,
  TsonParseError,
  TsonReadError,
  TsonSchemaValidationError,
  TsonUnsupportedDocumentError,
  type Diagnostic,
} from '@ltr8/tson';

export type Problem =
  /** A verdict on the input: something to show the caller and count toward `EXIT.INVALID`. */
  | { readonly kind: 'invalid'; readonly diagnostic: Diagnostic }
  /** A construct this library has no reader for yet -- not a verdict; escalates a run to `EXIT.FAULT`. */
  | { readonly kind: 'not-implemented'; readonly message: string }
  /** Anything else: a bug here, or an environment failure (an unreadable file, ...). Always `EXIT.FAULT`. */
  | { readonly kind: 'fault'; readonly error: unknown };

function baseSyntaxDiagnostic(
  error: TsonLexError | TsonParseError | TsonUnsupportedDocumentError,
): Diagnostic {
  return {
    code: 'VALIDATION_ERROR',
    message: error.message,
    dataPosition: error.position,
  };
}

/** Classifies an error thrown while reading or validating one *data* document. */
export function classifyReadError(error: unknown): Problem {
  if (error instanceof TsonNotImplementedError) {
    return { kind: 'not-implemented', message: error.message };
  }
  if (
    error instanceof TsonLexError ||
    error instanceof TsonParseError ||
    error instanceof TsonUnsupportedDocumentError
  ) {
    return { kind: 'invalid', diagnostic: baseSyntaxDiagnostic(error) };
  }
  if (error instanceof TsonReadError) {
    return { kind: 'invalid', diagnostic: error.diagnostic };
  }
  // TsonInternalError and anything else (an unreadable file, a bug here) land the same way:
  // this run did not reach a verdict, which is exactly EXIT.FAULT's meaning.
  return { kind: 'fault', error };
}

/**
 * Whether `error` is a verdict on a *schema document* rather than on this tool -- structurally
 * malformed (fails to lex/parse at all) or semantically invalid (`!!id` missing, `!!meta`/
 * `!!import` unregistered, a reference that does not resolve, composition/refinement/template
 * misuse, choice disjointness, ...). Shared by `commands/compile.ts` (where it means "invalid,
 * exit 1") and `commands/validate.ts`'s own `--schema` loading (where it means "usage error, exit
 * 2" -- the caller asked this run to validate against a schema that is not usable, which is a
 * different verdict than "this schema, as data, does not compile").
 */
export function isInvalidSchemaError(error: unknown): error is Error {
  return (
    error instanceof TsonSchemaValidationError ||
    error instanceof TsonLexError ||
    error instanceof TsonParseError ||
    error instanceof TsonUnsupportedDocumentError
  );
}

/** Renders any thrown value as one line for `--format text`/stderr -- never assumes an `Error`. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
