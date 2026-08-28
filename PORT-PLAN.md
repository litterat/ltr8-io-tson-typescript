# Scaffold `ltr8-io-tson-typescript` for a one-shot Java→TypeScript port

> **This is the plan as written before the port ran, kept as the record of what was actually
> followed.** [PORT-PLAN-REVISED.md](PORT-PLAN-REVISED.md) is what it should have said — written
> after the port shipped and after the defects these gates failed to catch were found — and is
> generalised for porting TSON to a language other than TypeScript. Start there.

## Context

`/Users/david/github/ltr8-io-tson-typescript` is an empty directory. It is to become the TypeScript
implementation of **TSON** (Typed Schema Object Notation), ported from the reference Java implementation
at `github.com/litterat/ltr8-io-tson-java` — 41,754 LOC main / 43,302 LOC test across 8 Gradle modules,
zero runtime dependencies, built against TSON spec 2026 Revision 33.

Two public sibling repos define the target:

- **Spec** — `spec/tson-part1-data.md` (data format) and `spec/tson-part2-schema.md` (type system +
  schema) in the Java repo, plus the three _live_ bundled schemas `spec/m/{meta-kernel,meta,core}.tn` and
  their `*-resolved.tn` resolver-output fixtures.
- **Conformance suite** — `github.com/litterat/ltr8-io-tson-test-suite`, 146 language-agnostic vectors
  under `tests/{lexer,parser,resolver,vocabulary}/{valid,invalid}/`. No manifest — discovery is by
  directory walk and naming convention; each `*.tn` subject pairs with a `<slug>-expected.tn` TSON
  sidecar that must be parsed with the implementation's own parser.

**This session produces the scaffold and the orchestration plan only.** The port runs later as a
`claude --cloud` job: an Opus manager running a committed workflow script per phase, all implementation
written by Sonnet sub-agents. The scaffold's job is to make that run possible — the frozen contract layer,
tooling, reference-fetch, conformance harness and phase gates must exist and be green first.

## Decisions taken

| Decision        | Choice                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packages        | npm workspace: `@ltr8/tson` (library, four subpath entries) + `@ltr8/tson-cli`. `@ltr8/tson` is unclaimed; bare `tson` is taken.                           |
| Runtime         | Node 24+ **and** modern browsers; dual ESM+CJS via `tsup`; **zero runtime dependencies**                                                                   |
| Fidelity        | **Idiomatic TypeScript rewrite** — same behaviour and conformance, restructured around discriminated unions and plain functions                            |
| Scope           | Everything except Java-only bits. `tson-annotation` (Java APT) is dropped; `tson-bind`'s 6.3k LOC of reflection collapses to ~1.2k of authored descriptors |
| Tooling         | Vitest, tsup, ESLint flat config + Prettier, `tsc --noEmit`                                                                                                |
| Atom host types | Own zero-dep immutable value types **plus** a feature-detected `Temporal` adapter (Node 24 has no global `Temporal`)                                       |
| Bundled `.tn`   | Copy the Java repo's `spec/m/*.tn` verbatim, digests and all, so the `*-resolved.tn` fixtures apply unchanged                                              |
| References      | Cloned at setup from the two public repos into a gitignored `.references/`, Java pinned to `fb93c89`                                                       |
| Public API      | Flat tree-shakable functions primary (`parse`, `readTree`, `validate`, `write`), plus `createTson(config)` as a config-bound convenience                   |
| Docs            | `CLAUDE.md` + `STATUS.md` only                                                                                                                             |
| Delivery        | Manager commits each green phase directly to `main`                                                                                                        |
| Gate            | `tsc --noEmit` + `eslint` + `vitest` + the conformance vectors that phase should newly turn green, plus manager diff review                                |

## Three architectural decisions that shape the scaffold

These are settled now because they cannot be retrofitted once parallel work starts.

