import type { Diagnostic } from './diagnostic.js';
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
 *
 * `expected` and `actual` are the machine-readable half of the same failure — the division of
 * labour {@link TsonAtomTypeError} makes for value errors, made here for structural ones. §8.1
 * asks a processor to include expected-versus-found information for token and structural
 * mismatches, and {@link Diagnostic} carries both fields through unchanged.
 *
 * The pair is all-or-nothing and both are optional, because a throw site that states a *rule*
 * rather than a substitution — an adjacency violation, a trailing separator — has no substitution
 * to name. No throw site invents one to fill the other.
 */
export class TsonParseError extends TsonPositionedError {
  override readonly name = 'TsonParseError';
  /** The construct admissible where the parse failed. */
  readonly expected?: string;
  /** What was written there instead. */
  readonly actual?: string;

  constructor(
    message: string,
    position: Position,
    options?: { expected?: string; actual?: string; cause?: unknown },
  ) {
    super(message, position, options);
    if (options?.expected !== undefined) this.expected = options.expected;
    if (options?.actual !== undefined) this.actual = options.actual;
  }
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
 * An atom rejected a token, either for its shape or for its value (§5).
 *
 * `expected` is the machine-readable half, and is the reason this type carries two strings
 * rather than one: `message` is prose for a human, `expected` is a fragment a renderer composes
 * into `expected <= 100, found 99999`. It reaches {@link Diagnostic.expected} verbatim, while
 * `actual` is supplied by the reader from the token's own text rather than by the throw site.
 *
 * Every throw site draws its `expected` from one closed vocabulary of six shapes, each a
 * fragment and never a sentence:
 *
 * - **ordering bound** — `>= 1`, `<= 100`, `>= -128 and <= 127`. Operator form, not prose.
 * - **membership** — `one of (PENDING, SHIPPED, DELIVERED)`.
 * - **length** — `exactly 4 characters`, `at least 2 bytes`.
 * - **pattern** — `matching <i-regexp>`, unquoted and unescaped.
 * - **grammar** — parse failures only: `an RFC 3339 date-time`, `a base64 encoding`.
 * - **prohibition** — `not NaN`, `a finite value`.
 *
 * `expected` is required rather than optional on purpose. The vocabulary only holds if every
 * throw site supplies one, and an optional field is the one thirty-three parsers would skip.
 */
export abstract class TsonAtomTypeError extends TsonError {
  /** The type name that rejected the token, e.g. `base64`. */
  readonly typeRef: string;
  /** The violated constraint, standing alone — one of the six shapes above. */
  readonly expected: string;

  constructor(typeRef: string, message: string, expected: string, options?: { cause?: unknown }) {
    super(message, options);
    this.typeRef = typeRef;
    this.expected = expected;
  }
}

/**
 * A token that is not a valid member of its declared built-in type (§5).
 *
 * The distinction from {@link TsonAtomValidationError} is the spec's, not a nicety: a token
 * that is not shaped like the type at all is a *parse* failure, while a correctly-shaped
 * value outside a declared bound is a *validation* failure. The conformance suite asserts
 * these categories separately.
 */
export class TsonAtomParseError extends TsonAtomTypeError {
  override readonly name = 'TsonAtomParseError';
}

/** A correctly-shaped atom whose value falls outside a constraint the schema declares (§5). */
export class TsonAtomValidationError extends TsonAtomTypeError {
  override readonly name = 'TsonAtomValidationError';
}

/**
 * A read failed against the schema in scope, under a fail-fast diagnostics receiver.
 *
 * Carries the whole {@link Diagnostic} rather than flattening it into a message. A caller that
 * catches this needs the code, the RFC 6901 path and the position to act on it — a server mapping
 * read failures onto responses, a form highlighting the field that was wrong — and none of that is
 * recoverable from prose once it has been flattened.
 *
 * `message` comes from the diagnostic, and {@link toString} appends the data position when the
 * diagnostic locates one, so a stack trace says where without the catcher having to.
 */
export class TsonReadError extends TsonError {
  override readonly name: string = 'TsonReadError';

  /** The diagnostic that failed the read. */
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic, options?: { cause?: unknown }) {
    super(diagnostic.message, options);
    this.diagnostic = diagnostic;
  }

