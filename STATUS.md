# Status

← back to the [README](README.md)

Built against TSON Part 1 (lexer + data format), a working draft:
https://tson.io/raw/2026/34/tson-part1-data.md, and Part 2 (schema grammar + type system), also a
working draft: https://tson.io/raw/2026/34/tson-part2-schema.md

A TypeScript port of the reference Java implementation. Conformance is measured against the shared
corpus at https://github.com/litterat/ltr8-io-tson-test-suite, pinned to a commit — 179
vectors, all Class 1.

**Conformance: 179 / 179 vectors passing at the pinned suite commit.** The pin no longer lags
the corpus: the three behaviours it was held back for — UAX31-R3a-1 bidi marks, ZWNJ/ZWJ
continuation, and the identifier profile at the three naming positions — are implemented.

27 lexer, 29 parser, 20 reader, 14 resolver, 89 vocabulary. `RUNNER.md` in the corpus is normative
for runners and all six of its rules are implemented: sidecars are parsed with this
implementation's own parser; subjects are fed as raw bytes — verified directly for the eight
vectors carrying deliberately malformed UTF-8, which reach the lexer unmodified and are rejected
by it rather than by a decoder; the error `category` is asserted on every error vector, with the
mapping layer-aware, since `resolver` at the vocabulary layer and `resolver` at the reader layer
are different error classes here; a reader-layer subject is parsed cleanly before the read is
asserted, so a vector that had become a parse error cannot pass for the wrong reason; no position
is ever asserted; and a synthetic entry's trailing content hash is normalised before comparison.

