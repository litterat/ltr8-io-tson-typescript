# CLAUDE.md

Orientation for Claude Code sessions in this repo. It describes the code **as it stands** — current
form, present tense. How it got here lives in git history, not here.

## Project

A TypeScript implementation of TSON (Typed Schema Object Notation), ported from the reference Java
implementation at https://github.com/litterat/ltr8-io-tson-java, built against the TSON spec series
(2026 revision):

- Part 1 — lexer, structural grammar, base type resolution, built-in type vocabulary:
  https://tson.io/raw/2026/34/tson-part1-data.md
- Part 2 — schema grammar, type system, resolution, linking, compilation:
  https://tson.io/raw/2026/34/tson-part2-schema.md

The spec is a _working revision_ that changes between revisions without compatibility guarantees.
When in doubt, **re-fetch the current URL** and check the revision number at the top rather than
trusting a cached copy.

`scripts/fetch-references.sh` populates the gitignored `.references/` with the two repositories this
port is written against:

- `.references/ltr8-io-tson-java` — the reference implementation, **pinned** to a fixed commit so the
  port target cannot move underneath the work. Its `spec/` holds the spec snapshots and the three
  live bundled schemas `spec/m/{meta-kernel,meta,core}.tn` plus their `*-resolved.tn` resolver-output
  fixtures.
- `.references/ltr8-io-tson-test-suite` — the shared, language-agnostic conformance corpus, 179
  vectors. Tracks `main` so new vectors are picked up.

Both are required before the conformance project will run. A SessionStart hook fetches them
automatically in cloud sessions; run the script yourself locally.

`spec/` holds the same spec snapshots and bundled schemas, **vendored verbatim** from that pinned
commit and committed here. `.references/` is gitignored and absent from a bare clone, but the three
bundled schemas are loaded at runtime and every `§` citation in the source refers to the spec text,
so both have to be readable without network access. They are copies: do not edit them, and move the
pin and re-copy together. `spec/PROVENANCE.md` records where they came from and
`vendored-spec.test.ts` fails if they drift.

## Hard constraints

- **Zero runtime dependencies** in `@ltr8/tson`. Dev dependencies are fine; a runtime one is not.
- **Node 24+ and modern browsers.** No `DOM` lib in the type configuration, no Node built-ins in code
  that must run in a browser. Platform-specific pieces go behind conditional exports.
- **Streaming is non-negotiable.** Memory is proportional to nesting depth. Nothing materialises a
  whole document to read part of it.
- **The number grammar is hand-written, one function per ABNF rule, and must not be a host regex.**
  The reference implementation states this explicitly for the benefit of ports: a grammar expressed
  as a regex is expressed in a dialect no other language shares. No `RegExp` in `src/base/`.
- **The lexer decodes UTF-8 itself and is code-point addressed.** Never index a JS string by UTF-16
  unit to derive a column or an offset. Malformed UTF-8 is an error, never U+FFFD.

## Suspension: `Task<T>`

The whole read stack — lexer, event stream, parser, readers — is written in
_suspendable-but-sync-shaped_ style. Any function that can starve for input is `function*` returning
`Task<T>` (`src/io/bytes.ts`), and every call to one is `yield*`. Two drivers sit at the top:
`runSync` for complete input, `runAsync` for chunked input.

This exists so the grammar is written **once**. Do not add a second, async-only copy of any parsing
code. Do not "simplify" a `Task`-returning signature to a plain return type — that breaks every
caller above it, and the suspension cannot be reintroduced locally.

Suspension stops at two boundaries. Below the token, `src/base/` and `src/atom/` run on already-lexed
text and are ordinary sync functions. Above `TypeReader`, the facades drive with `runSync`/`runAsync`.

## Layering

There is one published library package with subpath entries rather than a package per Java module.
JPMS is replaced by ESLint `import/no-restricted-paths` zones in `eslint.config.js`. If a zone rule
fires, the fix is the import, not the rule. Two zones carry real design weight:

