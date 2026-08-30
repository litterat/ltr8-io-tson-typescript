# Diagnostics, errors, exit codes

## `DiagnosticCode`

A **closed union** — a new code is an API change, not a new string appearing in a message. Switch on
it exhaustively; never match on `message` text.

| Code                        | Means                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `FIELD_REQUIRED`            | a required field was absent from the data                                                                                               |
| `FIELD_FIXED`               | a field the schema fixes carried a different value                                                                                      |
| `TYPE_MISMATCH`             | the value's shape does not match the type in scope                                                                                      |
| `WRONG_ARITY`               | a tuple or template application has the wrong element/argument count                                                                    |
| `UNKNOWN_TYPE_REF`          | a `!type` annotation names a type the schema in scope does not declare                                                                  |
| `ATOM_CONSTRAINT_VIOLATION` | a built-in atom's declared constraint was violated                                                                                      |
| `UNRECOGNIZED_FIELD`        | the data carried a field the type does not declare (§7.2 — records are closed, always)                                                  |
| `DUPLICATE_MAP_KEY`         | two entries of one map share a key (§2.6)                                                                                               |
| `ABSENT_MAP_KEY`            | a map entry's key is the absent sentinel (§2.9)                                                                                         |
| `DUPLICATE_FIELD`           | two fields of one record share a name (§2.5)                                                                                            |
| `SCHEMA_ERROR`              | the governing schema itself is invalid or failed to resolve — it _was_ obtained                                                         |
| `UNKNOWN_TYPE`              | a type reference does not resolve within the linked schema                                                                              |
| `VALIDATION_ERROR`          | anything not covered by a more specific code — including a document that will not lex or parse, when reported through a collecting read |
| `NOT_IMPLEMENTED`           | **a library gap, not bad input.** Surfaces at read time because compiled readers are built lazily                                       |
| `BIND_MISMATCH`             | a schema type and its registered binding disagree about the type's fields                                                               |
| `SCHEMA_UNAVAILABLE`        | a reference no configured source would supply — **not** a verdict on the schema, which was never obtained                               |
| `NAME_HYGIENE_REFUSED`      | §8.2's fifth outcome, on a **collecting** read only (a fail-fast read throws `TsonNameHygieneRefusedError` instead)                     |

`SCHEMA_ERROR` vs `SCHEMA_UNAVAILABLE` is the distinction that matters for a caller deciding whether
to retry: the first says the schema is wrong, the second says nothing was checked.

## The `Diagnostic` record

```ts
interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly path?: string; // RFC 6901 into the DATA; undefined (not '') at the root
  readonly schemaId?: string; // canonical id of the schema in scope
  readonly schemaPointer?: string; // RFC 6901 into that SCHEMA
  readonly expected?: string;
  readonly actual?: string;
  readonly dataPosition?: Position; // { line, column, offset }
  readonly schemaPosition?: Position;
}
```

The shape follows JSON Schema 2020-12 §12's output unit — where in the data, where in the schema,
what was wrong — so one record renders both data-side and schema-side problems.

`undefined` rather than `''` at a root is deliberate: `''` is itself a valid RFC 6901 pointer
meaning exactly "the root".

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

| Code | Meaning                                                                            |
| ---- | ---------------------------------------------------------------------------------- |
| `0`  | valid                                                                              |
| `1`  | at least one file invalid                                                          |
| `2`  | usage error                                                                        |
| `69` | a `--schema` reference no configured source would supply — **nothing was checked** |
| `70` | library gap or internal fault                                                      |

The `1` vs `70` split is the one a script depends on most: `1` is a verdict on the input, `70` says
no verdict was reached. It is never guessed — each command separates the two, and `exitCodeFor`
ranks collected diagnostics into whichever non-zero code applies.
