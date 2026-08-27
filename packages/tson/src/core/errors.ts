import { formatPosition, type Position } from './position.js';

/**
 * Base class for every error this library raises.
 *
 * The `Tson` prefix is kept on errors even though module namespacing makes it redundant
 * elsewhere: an error name appears verbatim in a stack trace and in `instanceof` checks that
 * cross bundle boundaries where module identity is lost, and a bare `ParseError` in a stack
 * trace names nothing.
 */
export class TsonError extends Error {
  override readonly name: string = 'TsonError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    // Restores the prototype chain when compiled down-level, so `instanceof` holds.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * An error carrying the source position it was detected at.
 *
 * The position is where the offending construct *starts*, not where scanning stopped.
 */
export class TsonPositionedError extends TsonError {
  override readonly name: string = 'TsonPositionedError';
  readonly position: Position;

  constructor(message: string, position: Position, options?: { cause?: unknown }) {
    super(`${message} at ${formatPosition(position)}`, options);
    this.position = position;
  }
}

/**
 * A lexical error: the byte stream is not a well-formed sequence of TSON tokens (§7.2, §7.3).
 *
 * Covers malformed UTF-8 (bad lead byte, bad continuation, truncated sequence, overlong form,
 * an encoded surrogate, a value above U+10FFFF), a non-NFC unquoted token, an unrecognised
 * character outside a quoted token, and an unterminated token. Malformed input is always an
 * error and never substituted with U+FFFD, as §7.1 requires.
 */
export class TsonLexError extends TsonPositionedError {
  override readonly name = 'TsonLexError';
}

/**
 * A structural error: the tokens are well-formed but do not spell a valid document (§7.4).
 */
export class TsonParseError extends TsonPositionedError {
  override readonly name = 'TsonParseError';
}

/**
 * A well-formed document this processor will not handle.
 *
 * Raised by a Class 1 (data-only) path when handed a schema document — a header whose first
 * directive past any `!!id` is `!!meta` (§1.5, §2.2).
 */
export class TsonUnsupportedDocumentError extends TsonPositionedError {
  override readonly name = 'TsonUnsupportedDocumentError';
}

/**
 * A token that is not a valid member of its declared built-in type (§5).
 *
 * The distinction from {@link TsonAtomValidationError} is the spec's, not a nicety: a token
 * that is not shaped like the type at all is a *parse* failure, while a correctly-shaped
 * value outside a declared bound is a *validation* failure. The conformance suite asserts
 * these categories separately.
 */
export class TsonAtomParseError extends TsonError {
  override readonly name = 'TsonAtomParseError';
  /** The type name that rejected the token, e.g. `base64`. */
  readonly typeRef: string;

  constructor(typeRef: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.typeRef = typeRef;
  }
}

/** A correctly-shaped atom whose value falls outside a constraint the schema declares (§5). */
export class TsonAtomValidationError extends TsonError {
  override readonly name = 'TsonAtomValidationError';
  readonly typeRef: string;

  constructor(typeRef: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.typeRef = typeRef;
  }
}

/** A read failed against the schema in scope, under a fail-fast diagnostics receiver. */
export class TsonReadError extends TsonError {
  override readonly name: string = 'TsonReadError';
}

/** A value could not be written: it does not match the binding it was emitted through. */
export class TsonWriteError extends TsonError {
  override readonly name = 'TsonWriteError';
}

/**
 * A schema type and the binding registered for it disagree about the type's fields.
 *
 * Raised at compile time, not first read, so the mismatch surfaces at startup. Every
 * non-FIXED field must have a slot and every slot must fill a field; optional fields are
 * deliberately *not* exempt, since those are the ones that work in development and fail on
 * the first caller who sends them.
 */
export class TsonBindMismatchError extends TsonError {
  override readonly name: string = 'TsonBindMismatchError';
}

/**
 * A schema type has no binding at all.
 *
 * Deferred to the first read of that type rather than raised at compile time, since a schema
 * legitimately declares types a consumer never binds.
 */
export class TsonMissingBindingError extends TsonBindMismatchError {
  override readonly name = 'TsonMissingBindingError';
}

/** A schema document is syntactically valid but does not resolve, link, or register (Part 2). */
export class TsonSchemaValidationError extends TsonError {
  override readonly name = 'TsonSchemaValidationError';
}

/** A schema reference could not be fetched, or was refused by the source's own policy. */
export class TsonSchemaFetchError extends TsonError {
  override readonly name = 'TsonSchemaFetchError';
  /** The schema id that could not be resolved. */
  readonly schemaId: string;

  constructor(schemaId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.schemaId = schemaId;
  }
}

/**
 * A fetched schema's bytes do not hash to the `?sha256=` pin its reference carries (§2.2.1).
 *
 * The id is identity and the hash is integrity; a mismatch means the document at that id is
 * not the one the reference was written against.
 */
export class TsonContentHashMismatchError extends TsonError {
  override readonly name = 'TsonContentHashMismatchError';
  readonly schemaId: string;
  readonly expected: string;
  readonly actual: string;

  constructor(schemaId: string, expected: string, actual: string) {
    super(`content hash mismatch for ${schemaId}: expected ${expected}, computed ${actual}`);
    this.schemaId = schemaId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** An I-Regexp pattern (RFC 9485) is not syntactically valid. */
export class TsonRegexSyntaxError extends TsonError {
  override readonly name = 'TsonRegexSyntaxError';
}

/**
 * A construct this implementation has not built yet.
 *
 * Distinct from every error above: those say the input is wrong, this says the library is
 * incomplete. Keeping it separate is what lets a gap be reported as {@link DiagnosticCode}
 * `NOT_IMPLEMENTED` rather than being mistaken for invalid input.
 */
export class TsonNotImplementedError extends TsonError {
  override readonly name = 'TsonNotImplementedError';
}

/**
 * An invariant this library guarantees has been broken.
 *
 * Never reachable from any document, however malformed. Seeing one is a bug here.
 */
export class TsonInternalError extends TsonError {
  override readonly name = 'TsonInternalError';
}
