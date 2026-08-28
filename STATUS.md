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
- [x] Document header classification (§7.1, §2.2) — `classifyDocument`: data or schema from the
      header alone, at most two directives of lookahead, no value parsing

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
      as a config-bound registry over them (`src/facade/`, `src/config.ts`). A collecting read
      never throws for a bad document, the behaviour the reference implementation's own facade
      states: a base-syntax failure (bad UTF-8, an unlexable token, a structural parse error)
      reaches the collector as `VALIDATION_ERROR` with the position it already knew, and a
      construct the library has no reader for as `NOT_IMPLEMENTED` — the code that keeps a library
      gap distinguishable from a verdict on the document, which matters because `compile()` builds
      readers lazily and a gap therefore surfaces at read time. `readTree` still fails fast, now as
      the single `TsonReadError` its contract always named, with the original error as its `cause`.
      A `TsonInternalError` is deliberately not caught: a broken invariant is not a diagnostic
      about the document
- [x] Standard library, embedded — `@ltr8/tson/stdlib`: `meta-kernel`/`meta.tn`/`core.tn` as
      source-text constants generated from `spec/m/` by `scripts/gen-stdlib-schemas.mjs`, plus
      `standardLibrary(config?)` (a `Tson` with all three already registered, what the reference
      implementation's `Tson.builder().build()` hands back) and `registerStandardLibrary(tson)`.
      Its own subpath, never the default entry, so a browser consumer of `parse`/`readTree` does
      not carry 45 KB of schema text it never looks at — verified against the built bundles, not
      assumed. No I/O on any platform: nothing is read from disk and no `SchemaSource` is
      consulted, so registering the standard library never reaches the network even when one is
      configured. The CLI now consumes this instead of embedding its own copy
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
- [x] Browser bundle — `browser-bundle.test.ts` bundles all eight browser-facing subpaths with
      esbuild at `platform: 'browser'` (from `src/`, via the `@ltr8/source` condition, so it holds
      on a clean checkout), asserts no `node:` import survives, and runs the result in a `vm`
      context carrying only web globals — no `process`, `Buffer`, `require` or `__dirname` — where
      it parses, reads a tree, and registers the standard library and compiles a schema.
      `@ltr8/tson/source` is asserted unreachable twice over: not exported under the conditions a
      real browser bundler uses, and unbundlable even with the source condition forced on

## Known gaps

- **The read stack costs a host call frame per nesting level, and is bounded rather than
  iterative.** §9.1's bound is `maxNestingDepth`, configurable per call (`parse`, `readTree`,
  `validate`, `parseSchemaDocument`) or once on an instance (`createTson({ maxNestingDepth })`),
  defaulting to 512. Lowering it is free; raising it is bounded by the host's own call stack —
  around 750 levels for the Tier 3 parser — because the recursion is still real. Making Tier 3,
  the schema grammar and the tree readers iterative the way the Tier 2 event stream already is
  (its explicit frame stack walks a million levels) is the proper fix, and the bound is what keeps
  the failure honest until then. Five distinct paths past the bound have been closed, each of
  which reached a public entry point as an uncaught `RangeError`: a schema document's annotation
  value, its nested array types and its nested choice types (all three inside
  `resolveSchema`/`compile`, which matters most since a schema is routinely fetched from
  elsewhere); a self-recursive schema type read through the compiled reader stack, which had no
  bound at all; and an annotation chain (`@a:@a:@a:…`), which is a real descent with no brace or
  bracket for a structural counter to see.

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
- **All three bundled schemas resolve, link, and match their fixtures up to two deferrals.**
  `subtypes` is exact against `meta-kernel-resolved.tn` (top 17, atom 6, product 5, sum 1,
  text_type 2, atom_specification 2, array 1), and every key annotation (§6) now resolves with its
  value: `schema/annotationReader.ts` reads one through the governing meta's own compiled reader
  for the annotation's name, over `compiler/dataValueEvents.ts`'s replay of the written value.
  `@synthetic` is compared against the fixture exactly; `@doc` is compared against the **source
  document** instead, because `*-resolved.tn`'s own header says it carries long `@doc` strings
  abbreviated and that "a conforming resolver preserves them verbatim" — so the fixture cannot be
  the oracle for their text, and the source is a stronger one.
  `packages/tson/test/bundled-schemas-resolve.test.ts` holds each remaining difference as an
  assertion rather than a skip, so the list can only shrink:
  - A REQUIRED_WITH_DEFAULT atom-specification field (`spec`, `component`, the `allow_*` flags)
    is written where the fixture omits it at its default.
  - `token_set`'s body is written `!array { … unordered: true unique_items: true }` where the
    fixture writes `!set { element_type: token }` — the constructor the author actually applied,
    which §8.1 asks for ("a binding record headed by the applied constructor"). `topBinding`
    discriminates on the host value's own `kind`, and `set` is a refinement of `array` sharing its
    shape, so the applied name is not recoverable from the value being written. It _is_ recorded,
    one level up, in the same entry's `source`.

  **Both are writer-side, and both are shared with the reference implementation** — read there
  rather than assumed: its `ArrayBody` carries `@Typename(name = "array")` and its own Javadoc says
  "`state`/`unordered`/`uniqueItems` always appear in written output even at their nominal default
  — unlike a hand-written writer, generic record binding has no notion of 'this value is the
  default, omit it'". Its `ResolvedFixtureTest` tolerates no difference at all, and does not have
  to: it binds the fixture _into the value model_ and compares `TypeDefinition` objects, where both
  `!set` and `!array` arrive as one `ArrayBody` and a field written at its default is
  indistinguishable from one omitted. This port compares **written form**, which is the stricter
  comparison and the reason these two are visible here at all. Worth reporting upstream: a
  resolved-output writer that cannot name the applied constructor is a §8.1 conformance gap in
  both implementations, and the reference's own fixture test is structurally unable to see it.

