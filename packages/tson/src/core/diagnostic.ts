import type { NameHygieneMechanism } from '../unicode/policy.js';
import type { SchemaFetchReason } from './errors.js';
import type { Position } from './position.js';

/**
 * The closed set of problems a read can report (§8.1).
 *
 * Closed on purpose: a consumer switching on a code must be able to see every case, and a
 * new code is an API change rather than a new string appearing in a message.
 */
export type DiagnosticCode =
  /** A required field was absent from the data. */
  | 'FIELD_REQUIRED'
  /** A field the schema fixes carried a different value. */
  | 'FIELD_FIXED'
  /** The value's shape does not match the type in scope. */
  | 'TYPE_MISMATCH'
  /** A tuple or template application has the wrong number of elements or arguments. */
  | 'WRONG_ARITY'
  /** A `!type` annotation names a type the schema in scope does not declare. */
  | 'UNKNOWN_TYPE_REF'
  /** A built-in atom's declared constraint was violated. */
  | 'ATOM_CONSTRAINT_VIOLATION'
  /** The data carried a field the type does not declare. */
  | 'UNRECOGNIZED_FIELD'
  /** Two entries of one map share a key (§2.6). */
  | 'DUPLICATE_MAP_KEY'
  /** A map entry's key is the absent sentinel (§2.9). */
  | 'ABSENT_MAP_KEY'
  /** Two fields of one record share a name (§2.5). */
  | 'DUPLICATE_FIELD'
  /** The governing schema itself is invalid, unreachable, or failed to resolve. */
  | 'SCHEMA_ERROR'
  /** A type reference does not resolve within the linked schema. */
  | 'UNKNOWN_TYPE'
  /** A validation rule not covered by a more specific code. */
  | 'VALIDATION_ERROR'
  /** A construct this implementation has not built yet — a library gap, not bad input. */
  | 'NOT_IMPLEMENTED'
  /** A schema type and its registered binding disagree about the type's fields. */
  | 'BIND_MISMATCH'
  // -- A schema was not obtained: one code per reason ---------------------------------------
  //
  // None of these five is a verdict on anything. A schema reference (`!!import`, `!!meta`, or
  // `!!schema`) named a document no configured source would supply, so it was never obtained and
  // never read -- unlike `SCHEMA_ERROR`, which means the schema *was* obtained and is wrong.
  //
  // Why a fetch failed is a routing question, and a code is what a consumer routes on -- the same
  // reason §8.2's three refusal codes below are three codes rather than one code beside a
  // `mechanism` field. A reason carried as a field is a second carrier for one fact, free to
  // disagree with the first.
  //
  // One code per reason rather than a permanent/transient pair, because consumers partition them
  // differently: a command line by whether a rerun could help, an HTTP surface by whose doing it
  // was. A code encoding one partition strands the other. `SchemaFetchReason` (`core/errors.ts`)
  // is the throwing channel's vocabulary and the sole input to {@link diagnosticCodeForFetch}, so
  // the two channels cannot disagree.

  /** Policy refused it: not an allowed host, not a legal identity, or no pin where one is required. */
  | 'SCHEMA_NOT_PERMITTED'
  /** The location was reached and does not have it. */
  | 'SCHEMA_NOT_FOUND'
  /** The location could not be reached, or answered with something other than a document. */
  | 'SCHEMA_UNREACHABLE'
  /** The location did not answer in time. */
  | 'SCHEMA_TIMEOUT'
  /** The location answered with more bytes than a schema document is allowed to be. */
  | 'SCHEMA_TOO_LARGE'
  // -- [TSON-DATA] §8.2's name hygiene: one code per mechanism -------------------------------
  //
  // §8.1's "fifth outcome", carried on a `Diagnostic` only for a *collecting* read's own record
  // (`DiagnosticsCollector.diagnostics`). A fail-fast read never throws a `Diagnostic` bearing one
  // of these: it throws `core/errors.ts`'s own `TsonNameHygieneRefusedError` instead, which is
  // deliberately not reconstructible from a `DiagnosticCode` alone, because §8.1 requires this
  // outcome to be unmistakable for one of the four categories the rest of this union enumerates.
  //
  // Three codes, one per mechanism, rather than one code beside a `mechanism` field, for the
  // reason the five `SCHEMA_*` codes above give: the mechanism is what a consumer routes on.
  //
  // A refusal *is* a verdict ({@link isVerdict}) -- the processor looked and declined, and the
  // sender holds the fix -- though not a validity one.

  /** Two names in one scope reduce to one UTS #39 skeleton (mechanism 1). */
  | 'CONFUSABLE_NAMES'
  /** A name carries a character outside the identifier profile (mechanism 2). */
  | 'RESTRICTED_CHARACTER'
  /** A name does not satisfy the configured UTS #39 §5.2 restriction level (mechanism 3). */
  | 'RESTRICTED_SCRIPT';

/**
 * The code a fetch failure reports, one per {@link SchemaFetchReason}.
 *
 * The throwing channel (`TsonSchemaFetchError.reason`) and the reporting channel (this union) name
 * the same fact, so they resolve through one function rather than two parallel `switch`es that can
 * drift apart.
 */
