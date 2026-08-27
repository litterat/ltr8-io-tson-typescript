# Status

← back to the [README](README.md)

Built against TSON Part 1 (lexer + data format), a working draft:
https://tson.io/raw/2026/33/tson-part1-data.md, and Part 2 (schema grammar + type system), also a
working draft: https://tson.io/raw/2026/33/tson-part2-schema.md

A TypeScript port of the reference Java implementation. Conformance is measured against the shared
suite at https://github.com/litterat/ltr8-io-tson-test-suite — 146 vectors.

**Conformance: 0 / 146 vectors passing.**

The count cannot move until Wave 2. The runner parses each vector's sidecar with this
implementation's own parser — the shared suite expects an implementation to dogfood — and the data
parser lands in Wave 2, so every vector currently fails on that one unimplemented call rather than
on anything it is meant to test. The number that moves before then is the **discovered** count,
which must stay 146.

## Part 1 — data format (Class 1)

- [x] Lexer — UTF-8 decoding, code-point addressing, NFC checking, malformed-sequence rejection
- [x] Unicode tables — `XID_Start`/`XID_Continue`/`Nd`, `Pattern_White_Space`
- [x] Event stream — the Tier 2 pull source
- [ ] Data parser — the Tier 3 AST
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

- [ ] Schema grammar — schema documents parsed into a faithful AST
- [ ] Desugaring — every sugar form lifted to a closed synthetic entry
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

## Wave 1 — landed, not yet measured

Everything ticked above is implemented and covered by unit tests written from the spec, but none
of it has been measured against the shared vectors yet, for the reason above. Treat the ticks as
"built and unit-tested", not as "conformant" — Wave 2's gate is what turns that into evidence.

## Scaffold

- [x] Workspace, tooling, CI
- [x] Frozen contract layer — the types every work package builds against
- [x] Conformance harness — discovers and pairs all 146 vectors
- [x] Reference fetch — pinned Java source and the vector suite
- [x] Vendored `spec/` — the two spec parts and the six bundled schemas, byte for byte
- [x] Unicode tables — `XID_Start` / `XID_Continue` / `Nd`, generated and checked in
- [x] I-Regexp general categories — all 36 of RFC 9485's, generated into the `regex/` leaf
- [x] Orchestration — `ORCHESTRATION.md` and the eight wave scripts under `.claude/workflows/`
