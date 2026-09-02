# Diagnostics, errors, exit codes

## `DiagnosticCode`

A **closed union** — a new code is an API change, not a new string appearing in a message. Switch on
it exhaustively; never match on `message` text. `isVerdict(code)` says whether a code is a verdict
on the document at all — **the document was checked, and this is what checking found** — as opposed
to one of the reasons a run could not reach one.

| Code                        | Means                                                                                                                                   |         `isVerdict`          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------: |
| `FIELD_REQUIRED`            | a required field was absent from the data                                                                                               |             yes              |
| `FIELD_FIXED`               | a field the schema fixes carried a different value                                                                                      |             yes              |
| `TYPE_MISMATCH`             | the value's shape does not match the type in scope                                                                                      |             yes              |
| `WRONG_ARITY`               | a tuple or template application has the wrong element/argument count                                                                    |             yes              |
| `UNKNOWN_TYPE_REF`          | a `!type` annotation names a type the schema in scope does not declare                                                                  |             yes              |
| `ATOM_CONSTRAINT_VIOLATION` | a built-in atom's declared constraint was violated                                                                                      |             yes              |
| `UNRECOGNIZED_FIELD`        | the data carried a field the type does not declare (§7.2 — records are closed, always)                                                  |             yes              |
| `DUPLICATE_MAP_KEY`         | two entries of one map share a key (§2.6)                                                                                               |             yes              |
| `ABSENT_MAP_KEY`            | a map entry's key is the absent sentinel (§2.9)                                                                                         |             yes              |
| `DUPLICATE_FIELD`           | two fields of one record share a name (§2.5)                                                                                            |             yes              |
| `SCHEMA_ERROR`              | the governing schema itself is invalid or failed to resolve — it _was_ obtained                                                         |             yes              |
| `UNKNOWN_TYPE`              | a type reference does not resolve within the linked schema                                                                              |             yes              |
| `VALIDATION_ERROR`          | anything not covered by a more specific code — including a document that will not lex or parse, when reported through a collecting read |             yes              |
| `CONFUSABLE_NAMES`          | §8.2 mechanism 1: two names in one scope reduce to one UTS #39 skeleton                                                                 | yes (not a validity verdict) |
| `RESTRICTED_CHARACTER`      | §8.2 mechanism 2: a name carries a character outside the identifier profile (`Identifier_Status`)                                       | yes (not a validity verdict) |
| `RESTRICTED_SCRIPT`         | §8.2 mechanism 3: a name does not satisfy the configured UTS #39 §5.2 restriction level                                                 | yes (not a validity verdict) |
| `NOT_IMPLEMENTED`           | **a library gap, not bad input.** Surfaces at read time because compiled readers are built lazily                                       |              no              |
| `BIND_MISMATCH`             | a schema type and its registered binding disagree about the type's fields                                                               |              no              |
| `SCHEMA_NOT_PERMITTED`      | policy refused the reference: not an allowed host, not a legal identity, or no pin where one is required                                |              no              |
| `SCHEMA_NOT_FOUND`          | the location was reached and does not have it                                                                                           |              no              |
| `SCHEMA_UNREACHABLE`        | the location could not be reached, or answered with something other than a document                                                     |              no              |
| `SCHEMA_TIMEOUT`            | the location did not answer in time                                                                                                     |              no              |
| `SCHEMA_TOO_LARGE`          | the location answered with more bytes than a schema document is allowed to be                                                           |              no              |

`SCHEMA_ERROR` vs the five `SCHEMA_*` fetch codes is the distinction that matters for a caller
deciding whether to retry: `SCHEMA_ERROR` says the schema was obtained and is wrong; the fetch
codes say nothing was obtained, so nothing was checked. One code per fetch reason (rather than one
code plus a `reason` field) because different consumers partition them differently — a CLI by
whether a rerun could help (`SCHEMA_NOT_PERMITTED`/`SCHEMA_NOT_FOUND`/`SCHEMA_TOO_LARGE` won't
change on retry; `SCHEMA_UNREACHABLE`/`SCHEMA_TIMEOUT` might), another surface by whose doing it
was — and a code is what a consumer routes on.