- `src/schema/meta` may import only itself, `src/core` and `src/annotations`. It names no compiler
  type — that is what lets the schema model ship to a browser that never compiles a schema, and why
  it carries local stand-ins (`schema.meta` has its own `Token` mirroring `ast.TokenValue`, and its
  own `SourcePosition` that the compiler's `Position` satisfies).
- `src/bind` must not be imported from `src/compiler`. In the Java, the definition resolver holds an
  object writer because a chained atom refinement must merge on the wire record before binding, and
  that dependency is why the writers cannot leave the compiler module. Here a `Binding` is
  bidirectional by construction, so `src/bind/encode.ts` exposes `toCoreValue(binding, value)`
  depending only on `ast/` and `bind/`, the resolver merges on that, and the text round-trip is gone.
  Keep it that way.

## Conventions

**TSDoc documents current contract only, no change history.** Never dates, "renamed from X", "ported
from Y", "used to do Z". If a design needs a WHY, state the current invariant and its rationale
directly. When you edit an exported type, clean up its TSDoc in the same edit.

**Cite the spec section.** `§2.5`, `§7.2.2`. Where this implementation makes a choice the spec leaves
open, say so and say why.

**The `Tson` prefix is for errors.** Module namespacing gives the disambiguation the Java prefix
bought, so types and functions are bare: `Schema`, `Config`, `ObjectReader`, `CompiledSchema`,
`DataParser`. Errors keep it — `TsonParseError`, `TsonLexError` — because an error name appears
verbatim in a stack trace and in `instanceof` checks across bundle boundaries, where a bare
`ParseError` names nothing.

**Tree nodes take a `Node` suffix** — `RecordNode`, `MapNode`, `ArrayNode`. The Java drops the suffix
deliberately; TypeScript forces it back, because `Record` is a global utility type and `Map`/`Array`
are globals, and importing those names shadows them for the whole file. This is a divergence, not an
oversight.

**Optionality is `readonly x?: T`**, never `readonly x: T | undefined`. `exactOptionalPropertyTypes`
is on and the distinction is meaningful. The same rule is why a JSON Pointer at a document root is
`undefined` rather than `''` — `''` is itself a valid RFC 6901 pointer meaning exactly that.

**`STATUS.md` is the only checklist.** Git history is the log.

## Spec feedback

This port is the spec's second implementation, and the first in a language without the JDK's value
types. Where the prose resolves ambiguously, or where TypeScript forces a different reading, say so
in conversation rather than silently picking.

- Identifier characters use real `XID_Start`/`XID_Continue` tables. The reference now does too, so
  the two agree; before Revision 34 it approximated them with `Character.isUnicodeIdentifier*`,
  which admits every _identifier-ignorable_ character and so accepted U+00AD, U+2060, U+FEFF and
  the non-whitespace ISO controls inside an unquoted token. Note that ZWNJ and ZWJ are _not_ in
  that list any more: §7.1 admits both into the token profile, because they are `XID_Continue`, and
  what makes that safe is the identifier grammar's contextual rule at naming positions (§7.7 rule
  2), not a subtraction from the profile.

  **The tables are checked in and authoritative; the host is not consulted for these
  properties.** NFC is the one exception, and a deliberate one: `unicode/nfc.ts` calls
  `String.prototype.normalize`, which is ECMA-262 rather than `Intl` and so needs no data of its
  own to ship. That is safe where shipping a table would not be, because Unicode's own
  normalization stability policy freezes it: a character's canonical decomposition never changes
  once encoded, and no new canonically-decomposable characters are added — so for every character
  the checked-in `XID` tables admit, every host answers the NFC question identically.
  The tables themselves are
  generated by `scripts/gen-unicode-tables.mjs` into `src/unicode/xid.ts` (identifiers) and
  `src/regex/categories.ts` (general categories, for I-Regexp), and both record the
  `UNICODE_VERSION` they were derived from. This matters more than it looks: pinning a Node major
  does **not** pin the character data. GitHub's Node 24 runners carry Unicode 17.0 while other
  Node 24 builds carry 16.0, which changes `XID_Start` from 684 ranges to 691 — i.e. it changes
  which documents are well-formed. `npm run check:unicode` therefore verifies the tables only when
  the host's version matches theirs, and reports rather than fails when it does not. Regenerating
  on a host with a different Unicode version is a **behavioural change** and belongs in its own
  commit.

- Every built-in atom is parsed here from scratch, since JS has no host `UUID`, `InetAddress`,
  `LocalDate` or `BigDecimal` to delegate to. `.references/ltr8-io-tson-java/CONFORMANCE.md` records
  where the Java is deliberately stricter than the JDK; read it before writing any atom parser, since
  those checks are the behaviour, not the JDK's.