**1. Suspension is in the contract, not bolted on later.** Streaming is non-negotiable (the Java lexer
reads from an `InputStream`; memory is proportional to nesting depth). Rather than write the grammar twice
for sync and async, the whole read stack is _suspendable-but-sync-shaped_: `type Task<T> =
Generator<typeof NEED_INPUT, T, void>`, every starving function is `function*`, every call to one is
`yield*`, and two ~10-line drivers (`runSync`, `runAsync`) sit at the top. The suspended state _is_ the
delegation chain — one generator frame per open container, which is exactly the bound the Java frame stack
gives. **Every generator-returning signature in `ReadContext`, `EventSource`, `TypeReader` and the lexer
must be declared `Task<…>` in the contract layer** — retrofitting suspension later means touching every
reader. `base/`, `atom/`, `resolver/` and `link/` run on already-lexed text and stay ordinary sync code.

**2. The binding layer is `DataClass` with reflection deleted.** Java's `tson-bind` is a descriptor
factory, not a serializer — the readers consume descriptors and never touch reflection. In TS the
descriptor is simply authored rather than derived: `Binding<T>` is a discriminated union with a phantom
output type driving `Infer<>`, `MethodHandle` becomes a closure, `Memoized` becomes `lazy()` closing the
one declaration-order cycle, and `@Profile` disappears entirely (a second shape is a second value).
Decorators + `reflect-metadata` are rejected — a runtime dependency that also degrades to `Object` for
every union, tuple and optional, i.e. every case TSON needs. Schema-to-TS codegen is kept as an _optional
dev-time generator that emits combinators_, never as the runtime mechanism, because schemas are fetched by
URL and hash-pinned at read time.

**3. The compiler→bind circularity is broken.** Java's `DefinitionResolver` holds a `TsonObjectWriter`
because §5.6's refinement merge must run on the wire record before binding — which is why the writers
can't leave `tson-compiler`. A TS `Binding` is bidirectional by construction, so `bind/encode.ts` exposes
`toCoreValue(binding, value)` depending only on `ast/` and `bind/`; the resolver merges on that and the
text round-trip disappears with the dependency.

## Part A — What this session creates

### A1. Workspace skeleton

```
ltr8-io-tson-typescript/
  package.json              private workspace root; scripts, devDeps, workspaces: ["packages/*"]
  tsconfig.base.json        strict, ES2023, moduleResolution "bundler", exactOptionalPropertyTypes,
                            noUncheckedIndexedAccess, verbatimModuleSyntax
  vitest.config.ts          projects: unit + conformance
  eslint.config.js          flat config, typescript-eslint strict-type-checked,
                            + import/no-restricted-paths zones (see A3)
  .prettierrc  .editorconfig  .gitignore  .nvmrc
  LICENSE                   Apache 2.0 (from the Java repo)
  README.md  CLAUDE.md  STATUS.md  ORCHESTRATION.md
  spec/                     vendored: tson-part1-data.md, tson-part2-schema.md,
                            m/{meta-kernel,meta,core}.tn + m/*-resolved.tn
  scripts/
    fetch-references.sh     shallow-clones the two public repos into .references/ (idempotent);
                            pins ltr8-io-tson-java to fb93c89 so the port target can't move
    gen-unicode-tables.mjs  emits src/unicode/xid.ts (see A4)
  .github/workflows/ci.yml  Node 24; fetch-references, typecheck, lint, test, conformance, build
  .claude/
    agents/tson-porter.md            the Sonnet sub-agent definition every work package uses
    workflows/port-wave-{0..6}.ts    the per-phase workflow scripts
  packages/
    tson/    @ltr8/tson    src/ test/ tsup.config.ts package.json
    cli/     @ltr8/tson-cli
  test/conformance/         vector runner (A5)
```

Single library package, not a 7-package monorepo: npm gives neither JPMS's enforced encapsulation nor a
reason to version 7 things in lockstep, and the property that actually matters — _don't ship the schema
compiler to a browser reading Class 1 data_ — comes from tree-shaking and subpath entries.

```jsonc
// packages/tson/package.json
"type": "module", "sideEffects": false,
"exports": {
  ".":        { "types": …, "import": …, "require": … },
  "./bind":   …,   // Binding, combinators, Infer — no compiler
  "./tree":   …,   // node types — no compiler
  "./regex":  …,   // I-Regexp engine — standalone, imports nothing outside itself
  "./schema": …    // schema.meta value model + registry
}
```

