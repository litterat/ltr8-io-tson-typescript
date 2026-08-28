# Status

← back to the [README](README.md)

Built against TSON Part 1 (lexer + data format), a working draft:
https://tson.io/raw/2026/33/tson-part1-data.md, and Part 2 (schema grammar + type system), also a
working draft: https://tson.io/raw/2026/33/tson-part2-schema.md

A TypeScript port of the reference Java implementation. Conformance is measured against the shared
suite at https://github.com/litterat/ltr8-io-tson-test-suite — 146 vectors.

**Conformance: 146 / 146 vectors passing.**

18 lexer, 25 parser, 14 resolver, 89 vocabulary. Sidecars are parsed with this implementation's
own parser, as the shared suite expects. Subjects are fed as raw bytes — verified directly for the
eight vectors carrying deliberately malformed UTF-8, which reach the lexer unmodified and are
rejected by it rather than by a decoder. No vector in the current suite declares `utf-16` or
`utf-32`, so nothing is skipped.

## Part 1 — data format (Class 1)

- [x] Lexer — UTF-8 decoding, code-point addressing, NFC checking, malformed-sequence rejection
- [x] Unicode tables — `XID_Start`/`XID_Continue`/`Nd`, `Pattern_White_Space`
- [x] Event stream — the Tier 2 pull source
- [x] Data parser — the Tier 3 AST
- [x] Base types — null, boolean, string, numbers (integer, float, hex-float, based-integer)
- [x] Number grammar — hand-written, one function per ABNF rule
- [x] Integer types — `int8`–`int256`, `uint8`–`uint256`, `positive_integer` and siblings
- [x] Decimal/float types — `number`, `float32`, `float64`, `rational`, `complex`
- [x] Identifier/network types — `uuid`, `uri`, `email`, `ipv4`, `ipv6`, `cidr4`, `cidr6`, `mac`
- [x] Binary types — `base64`, `base64url`, `base32`, `hex`
- [x] Temporal types — `date`, `time`, `datetime`, `duration`
- [x] Tree model — `Value` nodes, RFC 6901 pointers
- [x] Writers — streaming emit, optional `!!id`/`!!schema` header
- [ ] Document header classification (§7.1)

## Part 2 — type system and schema (Class 2)

- [x] Schema grammar — schema documents parsed into a faithful AST
- [x] Desugaring — every sugar form lifted to a closed synthetic entry
- [x] Resolution — composition, refinement, constructor application, templates
- [x] Linking — reference validation, transitive `!!import` merge (diamonds unified), `subtypes`
      reverse-index population, choice disjointness and `@disjoint` assertion checking
- [x] Identity and hashing — canonical `!!id` (`link/identity.ts`), `?sha256=` pinning and content
      hashing via `crypto.subtle` (`link/contentHash.ts`, async — the one async surface in `link/`)
- [x] Bundled schemas — `meta-kernel.tn`, `meta.tn`, `core.tn` resolving end to end
- [x] Compilation — a compiled, schema-validating reader
- [x] Diagnostics — the data- and schema-side problem model

## Beyond the reference implementation's shape

- [x] I-Regexp engine (RFC 9485) — linear-time, ReDoS-safe
- [x] Binding layer — authored descriptors with inferred static types
- [x] Front door — `parse`, `readTree`, `validate`, `write` (flat, tree-shakable), `createTson`
      as a config-bound registry over them (`src/facade/`, `src/config.ts`)
- [x] Identity and content hashing, publicly — `@ltr8/tson/identity`: §2.2.1's `sha256Hex`,
      `contentStart`, `declaredSha256`, `verifyContentHash` and `withSha256Pin` (pinning, the
      inverse of `declaredSha256`) beside `canonicalizeIdentity`/`sameIdentity`/`validateIdentity`.
      Its own subpath rather than part of the default entry: nothing in it reaches the compiler,
      the lexer or the event stream, so a consumer who wants only a document's content hash takes
      only that. The CLI's `hash` command consumes it rather than reimplementing §2.2.1, which is
      what it did before this existed
- [x] Schema sources — `@ltr8/tson/source`'s `httpSchemaSource` (deny-by-default host allow-list,
      no redirects ever, size cap enforced while streaming, timeout) and `fileSchemaSource`
      (containment checked after `realpath`); both Node-only, reachable only through that
      separate subpath (`src/source/`, its own `types: ["node"]` project) and never from the
      package's default entry