- Resolved-output writing cannot name the applied constructor. §8.1 says a closed definition's
  body is "a binding record headed by the applied constructor", and `spec/m/*-resolved.tn` writes
  `enum_set`'s body as `!set { element_type: identifier  min_items: 1 }`. Both this port and the reference write
  `!array { … unordered: true unique_items: true }`: `set` is a refinement of `array` sharing its
  shape, so the applied name is not recoverable from the value being written, though it is recorded
  one level up in the same entry's `source`. The reference's own fixture test cannot see this — it
  binds the fixture into the value model and compares `TypeDefinition` objects, where both forms
  arrive as one `ArrayBody`. This port compares written form and does see it. Worth reporting
  upstream as a §8.1 conformance gap in both implementations, or as a modelling gap in the resolved
  value model, depending on which side the spec means to fix.

- **Name hygiene is policy, not validity** (§8.2, and §11.4 for the schema-layer scopes). The three
  UTS #39 mechanisms — skeleton distinctness, `Identifier_Status`, restriction level — are
  implemented and enforced by default, and a refusal is a **fifth outcome**, reported apart from
  §8.1's four error categories and naming the UTS #39 data version. That separation is the whole
  design: `confusables.txt`, `IdentifierStatus.txt` and the script-based restriction levels are
  data Unicode declines to freeze, so a verdict over them can change under a routine UCD refresh,
  and a content-addressed document (§2.2.1) must mean the same thing forever. Nothing here may
  decide whether a document is valid. Relaxation is a code decision the caller makes explicitly —
  never an environment variable, because a security policy read from the environment is ambient
  authority, invisible at the call site.

## Build and test

```bash
./scripts/fetch-references.sh   # populate .references/ (required for conformance)
npm install
npm run typecheck               # tsc --build
npm run lint
npm test                        # unit
npm run test:conformance        # the 179 shared vectors
npm run build                   # tsup, ESM + CJS + dts
```

The conformance project skips with a message when `.references/` is absent, rather than failing.

## Conformance suite

**`RUNNER.md` in the corpus is normative for runners.** It exists because the contract used to live
only in README prose and two runners written against that prose already disagreed. Read it before
touching `test/conformance/`; what follows is orientation, not the contract.

Discovery is by directory walk and naming convention — there is no manifest. Each `*.tn` under
`tests/<class>/<layer>/<bucket>/` that does not end `-expected.tn` is a subject; its sibling
`<slug>-expected.tn` is a TSON sidecar describing the expected outcome. `<class>` is the spec's own
conformance class, so a Class 1 processor runs `class1/` and skips `class2/` — that is what the
directory is for.

The sidecar states its outcome as a **field group** (Part 2 §5.11): the record carries exactly one
of `valid`, `error` or `schema-document` as a member, and that member's _name_ is the outcome.
There is no `outcome:` field. The same treatment replaced the flat `kind:`/`shape:` discriminators
inside the parser, resolver and vocabulary payloads.

Six rules the runner must keep:

- **Parse sidecars with our own parser.** The suite expects an implementation to dogfood.
- **Feed subjects raw bytes**, never a string that has been decoded and re-encoded. Eight vectors
  carry deliberately malformed UTF-8; a `TextDecoder` round trip destroys exactly what they test.
- **Assert the `category` on every error vector, at every layer** — and never the position. The
  category is not derivable from the layer: the vocabulary layer raises `resolver` and `validation`
  errors and never a "vocabulary" one.
- **At the reader layer, parse the subject cleanly first**, then assert the read reports. A reader
  vector exists because no tier below the reader can fail on it, so one that had accidentally
  become a parse error would otherwise pass for the wrong reason.
- **Report every skip, and skip only for the three legitimate grounds** — an encoding we do not
  read (`utf-16`, `utf-32`; `invalid-utf8` is not one, it must reach the lexer), a `class2/` vector
  under a Class 1 processor, and anything under `proposed/`. Anything else is a failure.
- **Normalise a synthetic entry's trailing `_[0-9a-f]{8}` before comparing** (Class 2). §8.2 keys
  identity on structure, so the spelling is not normative and comparing it tests our own hash.