Likewise `CONFUSABLE_NAMES`/`RESTRICTED_CHARACTER`/`RESTRICTED_SCRIPT` are one code per §8.2
mechanism rather than one code plus a `mechanism` field, for the same reason. A refusal **is** a
verdict — the processor looked and declined, and the sender holds the fix — though not a validity
one, which is why it is reported apart from the other four error categories (§8.1's "fifth
outcome"). A fail-fast read never throws a `Diagnostic` carrying one of these three: it throws
`TsonNameHygieneRefusedError` directly instead, deliberately not reconstructible from a
`DiagnosticCode` alone.

## The `Diagnostic` record

```ts
interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly path?: string; // RFC 6901 into the DATA; '' at its root, undefined when not anchored in data at all
  readonly schemaId?: string; // canonical id of the schema in scope
  readonly schemaPointer?: string; // RFC 6901 into that SCHEMA; undefined (not '') at its root
  readonly expected?: string;
  readonly actual?: string;
  readonly dataPosition?: Position; // { line, column, offset }
  readonly schemaPosition?: Position;
}
```

The shape follows JSON Schema 2020-12 §12's output unit — where in the data, where in the schema,
what was wrong — so one record renders both data-side and schema-side problems.

**`path` and `schemaPointer` read `''` differently, because the two questions they answer are
different.** `schemaPointer` answers "is there a schema sub-location at all?" — a diagnostic with
none is `undefined` there, not somehow located at the schema's root. `path` answers "where in the
data did this happen?", and a diagnostic about the document root has an answer to that: a
`TYPE_MISMATCH` on the whole document, say, carries `path: ""` rather than omitting the field.
`path` is `undefined` only for a diagnostic not anchored in the data at all — a schema-only problem
(resolution, linking, or a `SCHEMA_*`/`BIND_MISMATCH` fetch/binding failure) that never reached a
document to place a pointer into.

## Receivers

The read stack holds no error policy of its own; it reports and keeps going, and the receiver
decides whether that is fatal. A fail-fast reader and a collecting validator are the same read with
different receivers.

```ts
function throwing(makeError: (d: Diagnostic) => Error): DiagnosticsReceiver;
function collector(): DiagnosticsCollector; // { report, diagnostics }
```

## Error classes

```
Error
└── TsonError                        every error this library raises
    ├── TsonPositionedError          .position — where the construct STARTS
    │   ├── TsonLexError             malformed UTF-8, non-NFC unquoted token, bad character,
    │   │                            unterminated token (§7.2, §7.3). Never U+FFFD substitution.
    │   ├── TsonParseError           well-formed tokens, invalid document (§7.4)
    │   └── TsonUnsupportedDocumentError   e.g. a declared encoding other than UTF-8
    ├── TsonAtomTypeError            .typeRef, .expected
    │   ├── TsonAtomParseError       the token is not this atom's grammar
    │   └── TsonAtomValidationError  it parsed, then failed the atom's constraint
    ├── TsonReadError                .diagnostic — what readTree throws for everything
    ├── TsonWriteError
    ├── TsonBindMismatchError
    │   └── TsonMissingBindingError
    ├── TsonSchemaValidationError
    ├── TsonSchemaFetchError         .schemaId, .reason
    ├── TsonContentHashMismatchError .schemaId, .expected, .actual
    ├── TsonNotImplementedError      a library gap
    ├── TsonInternalError            a broken invariant — a bug here, not bad input
    └── TsonNameHygieneRefusedError  .mechanism, .names, .uts39Version
```

`SchemaFetchReason` is `'not-permitted' | 'not-found' | 'transport' | 'timeout' | 'too-large'`.
`'not-permitted'` means retrying cannot help.

`NameHygieneMechanism` is `'skeleton-distinctness' | 'identifier-status' | 'restriction-level'`.

The `Tson` prefix survives on errors — and only on errors — because a class name appears verbatim in
a stack trace and in `instanceof` checks across bundle boundaries, where a bare `ParseError` names
nothing. Every class restores its prototype chain, so `instanceof` holds when compiled down-level.

### Which error comes out of where

| Call                                               | Throws                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `parse`                                            | `TsonLexError`, `TsonParseError` — directly, unwrapped                                                   |
| `readTree`                                         | `TsonReadError` for everything, with the narrower error on `.cause`                                      |
| `readTree` under a refused name                    | `TsonNameHygieneRefusedError`                                                                            |
| `validate`                                         | nothing, for any document — a lex failure arrives as `VALIDATION_ERROR` with the root as a `missingNode` |
| `CompiledSchema.reader(name)`                      | `TsonInternalError` (no such entry) or `TsonNotImplementedError` (no reader yet)                         |
| `Tson.fetch`/`preload` with no source              | `TsonSchemaFetchError`, reason `'not-permitted'`                                                         |
| `Tson.resolveSchema` naming an unregistered import | `TsonSchemaValidationError`                                                                              |

`TsonNameHygieneRefusedError` extends `TsonError` **directly** — never `TsonLexError`,
`TsonParseError`, `TsonReadError` or `TsonAtomTypeError` — so a caller mapping errors onto §8.1's
four categories gets `false` from all four. That is structural, not conventional: a refused document
is never also reported as invalid. §8.2 requires a refusal to name the UTS #39 data version it was
computed against, because the underlying data is not frozen and two conforming processors can
legitimately disagree.

## CLI exit codes

| Code | Meaning                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | checked, and nothing to report                                                                                                                                    |
| `1`  | checked and rejected — includes a §8.2 name-hygiene refusal (`CONFUSABLE_NAMES`/`RESTRICTED_CHARACTER`/`RESTRICTED_SCRIPT`), since the sender still holds the fix |
| `2`  | usage error                                                                                                                                                       |
| `69` | a schema permanently unavailable — `SCHEMA_NOT_PERMITTED`/`SCHEMA_NOT_FOUND`/`SCHEMA_TOO_LARGE`; editing the reference or the allow-list is the fix               |
| `75` | a schema temporarily unavailable — `SCHEMA_UNREACHABLE`/`SCHEMA_TIMEOUT`; rerunning may succeed                                                                   |
| `78` | a type the schema needs has no registered binding — `BIND_MISMATCH`                                                                                               |
| `70` | a library gap or an internal fault — `NOT_IMPLEMENTED`, never a statement about the input                                                                         |

The `1` vs `70` split is the one a script depends on most: `1` is a verdict on the input, `70` says
no verdict was reached. `69`/`75`/`78` sit between the two for the same reason and narrower
causes — each means some diagnostic in the run was not a verdict (`isVerdict`), so nothing judged
the document. None of this is guessed at: each command separates "a per-file verdict" from "this
run could not reach one", and `exitCodeFor` ranks a run's collected diagnostics into whichever
non-`OK` code applies, by the ranking `70 > 78 > 69 > 75 > 1` — **who must act first**. A library
gap (`70`) blocks everyone; a missing binding (`78`) blocks whoever wires the application; an
unobtainable schema blocks the runner, permanent (`69`) ranking above temporary (`75`). A §8.2
refusal is exit `1` like any other rejection — it is a verdict, just not a validity one, and what
a caller does next (edit the document) is the same as for any other `1`.
