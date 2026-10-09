import type { NameHygieneMechanism } from '../unicode/policy.js';
import {
  TsonAtomParseError,
  type SchemaFetchReason,
  type TsonAtomTypeError,
  type TsonNameHygieneRefusedError,
} from './errors.js';
// Referenced only from a TSDoc {@link} tag above, which the unused-vars rule cannot see -- see
// `atom/contract.ts`'s own copy of this note.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { TsonAtomValidationError } from './errors.js';
import type { Position } from './position.js';

/**
 * The closed set of problems a read can report (§8.1).
 *
 * Closed on purpose: a consumer switching on a code must be able to see every case, and a
 * new code is an API change rather than a new string appearing in a message.
 */
export type DiagnosticCode =
  /** A resource limit was exceeded ([TSON-DATA] §9.1, [TSON-SCHEMA] §11.5) -- a refusal ({@link isRefusal}), §8.1's fifth outcome and not a verdict, naming the limit and the threshold it was checked against. */
  | 'LIMIT_REFUSED'
  /** A required field was absent from the data. */
  | 'FIELD_REQUIRED'
  /** A field the schema fixes carried a different value. */
  | 'FIELD_FIXED'
  /**
   * A field group's presence rule broken ([TSON-SCHEMA] §5.11): no option chosen where the group
   * needs one, more chosen than it admits, or a chosen option missing a member its group does not
   * mark optional. One code for everything a group decides, so a consumer repairs the group as one
   * thing rather than as separate field and type problems; a field outside any group keeps
   * {@link FIELD_REQUIRED}.
   */
  | 'FIELD_GROUP'
  /**
   * The value's type is not one the position takes. Covers a written type annotation naming a
   * type the position does not admit ([TSON-SCHEMA] §7.2's subsumption rule, a choice's variant
   * membership, a union's alike) and a position where a selector is *required* and absent, since
   * no type is established either way.
   *
   * **The line against {@link UNKNOWN_TYPE_REF} is whether the written name resolves.** Here it
   * does, and what fails is admissibility -- a verdict on the document read against a schema that
   * loaded, so §8.1's `validation` category. **Object-binding mode reports this code
   * unconditionally** for a name its `Binding` does not admit (`reader/bind.ts`, `bind/decode.ts`):
   * a `Binding` carries no view of the governing schema's whole namespace to ask whether an
   * unadmitted name resolves to some other entry (`reader/bind.ts`'s own top note, "No schema in
   * view, by design"), so there this code is the only one those two sites can ever report for an
   * unadmitted name, resolved elsewhere or not.
   */
  | 'TYPE_MISMATCH'
  /** A tuple or template application has the wrong number of elements or arguments. */
  | 'WRONG_ARITY'
  /**
   * The written name denotes nothing -- a type-ref or an annotation naming no type the governing
   * schema declares, or, on the schemaless path, one linking to nothing at all (§5.1). §8.1's
   * `resolver` category, an unresolved reference being what that category is for.
   *
   * A name that *does* resolve and is merely not admissible at its position is
   * {@link TYPE_MISMATCH}, not this -- and where a dispatcher has no way to ask whether a name
   * resolves elsewhere at all (object-binding mode, {@link TYPE_MISMATCH}'s own note), every
   * unadmitted name reports {@link TYPE_MISMATCH} unconditionally rather than this code.
   *
   * **A second, narrower use: [TSON-JSON] §3.2/§3.3's reserved `$`-member namespace**
   * (`json/schema/reservedMembers.ts`). There the name in question is the *member name itself* --
   * an unknown `$`-initial member, a `$schema`/`$type` that does not lead its object, a `$value`
   * with no leading `$type`, or a non-reserved member beside `$value` in wrapper form -- and what
   * denotes nothing is the member's own position: the closed reserved namespace admits no such
   * member there, whatever type name a `$type` alongside it might separately resolve to (§9.4's
   * table puts all four under the `resolver` row). This is still "the written name denotes
   * nothing admissible here", read one level up from a type-ref: the member, not its value.
   */
  | 'UNKNOWN_TYPE_REF'
  /**
   * A token a built-in atom's *parsing contract* rejects outright -- not shaped like the type at
   * all (§5.2). §8.1 files this as a `resolver` error: the structural parser has already accepted
   * the document before the atom contract is consulted, so a contract failure resolves, it does
   * not parse. The split from {@link ATOM_CONSTRAINT_VIOLATION} rides on
   * {@link TsonAtomParseError}/{@link TsonAtomValidationError} ({@link diagnosticCodeForAtomError}
   * is the one place the mapping is made); a numeric value merely outside the target's declared
   * range is the latter, never this one.
   */
  | 'ATOM_FORM_INVALID'
  /** A correctly-shaped atom's value violates a declared constraint (§5.2) -- a `validation` error, not a resolver one. */
  | 'ATOM_CONSTRAINT_VIOLATION'
  /** The data carried a field the type does not declare. */
  | 'UNRECOGNIZED_FIELD'
  /** Two entries of one map share a key (§2.6). */
  | 'DUPLICATE_MAP_KEY'
  /** A map entry's key is the void sentinel (§2.9). */
  | 'VOID_MAP_KEY'
  /** Two fields of one record share a name (§2.5). */
  | 'DUPLICATE_FIELD'
  /**
   * The governing schema was obtained but is invalid or failed to resolve -- a verdict on the
   * schema itself, distinct from the five `SCHEMA_*` codes below (§10.1, §10.2): those mean the
   * schema was *never obtained*, so nothing here says whether it would have resolved.
   *
   * **A §10.2 pin mismatch is the same category, not one of the five.** Bytes *were* obtained; the
   * finding is about them, not about an unavailable reference. This port does not currently carry
   * that finding as far as a `Diagnostic` bearing this code, though: `config.ts`'s
   * `resolveSchema`/`preload` both pin-check every schema they load (`recordContentHash`,
   * `verifyPin`) before any declaration is resolved, and a mismatch throws
   * `TsonContentHashMismatchError` directly out of `resolveSchema`/`preload`/`fetch` rather than
   * being caught and classified into one of `compiler/schemaResolver.ts`'s
   * `ReportableSchemaError`s the way the errors {@link diagnosticCodeForFetch} and
   * {@link diagnosticCodeForAtomError} classify are. A caller distinguishing "resolver category"
   * from "validation category" for this failure today does so by catching
   * `TsonContentHashMismatchError` itself, not by reading a `Diagnostic.code`.
   */
  | 'SCHEMA_ERROR'
  /** A type reference does not resolve within the linked schema. */
  | 'UNKNOWN_TYPE'
  /**
   * A value opened a schema scope with a nested `!!schema` at a position whose type is not a
   * `scoped` instance, a container of scoped elements included ([TSON-SCHEMA] §7.1, §7.8).
   * Cross-schema acceptance is authored intent, declared by the position's own type, so a position
   * that did not declare it has no cell to refuse the directive: §8.1's `resolver` category, where
   * a nested `!!schema` at a `scoped` position whose cell does not admit it is a validation error.
   */
  | 'SCOPE_NOT_ADMITTED'
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
  // A refusal is not a verdict ({@link isVerdict}): it asserts nothing about whether the document
  // is valid, only that this processor's policy declined it -- another deployment's policy may
  // accept the same bytes. It is §8.1's fifth outcome, reported apart from the four categories.

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