Two skips, both declared and reported: `class2/`, because this processor claims the Class 1
conformance class (RUNNER.md's ground 2, "declared by conformance class, not per vector"), and
`proposed/`, which is empty in the pinned checkout. No vector declares `utf-16` or `utf-32`, and
no vector uses the schema-governed splice yet, though both paths are implemented.

## Part 1 — data format (Class 1)

- [x] Lexer — UTF-8 decoding, code-point addressing, NFC checking, malformed-sequence rejection
- [x] Unicode tables — `XID_Start`/`XID_Continue`/`Nd`, `Pattern_White_Space`
- [x] Ignorable format controls (§7.2) — LRM and RLM are consumed where a token boundary already
      exists and refused where they would otherwise split one unquoted token, so `ad<LRM>min` is a
      lexer error naming the invisible character rather than two tokens read silently
- [x] Identifier grammar (§7.7) — the `identifier` production over a token's decoded text, in NFC,
      with UTS #39 §3.1.1.1's joining-control contexts, applied at annotation and type-annotation
      names as a parse error
- [x] Name hygiene (§8.2) — all three UTS #39 mechanisms over the one Part 1 scope, a record's own
      field names, enforced by default and refused as a fifth outcome distinct from §8.1's four
      categories, naming the UTS #39 data version. Relaxation is a `namePolicy` the caller passes
      in code; nothing is read from the environment
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
- [x] Name hygiene at the schema layer (§11.4) — the four scopes §11.4 names: one enum's members,
      one record's field names including group labels, one schema's declared names, and the merged
      namespace at `!!import`, where two schemas each clean alone collide on import. Choice
      variants are deliberately not a scope; a confusable variant pair is already a confusable pair
      of declared names
- [x] Subsumption at every governed position (§7.2) — a stray or wrong `!Type` is refused at an
      atom, array, map or tuple position and at a record with no subtypes, not only where a record
      declares subtypes
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

- **A data document's annotations are preserved but never resolved (§6).** §6 says an annotation
  names a type reachable one hop through the governing target — the `!!schema` target for a data
  document — that an annotation whose name does not resolve there is an error, and that the value
  is validated against that type's contract. This port validates neither: `@no_such_annotation`,
  `@label:42` where `label => text`, a `void`-targeted annotation given a value, and a
  record-targeted annotation missing a required field all pass. The schema side does enforce
  resolution — an unknown annotation on a declaration is caught — so it is the data path that is
  missing the check, and the schema side's own refusal surfaces as an internal error rather than a
  resolver diagnostic, so it is mis-routed even where it works. Worth knowing why an
  implementation would get this wrong rather than merely skip it: under a declared `text` _field_
  an unquoted `42` is the string `"42"` (§7.4), but at an annotation position there is no such
  re-reading, so reusing field-typed token reading for annotation values accepts what §6 refuses.

- **A CJS consumer mixing subpath entries still gets one copy of a shared module per entry.**
  The ESM build shares chunks, so `@ltr8/tson` and `@ltr8/tson/stdlib` name one copy of everything
  they both reach — which they must, since a `standardLibrary()` caller reads through both, and
  two copies means two sets of classes, so `instanceof` answers `false` across them and every
  schema verdict is misread as a library fault. Code splitting is ESM-only in esbuild, so the CJS
  output still carries a copy per entry. Nothing in the package currently depends on module
  identity across entries — the read context's cursor is keyed on a `Symbol.for` registry symbol
  for that reason — but a new module-level `Map`, `WeakMap` or `instanceof` across the boundary
  would reintroduce it silently for CJS.

- **A data document's annotations are preserved but never resolved (§6).** §6 says an annotation
  names a type reachable one hop through the governing target — the `!!schema` target for a data
  document — that an annotation whose name does not resolve there is an error, and that the value
  is validated against that type's contract. This port validates neither: `@no_such_annotation`,
  `@label:42` where `label => text`, a `void`-targeted annotation given a value, and a
  record-targeted annotation missing a required field all pass. The schema side does enforce
  resolution — an unknown annotation on a declaration is caught — so it is the data path that is
  missing the check, and the schema side's own refusal surfaces as an internal error rather than a
  resolver diagnostic, so it is mis-routed even where it works. Worth knowing why an
  implementation would get this wrong rather than merely skip it: under a declared `text` _field_
  an unquoted `42` is the string `"42"` (§7.4), but at an annotation position there is no such
  re-reading, so reusing field-typed token reading for annotation values accepts what §6 refuses.

- **Each subpath entry is a self-contained bundle, so a shared module can exist twice.**
  `tsup` builds with `splitting: false`, which means `reader/context.ts` (among others) is emitted
  into both `dist/index.js` and `dist/stdlib.js`. Module-level state therefore has one copy per
  entry, and a read that crosses entries — which every `standardLibrary()` caller does, since the
  readers come from `@ltr8/tson` and the registry from `@ltr8/tson/stdlib` — sees two of it. The
  read context's cursor lookup is keyed on a `Symbol.for` registry symbol for exactly that reason,
  so it agrees across copies; nothing else in the package currently depends on module-level
  identity, but a new module-level `WeakMap`, `Map` or counter would reintroduce the hazard
  silently. The structural fix is chunk sharing, which `splitting: false` currently forgoes.

- **Use-site naming is not implemented (§8.3).** A diagnostic names the entry a reference resolves
  to, not the alias the author wrote at that position, so `c: pct` where `pct => small` reports
  `'small'` — a declaration the author never wrote, and possibly in a file they never opened. The
  reference implementation renames a shared compiled reader per use site at compile time, free at
  read time. The tree readers here already carry a `displayName` distinct from `name`, so the
  container half is a short step; the atom builders have no such parameter across their twenty
  constructor families, which is what makes it a real change rather than a rename.

- **A value type-argument's identity compares its spelling, not its value (§8.2).** Revision 34
  settles that a literal argument is recorded verbatim but compared under [TSON-DATA] §4 value
  equivalence, so `vector<float32, 255>` and `vector<float32, 0xFF>` are one instantiation entry
  while `1` and `1.0` stay two. This port keys the entry on the written form, so the first pair
  mints two entries that mean the same thing. It costs a duplicate entry, never a wrong verdict.

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

- **Writing a resolved schema back out puts a value's annotations in a field named
  `annotations`, where §3.1 puts them in front of the value.** `spec/m/*-resolved.tn` writes
  `type: @alias:type_name token` and `doc => @annotation !type_definition { … }`; this port writes
  the same annotations as an ordinary `annotations: [ … ]` member of the record, which §8.1's
  `type_definition`/`type_ref` do not declare. `bundled-schemas-resolve.test.ts` lifts the field
  into the framing position on both sides so the comparison stays about _which_ annotations a
  value carries, and says so where it does it.

  The cause is a genuine type mismatch, not an oversight: `bind/binding.ts`'s `annotationsCarrier`
  is typed against `annotations/index.ts`'s wire `Annotations` (`{ values }`, each value a raw
  `DataValue`), while `schema/meta` carries resolved annotations (`readonly Annotation[]`, each
  value a _bound_ host value — a tree `Value` since `schema/annotationReader.ts`). Those are
  different things, and a `RecordBinding` cannot convert between them: wire→bound needs a reader
  for the annotation's type, and bound→wire needs an atom encoder, neither of which the carrier
  hook is handed. Closing it means widening that contract, not rewiring `schema/bindings.ts`.

  Key annotations (§6, `@doc` on a declaration's name) are _not_ affected: they go through
  `schema/annotationReader.ts` and the compiled readers, never through a binding.

## Scaffold

- [x] Workspace, tooling, CI
- [x] Frozen contract layer — the types every work package builds against
- [x] Conformance harness — discovers and pairs every vector at the pinned suite commit, under
      RUNNER.md's six rules
- [x] Reference fetch — pinned Java source and the vector suite
- [x] Vendored `spec/` — the two spec parts and the six bundled schemas, byte for byte
- [x] Unicode tables — `XID_Start` / `XID_Continue` / `Nd`, generated and checked in
- [x] UTS #39 tables — `Identifier_Status`, the confusables skeleton map, script data and the
      joining-control properties, generated into `src/unicode/` by `scripts/gen-uts39-tables.mjs`
- [x] I-Regexp general categories — all 36 of RFC 9485's, generated into the `regex/` leaf
- [x] Orchestration — `ORCHESTRATION.md` and the eight wave scripts under `.claude/workflows/`