export function diagnosticCodeForFetch(reason: SchemaFetchReason): DiagnosticCode {
  switch (reason) {
    case 'not-permitted':
      return 'SCHEMA_NOT_PERMITTED';
    case 'not-found':
      return 'SCHEMA_NOT_FOUND';
    case 'transport':
      return 'SCHEMA_UNREACHABLE';
    case 'timeout':
      return 'SCHEMA_TIMEOUT';
    case 'too-large':
      return 'SCHEMA_TOO_LARGE';
  }
}

/** The code a §8.2 refusal reports, one per {@link NameHygieneMechanism}. */
export function diagnosticCodeForMechanism(mechanism: NameHygieneMechanism): DiagnosticCode {
  switch (mechanism) {
    case 'skeleton-distinctness':
      return 'CONFUSABLE_NAMES';
    case 'identifier-status':
      return 'RESTRICTED_CHARACTER';
    case 'restriction-level':
      return 'RESTRICTED_SCRIPT';
  }
}

/** The codes that assert nothing about the document -- see {@link isVerdict}. */
const NON_VERDICT: ReadonlySet<DiagnosticCode> = new Set([
  'NOT_IMPLEMENTED',
  'BIND_MISMATCH',
  'SCHEMA_NOT_PERMITTED',
  'SCHEMA_NOT_FOUND',
  'SCHEMA_UNREACHABLE',
  'SCHEMA_TIMEOUT',
  'SCHEMA_TOO_LARGE',
] satisfies DiagnosticCode[]);

/**
 * Whether `code` is a verdict on the document -- **the document was checked, and this is what
 * checking found**.
 *
 * The seven that are not say so for three different reasons: `NOT_IMPLEMENTED` that this library
 * could not check it, `BIND_MISMATCH` that the reading application is wired wrong, and the five
 * `SCHEMA_*` codes that no schema was obtained to check against. None of them asserts anything
 * about the document, which is exactly what a caller routing on the answer needs to know -- and
 * why a plain `valid: boolean` cannot carry the answer: it conflates *was this checked* with *did
 * it pass*.
 *
 * A §8.2 name-hygiene refusal **is** a verdict, though not a validity one: the processor looked
 * and declined, and the sender holds the fix.
 *
 * Stated here so no consumer keeps its own copy of the set. Two already would -- the CLI's exit
 * code and its report outcome -- and a private copy each is how two consumers come to disagree
 * about one diagnostic.
 */
export function isVerdict(code: DiagnosticCode): boolean {
  return !NON_VERDICT.has(code);
}

/**
 * Where in a schema a problem was found: the schema's canonical id, a JSON Pointer into it,
 * and the position of the construct within that schema's own source.
 *
 * Accumulated as a read descends, and rendered lazily. Both halves matter: `pointer` is
 * `undefined` rather than `''` when the location is the schema root, because `''` is itself a
 * valid RFC 6901 pointer meaning exactly that.
 */
export interface SchemaLocation {
  /** The schema's canonical `!!id`. */
  readonly schemaId: string;
  /** RFC 6901 pointer into the schema, or `undefined` at its root. */
  readonly pointer?: string;
  /** Position within the schema document's own source. */
  readonly position?: Position;
}

/**
 * One problem found while reading, resolving, or validating.
 *
 * The shape follows JSON Schema 2020-12 §12's output unit: where in the *data* (`path`), where
 * in the *schema* (`schemaId` + `schemaPointer`), and what was wrong. One record serves both
 * data-side and schema-side problems so a caller has a single thing to render.
 *
 * `path` is `undefined` rather than `''` at the document root, for the same reason
 * {@link SchemaLocation.pointer} is.
 */
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  /** RFC 6901 pointer into the data document, or `undefined` at its root. */
  readonly path?: string;
  /** Canonical id of the schema in scope, when one is. */
  readonly schemaId?: string;
  /** RFC 6901 pointer into that schema, or `undefined` at its root. */
  readonly schemaPointer?: string;
  /** What the schema required, when the problem can state it. */
  readonly expected?: string;
  /** What the data carried, when the problem can state it. */
  readonly actual?: string;
  /** Position within the data document. */
  readonly dataPosition?: Position;
  /** Position within the schema document. */
  readonly schemaPosition?: Position;
}

/**
 * Where diagnostics go.
 *
 * The read stack holds no error policy of its own — it reports here and keeps going, and the
 * receiver decides whether that is fatal. A fail-fast reader and a collecting validator are
 * the same read with different receivers, which is what lets `validate()` reuse the reader
 * wholesale instead of re-deriving anything.
 */
export interface DiagnosticsReceiver {
  report(diagnostic: Diagnostic): void;
}

/**
 * A receiver that throws on the first diagnostic.
 *
 * The default for a plain read, where a caller wants a value or an exception rather than a
 * list of problems.
 */
export function throwing(makeError: (d: Diagnostic) => Error): DiagnosticsReceiver {
  return {
    report(diagnostic: Diagnostic): void {
      throw makeError(diagnostic);
    },
  };
}

/** A receiver that accumulates diagnostics, letting the read continue past each problem. */
export interface DiagnosticsCollector extends DiagnosticsReceiver {
  /** Everything reported so far, in report order. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Create a {@link DiagnosticsCollector}. */
export function collector(): DiagnosticsCollector {
  const diagnostics: Diagnostic[] = [];
  return {
    diagnostics,
    report(diagnostic: Diagnostic): void {
      diagnostics.push(diagnostic);
    },
  };
}