/**
 * The code one {@link TsonAtomTypeError} reports -- `ATOM_FORM_INVALID` for a
 * {@link TsonAtomParseError} (the token isn't shaped like the type at all), else
 * `ATOM_CONSTRAINT_VIOLATION` for its sibling {@link TsonAtomValidationError} (§5.2, §8.1).
 *
 * The one place the split is made, mirroring the reference's own `AtomRefusal.of`: every call
 * site that catches a {@link TsonAtomTypeError} routes its code through here rather than
 * hardcoding `ATOM_CONSTRAINT_VIOLATION` for both subtypes.
 */
export function diagnosticCodeForAtomError(error: TsonAtomTypeError): DiagnosticCode {
  return error instanceof TsonAtomParseError ? 'ATOM_FORM_INVALID' : 'ATOM_CONSTRAINT_VIOLATION';
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

/**
 * The diagnostic a thrown {@link TsonNameHygieneRefusedError} reports: its §8.2 code, its message,
 * and -- for a refusal while loading a schema -- the schema's id and the pointer to the refused
 * key. One function, so a fail-fast throw and a collecting report cannot disagree on either.
 */
export function diagnosticOfNameRefusal(error: TsonNameHygieneRefusedError): Diagnostic {
  return {
    code: diagnosticCodeForMechanism(error.mechanism),
    message: error.message,
    ...(error.schemaId === undefined ? {} : { schemaId: error.schemaId }),
    ...(error.pointer === undefined ? {} : { schemaPointer: error.pointer }),
  };
}

/**
 * Whether `code` is one of §8.2's three name-hygiene refusals. A refusal is never reported under
 * one of §8.1's four categories and is not a verdict ({@link isVerdict}), so "was this reported
 * as an error of the document" is simply `isVerdict(code)`.
 */
export function isNameRefusal(code: DiagnosticCode): boolean {
  return (
    code === 'CONFUSABLE_NAMES' || code === 'RESTRICTED_CHARACTER' || code === 'RESTRICTED_SCRIPT'
  );
}

/**
 * Whether `code` is a §8.1 refusal: this processor declined the document under its own policy,
 * data version or limits -- a §8.2 name refusal ({@link isNameRefusal}) or a §9.1 limit refusal
 * (`LIMIT_REFUSED`). The same bytes may be accepted in full by a processor configured otherwise,
 * so a refusal is not a verdict ({@link isVerdict}) and is never reported under one of §8.1's four
 * categories. The five `SCHEMA_*` fetch codes are the other kind of non-verdict -- no schema was
 * obtained -- and are not refusals.
 */
export function isRefusal(code: DiagnosticCode): boolean {
  return isNameRefusal(code) || code === 'LIMIT_REFUSED';
}

/** The codes that assert nothing about the document -- see {@link isVerdict}. */
const NON_VERDICT: ReadonlySet<DiagnosticCode> = new Set([
  'CONFUSABLE_NAMES',
  'RESTRICTED_CHARACTER',
  'RESTRICTED_SCRIPT',
  'LIMIT_REFUSED',
  'NOT_IMPLEMENTED',
  'BIND_MISMATCH',
  'SCHEMA_NOT_PERMITTED',
  'SCHEMA_NOT_FOUND',
  'SCHEMA_UNREACHABLE',
  'SCHEMA_TIMEOUT',
  'SCHEMA_TOO_LARGE',
] satisfies DiagnosticCode[]);

/**
 * Whether `code` reports something an evaluation actually looked at and found, as opposed to a
 * check this library could not run at all.
 *
 * **A `false` answer means the document was not judged**, §8.1's "fifth outcome, not a verdict".
 * Two groups answer `false`. A refusal ({@link isRefusal}) says this processor declined under its
 * own policy, data version or limits -- a §8.2 name refusal, or a §9.1 limit refusal -- which
 * asserts nothing about validity: "the document may be well-formed, valid and accepted in full by
 * the next processor along" (§9.1). The rest say no rule ran: `NOT_IMPLEMENTED` that this library
 * could not check it, `BIND_MISMATCH` that the reading application is wired wrong, and the five
 * `SCHEMA_*` codes that no schema was obtained to check against (§10.1).
 *
 * A consumer that asks whether a document was *rejected* rather than *judged* asks
 * {@link isRefusal} beside this: the CLI reports a refused file as `NOT_CHECKED` and still exits
 * 1, since the sender holds the fix.
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
 * **`path` and {@link SchemaLocation.pointer} read `''` differently, because the two questions
 * they answer are different.** `pointer` answers "is there a schema sub-location at all?", and a
 * diagnostic with none is not somehow located at the schema's root -- it has no schema location,
 * which is what `undefined` there means. `path` answers "where in the data did this happen?", and
 * a diagnostic about the document root has an answer to that question: RFC 6901 spells the root
 * `''`, and a root-level diagnostic (a type mismatch on the whole document, say) states it rather
 * than omitting the field. `path` is `undefined` only for a diagnostic not anchored in the data at
 * all -- a schema-only problem (resolution, linking) that never reached a document to place a
 * pointer into.
 */
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  /** RFC 6901 pointer into the data document -- `''` at its root, `undefined` when the diagnostic is not anchored in the data at all. */
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