### A2. The frozen contract layer — the critical path

Written **in this session**, types and enums only, no implementations. This is what makes twelve agents
able to run in parallel afterwards with no cross-talk.

| File                       | Contents                                                                                                                                                                                                                                                        | ~LOC |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `src/core/position.ts`     | `Position { line; column; offset }` — 1-based line, **code-point** column, 0-based **UTF-8 byte** offset                                                                                                                                                        | 30   |
| `src/core/errors.ts`       | `TsonError` base + `TsonLexError`, `TsonParseError`, `TsonReadError`, `TsonWriteError`, `TsonBindMismatchError`, `TsonMissingBindingError`, `TsonUnsupportedDocumentError`, `TsonContentHashMismatchError`, `TsonSchemaValidationError`, `TsonSchemaFetchError` | 120  |
| `src/core/diagnostic.ts`   | `Diagnostic`, closed `DiagnosticCode` union, `SchemaLocation`, `DiagnosticsReceiver` (`throwing()` / `collector()`)                                                                                                                                             | 180  |
| `src/io/bytes.ts`          | `ByteInput { ensure(); read(); ended }`, `NEED_INPUT`, **`Task<T>`**, `runSync`/`runAsync` signatures                                                                                                                                                           | 60   |
| `src/lexer/token.ts`       | `TokenType` union (9 kinds + EOF), `Token`, adjacency helpers                                                                                                                                                                                                   | 90   |
| `src/ast/value.ts`         | `Document`, `DataValue`, `CoreValue` union, `RecordValue`, `MapValue`, `ArrayValue`, `ScopedValue`, `TokenValue`, `TokenForm`, `Annotation`, `AbsentValue`, `EmptyBrace`                                                                                        | 90   |
| `src/ast/schema/*.ts`      | Part 2 grammar AST: `SchemaDocument`, `Declaration`, `TypeDef`, the `TypeRef` union, `TypeArg`, `FieldDef`, `GroupDef`, `ConstructionDef`, `Instance`, `SizeSpec`, `RemovalSet`                                                                                 | 260  |
| `src/stream/event.ts`      | the 17-member `TsonEvent` union, `EventSource` (**`Task`-returning**)                                                                                                                                                                                           | 130  |
| `src/annotations/index.ts` | `Annotation`, `Annotations`, `Annotated<T>`, `AnnotatedMap<K,V>`                                                                                                                                                                                                | 200  |
| `src/bind/binding.ts`      | the `Binding<T>` union, `FieldSlot`, `LazyBinding`/`BindingRef`, `Infer<>`, `BindingRegistry`                                                                                                                                                                   | 220  |
| `src/schema/meta/*.ts`     | the ~54 resolved-schema value types (`TypeDefinition`, `Top`, `Data`, `Reference`, the bodies, one constraint interface per built-in atom)                                                                                                                      | 700  |
| `src/tree/nodes.ts`        | `Value` union + `RecordNode`/`MapNode`/`ArrayNode`/`TupleNode`/`AtomNode`/`AbsentNode`/`MissingNode`                                                                                                                                                            | 120  |
| `src/reader/contracts.ts`  | `TypeReader<T>` (**`read(ctx): Task<T>`**), `ReadContext`, `ValueReaderFactory` + registries                                                                                                                                                                    | 140  |
| `src/atom/contract.ts`     | `AtomType<T>`, atom error shapes                                                                                                                                                                                                                                | 60   |
| `src/value/types.ts`       | host atom value **interfaces**: `TsonDecimal`, `Rational`, `Complex`, `PlainDate`/`PlainTime`/`PlainDateTime`, `TsonDuration`, `Ipv4Address`/`Ipv6Address`/`Cidr`, `Uuid`, `MacAddress`                                                                         | 150  |