  override toString(): string {
    const at =
      this.diagnostic.dataPosition === undefined
        ? ''
        : ` at ${formatPosition(this.diagnostic.dataPosition)}`;
    return `${this.name}: ${this.message}${at}`;
  }
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

/**
 * Why a schema fetch failed.
 *
 * The classification is the part worth acting on, and it is closed rather than free text because
 * a caller has to branch on it: a server mapping schema failures onto status codes needs the
 * split and cannot recover it from a flattened message.
 *
 * The line that matters is whose mistake it was. `not-permitted` means the reference names
 * something this deployment will not load and no retry will ever help — a host outside the
 * allow-list, a scheme that is not enabled. `transport` and `timeout` say the opposite: the
 * request was allowed and did not arrive, so retrying is reasonable.
 */
export type SchemaFetchReason =
  /** The reference names something this deployment will not load. Retrying cannot help. */
  | 'not-permitted'
  /** The source was reachable and had no such schema. */
  | 'not-found'
  /** The request failed in transit. */
  | 'transport'
  /** The request did not complete within the configured budget. */
  | 'timeout'
  /** The response exceeded the configured size cap, enforced while streaming. */
  | 'too-large';

/** A schema reference could not be fetched, or was refused by the source's own policy. */
export class TsonSchemaFetchError extends TsonError {
  override readonly name = 'TsonSchemaFetchError';
  /** The schema id that could not be resolved. */
  readonly schemaId: string;
  /** Why it could not be resolved — see {@link SchemaFetchReason}. */
  readonly reason: SchemaFetchReason;

  constructor(
    schemaId: string,
    reason: SchemaFetchReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.schemaId = schemaId;
    this.reason = reason;
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

/**
 * [TSON-DATA] §8.2's mechanism that refused a name -- see {@link TsonNameHygieneRefusedError}.
 * Kept here rather than imported from `unicode/policy.ts`'s own identically-shaped type: `core/`
 * sits below `unicode/` in this package's import graph, and a plain string-literal union needs no
 * shared identity to be assignable both ways.
 */
export type NameHygieneMechanism =
  'skeleton-distinctness' | 'identifier-status' | 'restriction-level';

/**
 * A document refused under [TSON-DATA] §8.2's name-hygiene policy -- §8.1's "fifth,
 * distinguishable outcome": "a refusal... MUST NOT be reported in any of the four categories
 * above" (lexer, parser, resolver, validation). This is what makes that true structurally rather
 * than by convention: it extends {@link TsonError} directly, never {@link TsonLexError},
 * {@link TsonParseError}, {@link TsonReadError}, or {@link TsonAtomTypeError} (or any of their
 * subclasses), so `instanceof` against every one of those four families -- what a category-mapping
 * caller like a conformance runner tests -- answers `false` unconditionally. A document that is
 * refused is never also reported as invalid; the two are different processors' verdicts on two
 * different questions.
 *
 * §8.2 requires a refusal to **name the UTS #39 data version it was computed against**, because
 * the mechanisms depend on `confusables.txt`, `IdentifierStatus.txt`, and `Script` -- none of
 * which the Unicode Consortium freezes -- so two conforming processors can legitimately disagree,
 * and the version is the only thing that explains it (`unicode/uts39.ts`'s own `UTS39_VERSION`).
 */
export class TsonNameHygieneRefusedError extends TsonError {
  override readonly name: string = 'TsonNameHygieneRefusedError';
  /** Which of §8.2's three mechanisms refused the document. */
  readonly mechanism: NameHygieneMechanism;
  /**
   * The offending name, or (for `'skeleton-distinctness'`, a relation over a pair) the confusable
   * pair `[first, second]` in the order they occurred -- `unicode/policy.ts`'s own
   * `NameHygieneRefusal.names`.
   */
  readonly names: readonly string[];
  /** The UCD release this refusal was computed against. */
  readonly uts39Version: string;

  constructor(
    message: string,
    details: {
      readonly mechanism: NameHygieneMechanism;
      readonly names: readonly string[];
      readonly uts39Version: string;
      readonly cause?: unknown;
    },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.mechanism = details.mechanism;
    this.names = details.names;
    this.uts39Version = details.uts39Version;
  }
}