- **Tree mode's variant dispatch still buffers a value's whole annotation run.** §3.2's
  `!type-ref` sits behind a run of annotations of any length, so a dispatch has to reach past it,
  and looking ahead means buffering what it read to rewind — events that grow with the annotation
  count rather than with nesting depth, which is a departure from CLAUDE.md's "memory is
  proportional to nesting depth".

  **Bind mode no longer does.** Every binding except `annotated` treats a value's leading
  annotations as framing and discards them, so where no member of a variant would keep them,
  `reader/bind.ts` consumes the run outright instead of looking ahead over it — indistinguishable
  from consuming it one call later, and nothing is retained. It still rewinds when a member really
  would keep them.

  Tree mode (`compiler/choiceReader.ts`) has no such case: every `tree/nodes.ts` node carries its
  own `annotations`, so the variant's reader must see the run intact. Closing it there means a
  `TypeReader` that can be handed annotations already read — a change to the compiled reader
  contract, not to that file.

- **`annotations` is bound as an ordinary wire field, not as a record's annotations carrier.**
  `bind/binding.ts` types `annotationsCarrier` against `annotations/index.ts`'s
  `Annotations` (`{ values }`), while `schema/meta` carries its own stand-in
  (`readonly Annotation[]`); the two do not meet. This no longer costs key annotations — those go
  through `schema/annotationReader.ts` and the compiled readers, not through a binding — so what
  is left is the binding-layer mismatch itself, which shows up when a _record body_ carries wire
  annotations rather than when a declaration's name does.

## Scaffold

- [x] Workspace, tooling, CI
- [x] Frozen contract layer — the types every work package builds against
- [x] Conformance harness — discovers and pairs all 146 vectors
- [x] Reference fetch — pinned Java source and the vector suite
- [x] Vendored `spec/` — the two spec parts and the six bundled schemas, byte for byte
- [x] Unicode tables — `XID_Start` / `XID_Continue` / `Nd`, generated and checked in
- [x] I-Regexp general categories — all 36 of RFC 9485's, generated into the `regex/` leaf
- [x] Orchestration — `ORCHESTRATION.md` and the eight wave scripts under `.claude/workflows/`