**≈ 2,550 LOC of declarations.** Two rules stated in `CLAUDE.md` for whoever touches it: every
generator-returning signature is `Task<…>` from the start; `schema/meta` types are transcribed from the
Java records literally, including `Optional<T>` → `T | undefined` and the "absent and empty list are the
same" normalisations.

### A3. Naming, and the JPMS replacement

The Java `Tson`-prefix-never-infix rule survives with a narrowed trigger — module namespacing gives the
disambiguation for free at the import site:

- **Drop the prefix** on types and functions: `Schema`, `Config`, `ObjectReader`, `TreeReader`,
  `CompiledSchema`, `SchemaRegistry`, `DataParser`.
- **Keep it on error classes** (`TsonParseError`, …): error names appear verbatim in stack traces and in
  `instanceof` checks across bundle boundaries, where a bare `ParseError` names nothing.
- **One forced divergence to document, not an oversight:** the tree nodes take a `Node` suffix.
  `Record` is a TS global utility type and `Map`/`Array` are globals — importing those names shadows them
  for the whole file. The Java repo dropped the `Node` suffix deliberately (anti-Jackson); TS forces it
  back.

JPMS is replaced by an ESLint `import/no-restricted-paths` zone list, in from day one or the layering
rots — notably `{ target: './src/bind', from: './src/compiler' }`, which is the §3 circularity guard.

### A4. Unicode tables

`scripts/gen-unicode-tables.mjs` walks 0…0x10FFFF, tests `\p{XID_Start}`, `\p{XID_Continue}`, `\p{Nd}`,
coalesces to ranges, delta-varint encodes and base64-wraps into a checked-in `src/unicode/xid.ts` that
also records `process.versions.unicode`. Measured: 684 + 800 + 71 ranges, **3.3 KB raw → ~4.4 KB source →
~2 KB gzipped**, 94 ms to generate. Checked in rather than computed at import, and used instead of the
host regex at runtime so two runtimes cannot disagree about whether a document is valid — which matters
for a format whose identity can be a hash of its bytes.

NFC uses `String.prototype.normalize` (ECMA-262, present in small-icu Node and every browser) behind a
guard: a token whose maximum code point is `< 0x0300` cannot contain a combining mark and is NFC by
construction, so the allocating call stays off the path every ASCII identifier takes.

This makes the TS port _stricter than Java_, which uses `Character.isUnicodeIdentifierStart/Part` as a
documented approximation of XID. The two will disagree on a small set of code points (notably `$`). That
is a finding to file back to the Java repo and worth a new vector in the shared suite.

### A5. Conformance harness

`test/conformance/`, written now, expected to fail until the lexer lands:

- `vectors.ts` — walks `.references/ltr8-io-tson-test-suite/tests/<layer>/<bucket>/`, pairs subjects with
  sidecars, returns a typed `Vector[]`.
- `sidecar.ts` — parses sidecars with **our own** parser (dogfooding, as the Java runner does).
- `runner.test.ts` — four `describe.each` blocks. Feeds **raw bytes**, never a re-encoded string.
  `encoding: invalid-utf8` handled; `utf-16`/`utf-32` **skipped**, not failed. On `outcome: error` asserts
  only the `category`, never the position.
- `bundled-ids.ts` — the single hard-coded three-entry short-name table and the `!!meta`/`!!import` splice.
- The project skips with a clear message when `.references/` is absent (the Java `Assumptions` behaviour).

### A6. `CLAUDE.md`

Adapted from the Java conventions: zero runtime dependencies; Node 24+; streaming non-negotiable; **the
number grammar is hand-written one function per ABNF rule and must not be a host regex** (the Java
`NumberScanner` javadoc states this for the benefit of ports); the lexer decodes UTF-8 itself and is
code-point addressed — never index a JS string by UTF-16 unit; TSDoc states current contract only, no
change history; `STATUS.md` is the only checklist and git history is the log; plus the three traps
inherited from the Java repo's own list (identity-keyed desugar map → `WeakMap` + `toBe`; the
atom-refinement merge on the wire record; `requireDocumentEnd`, where a lazy generator stream that merely
_stops_ silently accepts trailing content).