- [x] CLI (`@ltr8/tson-cli`) — `validate`, `compile`, `hash`, `init-example`; `text`/`json`/`tson`
      output (the `tson` format via `write()`, never string concatenation); exit codes `0` valid,
      `1` invalid input, `2` usage error, `70` library gap or fault. Bootstraps its own copy of
      meta-kernel/meta.tn/core.tn, embedded at build time from `spec/m/` via a generator script
      under `scripts/`, so `validate --schema`/`compile` work offline with no `SchemaSource`
      configured. `hash` is read-only: it prints the pinned reference rather than rewriting the
      input file in place. Verified end to end: `init-example`, `validate --schema --root`,
      `compile`, and `hash` all run against a real generated example and exit `0`
- [x] Dual ESM/CJS publish — `npm run build` (tsup) produces `dist/*.{js,cjs,d.ts,d.cts}` for every
      subpath of both packages
- [ ] Browser bundle — no bundler-driven smoke test yet; verified only indirectly (no `node:`
      import outside `src/source/`, no `DOM` lib in any `tsconfig`)

## Known gaps

- **The read stack costs a host call frame per nesting level, and is bounded rather than
  iterative.** §9.1 asks an implementation to bound nesting, and `MAX_NESTING_DEPTH` (512) does —
  `parse` raises a `TsonParseError` with a position, `readTree`/`validate` a `TsonReadError`.
  Before the bound the limit was the host's own call stack, reached around depth 750 and reported
  as an uncaught `RangeError` out of the public API. The Tier 2 event stream has no such limit
  (its explicit frame stack walks a million levels); making Tier 3 and the tree readers iterative
  too is the proper fix, and the bound is what keeps the failure honest until then. The limit is
  a constant, where §9.1 asks for a configurable one.

- **`node10` type resolution fails for every subpath**, that resolver predating `exports`. The
  package targets Node 24+, so this is a deliberate floor rather than a defect, but a consumer on
  `moduleResolution: "node"` will not see the subpaths. It is the last of Wave 6's adversarial
  findings left open — the two high, three medium and three of the four low ones are fixed:
  an unrecognised CLI flag is now a usage error (exit 2) naming the option rather than a filename
  the tool then fails to open, with `--` as the escape hatch for a file genuinely named like one;
  `tsup`'s `removeNodeProtocol` is off in both packages, so `node:fs` stays written as `node:fs`;
  and `fileSchemaSource`'s containment predicate no longer degenerates for a directory that
  realpaths to `/` (`root + sep` was `//`, which nothing matches, so it failed closed and refused
  every file under it).

- **`createTson` bundles no standard library.** Unlike the reference implementation's
  `Tson.builder().build()`, which loads `meta-kernel`/`meta.tn`/`core.tn` from packaged classpath
  resources, this port embeds nothing: `spec/m/*.tn`'s vendored bytes are not compiled into
  `@ltr8/tson`, so a fresh `Tson` starts with an empty registry and a caller registers the
  standard library themselves (`config.ts`'s own top-of-file example shows the sequence:
  `bootstrapMetaKernel` + `linkSchema` + `register` for the kernel, then `preload` for meta/core).
  Embedding the three bundled schemas as static, browser-safe strings would make that automatic;
  it is real, scoped work of its own and not something this front-door package attempted.
- **Schema resolution stays synchronous; fetching does not, and that split is a deliberate
  platform divergence from the Java, not a spec question.** `link/link.ts`'s/
  `compiler/schemaResolver.ts`'s `resolveImport` is a plain synchronous function — the frozen
  contract every earlier wave built against — while a real schema fetch is I/O and cannot be
  synchronous in JS the way the reference implementation's blocking `TsonSchemaSource.fetch` is in
  Java (real threads, so blocking inside a "sync" resolver callback is fine there). `Tson.preload`
  is therefore where fetching happens: it fetches, resolves, links, and registers each reference
  **in order**, so that by the time something referencing it is resolved, `resolveImport` finds it
  already registered and never itself needs to suspend. A reference list preloaded out of
  dependency order fails with a clear `TsonSchemaValidationError` naming what wasn't registered
  yet, rather than silently trying to fetch mid-resolution.
