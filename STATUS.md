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
- [ ] Writers — streaming emit, optional `!!id`/`!!schema` header
- [ ] Document header classification (§7.1)

## Part 2 — type system and schema (Class 2)

- [x] Schema grammar — schema documents parsed into a faithful AST
- [x] Desugaring — every sugar form lifted to a closed synthetic entry
- [ ] Resolution — composition, refinement, constructor application, templates
- [ ] Linking — reference validation, transitive `!!import` merge, choice disjointness
- [ ] Identity and hashing — canonical `!!id`, `?sha256=` pinning
- [ ] Bundled schemas — `meta-kernel.tn`, `meta.tn`, `core.tn` resolving end to end
- [ ] Compilation — a compiled, schema-validating reader
- [ ] Diagnostics — the data- and schema-side problem model

## Beyond the reference implementation's shape

- [x] I-Regexp engine (RFC 9485) — linear-time, ReDoS-safe
- [x] Binding layer — authored descriptors with inferred static types
- [ ] Front door — `parse`, `readTree`, `validate`, `write`, `createTson`
- [ ] Schema sources — HTTPS with a deny-by-default allow-list; file with realpath containment
- [ ] CLI (`@ltr8/tson-cli`) — `validate`, `compile`, `hash`, `init-example`
- [ ] Dual ESM/CJS publish, browser bundle

## Known gaps

- **The bundled schemas do not yet resolve to their fixtures.** `meta-kernel.tn` resolves and
  matches up to four documented deferrals; `meta.tn` and `core.tn` do not resolve at all. Every
  cause is a capability a later wave delivers, and
  `packages/tson/test/bundled-schemas-resolve.test.ts` holds each as an assertion rather than a
  skip, so the list can only shrink:
  - `subtypes` is empty everywhere — the reverse supertype index is a whole-schema pass the
    reference builds in its linker (Wave 4, work package 15).
  - `meta`/`core` need a **compiled meta-schema reader**: `definitionMetaReader` reads a
    data-value back into a `Top`, and `bind/` carries only the write direction today. The readers
    are Wave 4, work package 16. `core`'s `!!meta` chain runs through `meta`, so it never starts.
  - `token_set` round-trips as an unordered unique `array` rather than as `set` — `topBinding`
    maps every host `ArrayBody` to the `array` wire name, and the aliases need a discriminating
    test on the write side and a reader on the other.
  - Key annotations (§6's `@doc` on each declaration) are dropped. This is the evidence the
    annotations-carrier gap below needed: it is not cosmetic, it loses documentation from the
    resolved output.

- **`writeFloat` does not spell a whole float with a fractional part.** `write()` of `12` gives
  `"12"` where the suite's canonical text and `Double#toString` both give `"12.0"`. Reading is
  unaffected and round-trips; this is a writer-side formatting gap, and the writers land in Wave 5.
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
