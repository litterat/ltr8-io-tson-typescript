/**
 * Classifies an error a read/resolve/link/compile call threw into what this CLI does with it --
 * the layer that keeps `EXIT.INVALID` (the tool ran, the input was bad) apart from `EXIT.FAULT`
 * (the tool did not reach a verdict), which is this whole work package's own stated distinction.
 *
 * **Why this exists at all, rather than just trusting `validate()`'s collected `diagnostics`.**
 * `@ltr8/tson`'s `validate()`/`readTree()` route every problem a *reader* finds through the
 * `DiagnosticsReceiver` in scope, so a collecting call never throws for those -- but a
 * base-syntax failure (malformed UTF-8, an unlexable token, a structural parse error) is raised
 * by the lexer/event stream *before* any `ReadContext` exists to report through, and reaches the
 * caller as a thrown `TsonLexError`/`TsonParseError`/`TsonUnsupportedDocumentError` regardless of
 * which receiver was in play. The reference implementation's own facade documents catching
 * exactly this case into a diagnostic ("both facades catch a document that will not lex or parse
 * ... a collecting read never throws for a bad document") -- this port's `validate()` does not
 * (verified by reading `facade/tree.ts`/`compiler/compile.ts`: neither wraps `createDataStream`),
 * so a malformed document handed to `validate()` throws past the collector rather than showing up
 * in its `diagnostics`. **This is a facade gap worth reporting upstream**, not something this CLI
 * works around by reaching past the facade -- it is worked around here by catching exactly the
 * error classes `@ltr8/tson` already exports and classifying them the same way a collected
 * `VALIDATION_ERROR` diagnostic would read.
 *
 * The same asymmetry applies to `TsonNotImplementedError`: `compile()`'s own reader cache is
 * lazy (`compiler/compile.ts`'s own doc -- a deliberate divergence from the reference
 * implementation's eager compile), so a gap in this library surfaces only when a value of that
 * type is actually read, as a thrown exception past the collector, not as a `NOT_IMPLEMENTED`
 * diagnostic beside the others the way the reference implementation's design intends. Until a
 * later wave threads `NOT_IMPLEMENTED` through the reader stack the way the reference does, this
 * classifier is the only place that distinction is made for the CLI's own reporting.
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