## Part B — `ORCHESTRATION.md`: the cloud one-shot

Each wave is one committed workflow script. The Opus manager runs a wave, reads the structured result,
runs the gate, reviews the diff, commits to `main`, then decides the next. Every sub-agent is Sonnet via
`agentType: 'tson-porter'`, given: the spec sections it implements, the Java source paths it ports, the
contract-layer types it may assume, and the vectors it must turn green. Sub-agents share no context —
the frozen contract is the only interface. LOC are TS estimates.

**Wave 0 — contract review.** Manager verifies A2 typechecks and `.references/` + `spec/` are present.
Gate: `tsc --noEmit` clean.

**Wave 1 — twelve agents in parallel** (~9,000 LOC, no cross-talk):

| WP              | Ports                                                        | Produces                                                                                                                                                                                                                                                                                                                                                                                         | ~LOC |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 1 unicode       | `Lexer` predicates                                           | `unicode/xid.ts` (gen), `nfc.ts`, `whitespace.ts`                                                                                                                                                                                                                                                                                                                                                | 350  |
| 2 byte input    | `Lexer.nextByte/fillBytes`                                   | `io/{bytes,utf8,drivers,streams}.ts`                                                                                                                                                                                                                                                                                                                                                             | 350  |
| 3 lexer         | `lexer/Lexer.java` (900)                                     | `lexer/lexer.ts` — decodes UTF-8 itself; **byte offset counted, not derived** (a length re-derived from the decoded value is only right while input is well-formed); BOM dropped without counting; rejects bad lead/continuation/truncated/overlong/surrogate/>U+10FFFF, never U+FFFD                                                                                                            | 1000 |
| 4 numbers       | `base/*` (787)                                               | `base/{numberScanner,numberGrammar,baseTypeResolver,numberNarrowing}.ts` — one function per ABNF rule, **no RegExp**                                                                                                                                                                                                                                                                             | 800  |
| 5 event stream  | `TsonDataStream` (812)                                       | `stream/dataStream.ts` — frame stack, ≤2 token lookahead                                                                                                                                                                                                                                                                                                                                         | 850  |
| 8a–d atoms      | `atom/` (2400, 33 parsers)                                   | `atom/{numeric,temporal,network,text}/` — four agents. **Each reads the Java `CONFORMANCE.md` first**: `!uuid` needs RFC 9562 8-4-4-4-12; base64 needs padding; date/time reject ISO extended years; duration needs uppercase designators, no sign; `!ipv4`/`!ipv6` parse RFC 3986/4291 themselves — the JDK leniency there is an SSRF-bypass class, and JS has no host parser to lean on at all | 2650 |
| 9 regex         | `tson-regex` (1447)                                          | `regex/` — I-Regexp parser, Thompson NFA / Pike VM (linear, ReDoS-safe), product-NFA disjointness. Imports nothing outside itself                                                                                                                                                                                                                                                                | 1400 |
| 10 tree         | `tson-tree` (628)                                            | `tree/{nodes,accessors}.ts` — RFC 6901 pointers, `MissingNode` carrying the failed pointer                                                                                                                                                                                                                                                                                                       | 600  |
| 11 bind runtime | `tson-bind` model + `tson-annotation` (2000 of 6313 survive) | `bind/{combinators,infer,registry,encode,strictness}.ts`                                                                                                                                                                                                                                                                                                                                         | 1200 |

**Wave 2** — 6 data parser (350), 7 schema grammar parser (900), 12 `schema.meta` bindings (900),
13 desugarer (1250), 21 conformance harness (400).
Gate: **all 146 vectors green** (this is the Part 1 completion gate).

**Wave 3** — 14a definition resolver (1900) → 14b template materialisation (1000) ∥ 14c schema resolver +
flattening + meta-kernel bootstrap (900).
Gate: meta-kernel resolves 49 declarations, meta 31, core 48, matching `spec/m/*-resolved.tn`.