- **`validate()`/`readTree()`'s collecting mode does not catch a base-syntax failure into a
  diagnostic.** The reference implementation's own facade documents doing exactly this ("both
  facades catch a document that will not lex or parse ... a collecting read never throws for a bad
  document") — this port's `facade/tree.ts` does not: a malformed document (bad UTF-8, an
  unlexable token, a structural parse error) throws `TsonLexError`/`TsonParseError`/
  `TsonUnsupportedDocumentError` straight past a `DiagnosticsCollector`, because the failure
  happens in `createDataStream`, before any `ReadContext` exists to report through. A caller using
  `validate()` for a "collect everything, never throw" read must additionally catch these three
  types itself — the CLI's own `problem.ts` does this (`classifyReadError`). Worth closing by
  wrapping `readWholeDocument` the way the reference implementation's facade does.
- **`compile()`'s lazy reader cache means `TsonNotImplementedError` can still escape a collecting
  read.** `compiler/compile.ts`'s `compile` builds each entry's `TypeReader` on first request
  rather than eagerly (a deliberate divergence from the reference implementation, noted in that
  module's own doc) — so a construct this library cannot read yet is only discovered, and thrown,
  when a value of that type is actually read, past whatever `DiagnosticsReceiver` is in scope
  rather than surfacing as a `NOT_IMPLEMENTED` diagnostic beside the others. The CLI treats this as
  its own distinct case (`problem.ts`'s `'not-implemented'` classification, escalating a `validate`
  run's exit code past invalid to a library-gap fault) rather than mistaking a gap for a verdict on
  the document.
- **All three bundled schemas resolve, link, and match their fixtures up to two deferrals.**
  `subtypes` is exact against `meta-kernel-resolved.tn` (top 17, atom 6, product 5, sum 1,
  text_type 2, atom_specification 2, array 1).
  `packages/tson/test/bundled-schemas-resolve.test.ts` holds each remaining difference as an
  assertion rather than a skip, so the list can only shrink:
  - A REQUIRED_WITH_DEFAULT atom-specification field (`spec`, `component`, the `allow_*` flags)
    is written where the fixture omits it at its default. Whether such a field is written at its
    default is a writer question, and the writers land in Wave 5.
  - `token_set` round-trips as an unordered unique `array` rather than as `set` — `topBinding`
    maps every host `ArrayBody` to the `array` wire name, and the aliases need a discriminating
    test on the write side and a reader on the other.
  - Key annotations (§6's `@doc` on each declaration) are dropped. This is the evidence the
    annotations-carrier gap below needed: it is not cosmetic, it loses documentation from the
    resolved output.

- **A variant's dispatch lookahead buffers a value's whole annotation run.** `readVariant` skips
  annotations inside `lookingAhead` to find the `!type-ref`, so the events it rewinds grow with
  the annotation count rather than with nesting depth. The rewind itself is now linear and no
  longer overflows the stack, but the buffering is a real departure from CLAUDE.md's
  "memory is proportional to nesting depth" and wants the annotations captured rather than
  skipped-and-replayed. Wave 7's memory sweep is where this gets measured.

- **`annotations` is bound as an ordinary wire field, not as a record's annotations carrier.**
  `bind/binding.ts` types `annotationsCarrier` against `annotations/index.ts`'s
  `Annotations` (`{ values }`), while `schema/meta` carries its own stand-in
  (`readonly Annotation[]`); the two do not meet. Wave 3's fixture comparison against
  `spec/m/*-resolved.tn` is what will show whether this changes the resolved output.

## Scaffold

- [x] Workspace, tooling, CI
- [x] Frozen contract layer — the types every work package builds against
- [x] Conformance harness — discovers and pairs all 146 vectors
- [x] Reference fetch — pinned Java source and the vector suite
- [x] Vendored `spec/` — the two spec parts and the six bundled schemas, byte for byte
- [x] Unicode tables — `XID_Start` / `XID_Continue` / `Nd`, generated and checked in
- [x] I-Regexp general categories — all 36 of RFC 9485's, generated into the `regex/` leaf
- [x] Orchestration — `ORCHESTRATION.md` and the eight wave scripts under `.claude/workflows/`
