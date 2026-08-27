# Status

← back to the [README](README.md)

Built against TSON Part 1 (lexer + data format), a working draft:
https://tson.io/raw/2026/33/tson-part1-data.md, and Part 2 (schema grammar + type system), also a
working draft: https://tson.io/raw/2026/33/tson-part2-schema.md

A TypeScript port of the reference Java implementation. Conformance is measured against the shared
suite at https://github.com/litterat/ltr8-io-tson-test-suite — 146 vectors.

**Conformance: 0 / 146 vectors passing.**

## Part 1 — data format (Class 1)

- [ ] Lexer — UTF-8 decoding, code-point addressing, NFC checking, malformed-sequence rejection
- [ ] Unicode tables — `XID_Start`/`XID_Continue`/`Nd`, `Pattern_White_Space`
- [ ] Event stream — the Tier 2 pull source
- [ ] Data parser — the Tier 3 AST
- [ ] Base types — null, boolean, string, numbers (integer, float, hex-float, based-integer)
- [ ] Number grammar — hand-written, one function per ABNF rule
- [ ] Integer types — `int8`–`int256`, `uint8`–`uint256`, `positive_integer` and siblings
- [ ] Decimal/float types — `number`, `float32`, `float64`, `rational`, `complex`
- [ ] Identifier/network types — `uuid`, `uri`, `email`, `ipv4`, `ipv6`, `cidr4`, `cidr6`, `mac`
- [ ] Binary types — `base64`, `base64url`, `base32`, `hex`
- [ ] Temporal types — `date`, `time`, `datetime`, `duration`
- [ ] Tree model — `Value` nodes, RFC 6901 pointers
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

- [ ] I-Regexp engine (RFC 9485) — linear-time, ReDoS-safe
- [ ] Binding layer — authored descriptors with inferred static types
- [ ] Front door — `parse`, `readTree`, `validate`, `write`, `createTson`
- [ ] Schema sources — HTTPS with a deny-by-default allow-list; file with realpath containment
- [ ] CLI (`@ltr8/tson-cli`) — `validate`, `compile`, `hash`, `init-example`
- [ ] Dual ESM/CJS publish, browser bundle

## Scaffold

- [x] Workspace, tooling, CI
- [x] Frozen contract layer — the types every work package builds against
- [x] Conformance harness — discovers and pairs all 146 vectors
- [x] Reference fetch — pinned Java source and the vector suite