**Wave 4** — 15 linking, registry, canonical identity, content hashing (2200; sha256 via `crypto.subtle`,
present in Node 24 and browsers) ∥ 16a abstract readers + read context (1500) → 16b tree readers (900) ∥
16c bind readers (1200) ∥ 16d schemaless + type-ref checks (1400).

**Wave 5** — 17 compiler (1400) ∥ 18 emit and writers (1300).
Gate: a user schema importing `core.tn` compiles and validates real data three schemas deep.

**Wave 6** — 19 facades and front door (2000; HTTPS source **deny-by-default host allow-list, no redirects
ever, size cap**; file source containment checked after realpath) → 20 CLI (1200; `validate`/`compile`/
`hash`/`init-example`, `text|json|tson`, exit codes **0 valid / 1 invalid data / 2 usage / 70 library
fault**).

**Wave 7 — sweep.** Full conformance run, `*-resolved.tn` fixture test, browser-bundle smoke test,
`README.md`, `STATUS.md`, allocation harness, `publint` + `arethetypeswrong`, CI green.

**Total ≈ 32,000 LOC** against 41.7k Java — the delta being `DefaultRecordBinder`'s 1158 LOC of
reflection, the three component finders' 820, `mapper/`'s 814 (a JS array _is_ the array form), the
`Memoized`/in-flight machinery, and Java records' boilerplate.

## Verification

After the scaffold lands:

```bash
./scripts/fetch-references.sh
npm install
npm run gen:unicode                    # regenerates src/unicode/xid.ts; must be a no-op diff
npm run typecheck                      # MUST be clean
npm run lint                           # MUST be clean, zone rules active
npm test                               # contract-layer type tests pass
npm run test:conformance               # runs, discovers 146 vectors, reports 146 failing
npm run build                          # tsup ESM+CJS+dts, both packages — MUST succeed
```

**146 discovered / 146 failing is the correct scaffold outcome** — it proves the harness pairs every
vector before any implementation exists. _0 discovered_ means `.references/` or the walker is wrong and
must be fixed before Wave 1. A `gen:unicode` diff means the checked-in table and the host Unicode version
disagree — resolve before Wave 1, since WP-1 and WP-3 both depend on it.

Then confirm the orchestration parses without running it:

```bash
npx tsx --check .claude/workflows/port-wave-1.ts
```

End-to-end proof happens at each cloud wave gate, not here.

## Part C — Commit and kick off the cloud run

A cloud session runs against a GitHub repo, so the scaffold has to exist on GitHub before `--cloud` can
attach to it. Three steps, in this order:

**1. Initialise and commit the scaffold** (the directory is not currently a git repo):

```bash
cd /Users/david/github/ltr8-io-tson-typescript
git init -b main
git add -A
git commit -m "Scaffold the TypeScript port: contracts, tooling, conformance harness, orchestration"
```

The commit includes `ORCHESTRATION.md` and `.claude/workflows/port-wave-*.ts`, so the cloud session gets
the whole plan from the checkout rather than from a prompt.

**2. Create the GitHub repo and push:**

```bash
gh repo create litterat/ltr8-io-tson-typescript --public --source=. --remote=origin --push
```

**3. Launch the cloud run:**

```bash
cd /Users/david/github/ltr8-io-tson-typescript
claude --cloud "TSON TypeScript port" --model opus --effort high \
  "You are the manager for the one-shot Java to TypeScript port of TSON. \
Read ORCHESTRATION.md and CLAUDE.md first, then run ./scripts/fetch-references.sh. \
Execute the waves in order using the workflow scripts in .claude/workflows/, one wave per \
Workflow call, with all implementation done by Sonnet sub-agents of type tson-porter. \
After each wave: run the gate (npm run typecheck && npm run lint && npm test && \
npm run test:conformance), review the diff, and commit to main only when the gate is green. \
Do not start a wave until the previous wave's gate passes. If a gate cannot be made green after \
two repair attempts, stop and report rather than proceeding."
```

`--model opus` sets the manager; the sub-agents run Sonnet because `.claude/agents/tson-porter.md`
declares `model: sonnet` in its frontmatter. `claude agents` lists the running session; `--cloud <url>`
re-attaches to it later.
