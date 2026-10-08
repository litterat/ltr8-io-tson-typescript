# Status

← back to the [README](README.md)

Built against TSON Part 1 (lexer + data format) of the **2026 Revision 37** series, a working draft:
https://tson.io/raw/2026/37/tson-part1-data.md, Part 2 (schema grammar + type system), also a
working draft: https://tson.io/raw/2026/37/tson-part2-schema.md, and Part 3 (the JSON encoding,
`./json`): https://tson.io/raw/2026/37/tson-part3-json.md.

A TypeScript port of the reference Java implementation. Conformance is measured against the shared
corpus at https://github.com/litterat/ltr8-io-tson-test-suite, pinned to a commit — 459 subjects
over `tests/<class>/<layer>/<bucket>/`.

**Conformance: 459 / 459 subjects passing at the pinned suite commit, Class 1 and Class 2.**

Class 1 (236): 35 lexer, 44 parser, 27 reader, 14 resolver, 116 vocabulary. Class 2 (223): 86 schema,
24 link, 113 validate.

`RUNNER.md` in the corpus is normative for runners, and every rule it states is implemented.
Sidecars are parsed with this implementation's own parser. Subjects are fed as raw bytes —
verified directly for the eight vectors carrying deliberately malformed UTF-8, which reach the
lexer unmodified and are rejected by it rather than by a decoder. The error `category` is asserted
on every error vector, with the mapping layer-aware, since `resolver` at the vocabulary layer and
`resolver` at the reader layer are different error classes here; at the Class 2 schema and link
layers the category is the phase's, decided by the schema having failed to load rather than by
whichever internal code fired, and a non-verdict diagnostic — a gap, a bind mismatch, one of the
five fetch codes — never satisfies an error vector. A reader-layer subject is parsed cleanly
before the read is asserted, so a vector that had become a parse error cannot pass for the wrong
reason. §8.2's refusal is asserted as the fifth outcome it is: something was refused, _and_
nothing was also reported under one of §8.1's four categories. No position is ever asserted. A
resolver-minted name's content hash is normalised wherever it appears — as an entry's own key,
inside a body, or in a list of names a sidecar states — not only at the end of a key.

One skip, declared and reported: `proposed/`, which is empty in the pinned checkout. No vector
declares `utf-16` or `utf-32`. Every `refused` vector states the UTS #39 data version this build
carries, so the version-mismatch ground never fires here — the comparison runs anyway, because the
day it does not match is the day it matters.

## Part 1 — data format (Class 1)

- [x] Lexer — UTF-8 decoding, code-point addressing, NFC checking, malformed-sequence rejection
- [x] Unicode tables — `XID_Start`/`XID_Continue`/`Nd`, `Pattern_White_Space`
- [x] Ignorable format controls (§7.2) — LRM and RLM are consumed where a token boundary already
      exists and refused where they would otherwise split one unquoted token, so `ad<LRM>min` is a
      lexer error naming the invisible character rather than two tokens read silently
- [x] Identifier grammar (§7.7) — the `identifier` production over a token's decoded text, in NFC,
      with UTS #39 §3.1.1.1's joining-control contexts, applied at annotation and type-annotation
      names as a parse error
- [x] Name hygiene (§8.2) — enforced by default and refused as a fifth outcome distinct from
      §8.1's four categories. Two Part 1 scopes, each seeing only the mechanisms that can mean
      anything there: a record's own field names see the look-alike rule alone, being lexical
      rather than `identifier` (§2.5, §7.7), and a type-ref or annotation name sees the two
      per-name rules but not the look-alike one, a lone name having no scope to be distinct
      within. §8.2's "Values" paragraph applies to every token a read decodes, where only the
      restricted-script rule can reach. The UTS #39 data version is stated once per instance on
      `Tson.processorPolicy`, not repeated in each refusal — a version is constant for the run, and
      a sender needs the policy before writing rather than after being refused. Relaxation is an
      `identifierPolicy`/`tokenPolicy` the caller passes in code; nothing is read from the
      environment
- [x] The bare `+` special token (§7.1, §7.2) — the fifteenth special character, the lexer's first
      change since Revision 35; the schema grammar's optional-group mark, an ordinary token nowhere
      else
- [x] Text normalization (§2.4, §2.6, §8.2) — a `text_type`'s `normalization` form
      (`NONE`/`NFC`/`NFKC`/`ASCII_CASEFOLD`/`NFKC_CASEFOLD`) puts a value into its form before
      facets are judged and decides key identity at map, set and `unique_items` positions.
      `NFKC_CASEFOLD` applies `toNFKC_Casefold(NFD(X))` as Unicode D147 defines it, so two NFC-equal
      keys never fold apart (`unicode/normalization.ts`)
- [x] `uri`, `uri_reference`, `iri`, `iri_reference` (§5.2, §5.6) — RFC 3986 and RFC 3987 grammars
      hand-written (`atom/network/uriGrammar.ts`); `uri` refuses a relative reference and anything
      beyond US-ASCII, an IRI admits `ucschar`/`iprivate`; a `!!id`/`!!schema` argument and a
      schema identity are read as IRI-references
- [x] Identity (§2.2.1) — an identity is parsed as RFC 3987; with no authority it is the absolute
      path, so `/x.tn`, `file:/x.tn` and `file:///x.tn` are one identity; a relative path with no
      host, a fragment, userinfo and a port are refused; the host is lowercase
- [x] Void vocabulary (§2.9) — `_` is the void sentinel throughout: tree node `'void'`, token
      `'void-token'`, diagnostic `VOID_MAP_KEY`, `VoidNode`/`voidNode`/`VOID`, `VoidValue`,
      `VoidEvent`, `Emitter.voidValue()`, following the reference's `TsonVoid`/`VoidValue`/
      `VoidEvent`. **Breaking at 0.37.0:** the Revision 36 names (`AbsentNode`, `absentNode`,
      `ABSENT`, `'absent'`, `ABSENT_MAP_KEY`, `Emitter.absentValue()`) are gone. A required field not
      written reads `(missing)`, and "absent" survives only for a field or facet a body does not
      state
- [x] Event stream — the Tier 2 pull source
- [x] Data parser — the Tier 3 AST
- [x] Base types — null, boolean, string, numbers (integer, float, hex-float, based-integer),
      `!boolean` included in the schemaless vocabulary (§5.5)
- [x] Number grammar — hand-written, one function per ABNF rule
- [x] `ATOM_FORM_INVALID` — a token the atom grammar itself rejects is a resolver error distinct
      from `ATOM_CONSTRAINT_VIOLATION` (a parsed value out of range), riding the existing
      `TsonAtomParseError`/`TsonAtomValidationError` split (`core/diagnostic.ts`)
- [x] Value identity — scale is a spelling (`1` and `1.0` are one `number` for set members, map
      keys and FIXED comparison); `time` and `datetime` compare as instants, not by lexeme
      (`value/equality.ts`)
- [x] Integer types — `int8`–`int256`, `uint8`–`uint256`, `positive_integer` and siblings
- [x] Decimal/float types — `number`, `float32`, `float64`, `rational`, `complex`
- [x] Identifier/network types — `uuid`, `uri`, `uri_reference`, `iri`, `iri_reference`, `email`,
      `ipv4`, `ipv6`, `cidr4`, `cidr6`, `mac`
- [x] Binary types — `base64`, `base64url`, `base32`, `hex`
- [x] Temporal types — `date`, `time`, `datetime`, `duration`
- [x] Tree model — `Value` nodes, RFC 6901 pointers
- [x] Writers — streaming emit, optional `!!id`/`!!schema` header
- [x] Document header classification (§7.1, §2.2) — `classifyDocument`: data or schema from the
      header alone, at most two directives of lookahead, no value parsing

## Part 2 — type system and schema (Class 2)

- [x] Schema grammar — schema documents parsed into a faithful AST, including the three-slot field
      grammar (`field-name ["?"]`, `field-modifier = ("~" / "=") token / "=" "?"`) and
      `[definition-mark ws]` in a schema-map entry
- [x] `record_field` as four facts — `optional`, `voidable`, `role` (`FREE`/`DEFAULT`/`FIXED`),
      `value?` — with omission's meaning always derived, never stored. Refinement moves through
      three independent orders (omission absent → required → injected; voidable true → false;
      role FREE → DEFAULT → FIXED) and never backwards on any of them
- [x] Record extension and the discriminated family (§5.2, §7.2) — `extension`
      (`ABSTRACT`/`FINAL`/`OPEN`, default `OPEN`) and `=?` selectors (`discriminators`); an
      ABSTRACT position requires the tag and admits exactly its subtypes; nothing composes or
      refines onto a FINAL record; every subtype pins each selector FIXED, pairwise distinct as
      values (`1` and `0x1` collide); a member-dispatched position looks ahead within one record
      since the selector may arrive after the fields it selects
- [x] `record.supertypes` as `[type_ref]` — a parameterised parent substitutes and closes with the
      held body, so `ok<text>` IS-A `result<text>`
- [x] A record-bodied template as a family base — ABSTRACT by derivation, `discriminators`
      whatever survives parameter erasure, nameable bare at a type position; the template itself
      is never credited as a subtype of its own base, only its instantiations
- [x] Declared applications as entries — a declaration naming a fully-bound application
      (`bx => box<text>`) resolves to the closed record itself with no minted twin and no
      `!reference` hop; a use-site application still resolves to the owning declaration
- [x] Enum profile (§5.4) — `IDENTIFIER` (default, sees name hygiene) and `TEXT` (string-class,
      any text, hygiene does not reach the members); `enum_set`'s element type is `text`
- [x] `text_type.members`, settable once beside `pattern` (also settable once); every member
      checked against the facets beside it
- [x] `disjoint` class stability — an approximate atom still admitting NaN or infinity, and a map
      keyed by a compound type, are never disjoint in any encoding
- [x] Not judged (§8.1, §10.1) — an unobtainable schema is reported as unavailable, a fifth state
      beside the four error categories and a §8.2 refusal, located at the reference; a pin
      mismatch stays a resolver error
- [x] All-or-nothing reads — a document that reported anything yields no value, in tree mode and
      bind mode alike; there is no tree placeholder for a refused value, so a void node always
      means a written `_`
- [x] Name hygiene at the schema layer (§11.4) — the four scopes §11.4 names: one enum's members,
      one record's field names including group labels, one schema's declared names, and the merged
      namespace at `!!import`, where two schemas each clean alone collide on import; plus a fifth
      this implementation adds, a template's own type parameters, which §11.4's list omits though
      `<T, Т>` is exactly the substitution hazard §8.2 exists to refuse. Within a scope the
      collision relation runs first and the two per-name rules after, so a pair that is both
      confusable and individually mixed-script reports as confusable. Choice
      variants are deliberately not a scope; a confusable variant pair is already a confusable pair
      of declared names
- [x] Subsumption at every governed position (§7.2) — a stray or wrong `!Type` is refused at an
      atom, array, map or tuple position and at a record with no subtypes, not only where a record
      declares subtypes
- [x] Field groups with options (§5.9–§5.11, #18) — `( a: T | b: U )`, `+` and `?` marks,
      `optional_members`, and a group as a first-class `field_group` record; the schema parser
      applies §5.11's declaration rules (Java `checkGroupShape`), the resolver applies them to a
      group however it is spelled (a `!record { groups: [ … ] }` literal included), and every group
      refusal reads `FIELD_GROUP`. Removing a group's other options leaves the surviving member's
      voidability alone; a map's voidable values count for inhabitance (§5.10.1)
- [x] Typed template parameters (§5.2, §5.10, #9) — `<N, T, V: T>`: a value parameter carries a
      type, may name an earlier parameter only, and is checked at the call site; a literal type
      argument is refused at the declaration that wrote it, not at a minted name
      (`compiler/templateSubstitution.ts`, `compiler/templates.ts`)
- [x] Declared family members (§5.2, §5.10, §8.2) — a family's members are the declarations that
      name them; two members pinning one selector value are refused, comparing pins under the
      selector's own type; only a pin on an _unmarked_ name is a selector
- [x] Identifier families (§5.4, §5.5, §7.7, #7) — `identifier` is a text family with a profile
      (`identifier_type`: `start`/`start_add`/`continue`/`continue_add`/`medial`/`exclude`,
      `normalization`), refinable but fixed once moved; a value of the family is a name, so §8.2's
      mechanisms reach it under its profile (`unicode/identifier-profile.ts`)
- [x] `enum_type` (§7.4, #19) — an enum has a label `type`, and its members are judged under that
      type's profile; a pinned `type` is followed through enum refinements and a template's held
      body to the constructor that pins it. `!enum`, `!text_enum` and `!enum_type` refine alike;
      a narrowed member set keeps the inherited order
- [x] `ordered` (§5.3, §7.5) — part of array and map identity: a unique array of unordered arrays
      refuses a reordering, a map's entry order matters only when `ordered: true`
- [x] `value`/`void` constructors and the retired `element_state`/`unit` (#20) — `void_type` and
      `value_type` in the kernel, no sign-bound or unit core names
- [x] `scoped.schemas` keys are schema identities (§7.8) — a fragment is refused; a `!!schema`
      push at a position whose own type is not `scoped` is `SCOPE_NOT_ADMITTED` (resolver)
- [x] Processor policy (Part 1 §8.2, `m/policy.tn`) — `ScriptPolicy` (a UTS #39 level and its
      permitted scripts), `IdentifierPolicy` (a script policy plus `perSegment` and
      `skeletonDistinctness`), a token policy, §9.1's limits and the UTS #39 data version, held in
      one `ProcessorPolicy`. `policy.tn` is the fourth bundled schema, served by identity; nothing
      loads a policy document and no document selects its own policy. A name refusal
      (`CONFUSABLE_NAMES`/`RESTRICTED_*`) is not a verdict (`isNameRefusal`), and a schema-load
      refusal carries its §8.2 code and a pointer to the refused key
- [x] Resolved output names the applied constructor (§8.1) — `enum_set` writes `!set_type { … }`
      as the fixture does, from the entry's `source`; the three bundled fixtures compare equal in
      written form with no remaining deferral
- [x] `tson strip` (`compiler/strip.ts`, the reference's `TsonSchemaStripper`; `tson strip [--keep-docs] <schema>`) — drops `!!id`,
      a header argument's `?query` and the reader-facing annotations (or only `@comment` under
      `--keep-docs`), shortens a bundled identity, and re-parses its own output
- [x] Desugaring — every sugar form lifted to a closed synthetic entry
- [x] Resolution — composition, refinement, constructor application, templates
- [x] Linking — reference validation, transitive `!!import` merge (diamonds unified), `subtypes`
      reverse-index population, choice disjointness and `@disjoint` assertion checking
- [x] Identity and hashing — canonical `!!id` (`link/identity.ts`), `?sha256=` pinning and content
      hashing via a hand-written, zero-dependency SHA-256 (`link/contentHash.ts`'s own
      `sha256HexSync`; `sha256Hex` is the same computation wrapped `async` for existing callers).
      Registering a schema (`config.ts`'s `resolveSchema`/`preload`) pin-checks it like a fetched
      one either way — its own `!!id` pin against its own content, and a later pinned reference to
      its identity against the recorded hash
- [x] Bundled schemas — `meta-kernel.tn`, `meta.tn`, `core.tn` resolving end to end, and `policy.tn`
      served by identity
- [x] Compilation — a compiled, schema-validating reader
- [x] Diagnostics — the data- and schema-side problem model

## Part 3 — JSON encoding (Class 3)

A second, parallel stack under `@ltr8/tson/json`, with no dependency on the text encoding's lexer,
stream, reader, compiler, tree or facade modules (`eslint.config.js`'s own zone for `src/json/**`;
`IDIOM-DEBT.md` records why it is a stack of its own rather than a mode of the text one). Built
against [TSON-JSON] (`spec/tson-part3-json.md`).

- [x] Lexer and event stream (§3.1) — RFC 8259 over bytes this package decodes itself, code-point
      addressed; one leading BOM discarded; a lone surrogate is a lexer error, a surrogate pair one
      character; numbers kept as lexemes, never rounded through a host float
- [x] `JsonValue` tree and schemaless read/write — duplicate member names refused after NFC;
      `parseJson`/`parseJsonAsync`/`parseJsonCollecting` (`json/index.ts`)
- [x] Schema-directed read (§5–§8), compiled once from a `LinkedSchema` (`compileJsonSchema`) —
      atoms by their own parsing contracts, enums matched on content; records closed, NFC names,
      the three field slots, injection, FIXED by value, groups; arrays, sets, tuples; object-form
      and pairs-form maps; the annotation object (§3.3) and its leading-member rule; tag dispatch
      at OPEN/ABSTRACT positions and member dispatch at a sealed family (§6.1.5); the choice kind
      table (§8) over the resolver's `disjoint` fact; all-or-nothing reads (§9.1)
- [x] Revision 37 changes (§3.1, §5, §6, §8.5, §9.4) — duplicate member names judged after the key
      type's `normalization`, then NFC; identifier families string-class under their profile;
      text put into its form before facets; `uri`/`iri` refusing a relative reference; a leap
      second refused; a set may be empty; `tuple1<T>` a one-element array; an `ordered` map
      delivered in the order read, object form and pairs form alike; `FIELD_GROUP` for a group
      that is not optional admitting exactly one option, an optional group at most one, `+` any
      non-empty subset; an identifier-typed value judged under its family's profile and an
      identifier-keyed map's keys a look-alike scope
- [x] Scoped positions (§3.3, §8.5) — `$type` alone selects LOCAL; `$schema` with `$type` selects
      EXTERN, fetched through the caller's `foreignSchemas`, consumed, and the rest read as a
      `$type`-led object; a bare value, a missing `$type`, a cell the scope does not admit or a
      schema or type outside `schemas` is a validation error; `$schema` at a position whose own
      type is not scoped is `SCOPE_NOT_ADMITTED`
- [x] Front door (`json/facade.ts`) — `readJsonTree`/`readJsonTreeAsync`,
      `validateJson`/`validateJsonAsync`, sync over bytes and async over a chunked `Task<T>` source
      exactly as the text stack's `readTree`/`validate`; a caller supplies an already-compiled
      `JsonCompiledSchema` and a root name, mirroring how `readTree`/`validate` take a
      `CompiledSchema` (§3.4's out-of-band binding route — the only route this port implements,
      see Known gaps)
- [x] CLI (`tson validate`) — a `.json` input (case-insensitive) is bound by `--schema`/`--root`;
      a `--root` naming no entry is a usage error (exit 2) checked before any file opens.
      `--identifier-policy` reaches a `.json` input's schema-directed read too (§9.4), not only
      `.tn`'s. **Standard input is TSON text by default, whatever binding is given** —
      `--input tson|json` forces every input this run reads, `-` included, to one encoding,
      overriding the by-extension/TSON-for-stdin default; an unbound input this run reads as JSON (by extension or
      by `--input`) is a usage error (§3.4 has no schemaless JSON reading). **Deliberate divergence
      from the reference CLI**: the reference's own `ValidateCommand.isJson` reads bound standard
      input as JSON unconditionally, with no escape hatch, so `cat data.tn | tson validate --schema
s.tn --root person -` would read `data.tn`'s TSON text as JSON there. This port keeps stdin
      as TSON text unconditionally instead, so that invocation reads `data.tn` correctly; `--input`
      makes the JSON reading available too, explicitly rather than inferred from the binding.
- [x] Package surface — `./json` subpath (ESM + CJS + types), `check:package` (publint,
      are-the-types-wrong), the browser bundle test, `smoke-cli.sh`'s `.json` case

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
- [x] Identity and content hashing, publicly — `@ltr8/tson/identity`: §2.2.1's `sha256Hex`/
      `sha256HexSync`, `contentStart`, `declaredSha256`, `verifyContentHash` and `withSha256Pin`
      (pinning, the inverse of `declaredSha256`) beside
      `canonicalizeIdentity`/`sameIdentity`/`validateIdentity`.
      Its own subpath rather than part of the default entry: nothing in it reaches the compiler,
      the lexer or the event stream, so a consumer who wants only a document's content hash takes
      only that. The CLI's `hash` command consumes it rather than reimplementing §2.2.1, which is
      what it did before this existed
- [x] Schema sources — `@ltr8/tson/source`'s `httpSchemaSource` (deny-by-default host allow-list,
      no redirects ever, size cap enforced while streaming, timeout) and `fileSchemaSource`
      (containment checked after `realpath`); both Node-only, reachable only through that
      separate subpath (`src/source/`, its own `types: ["node"]` project) and never from the
      package's default entry
- [x] CLI (`@ltr8/tson-cli`) — `validate`, `compile`, `policy`, `strip`, `hash`, `init-example`;
      `text`/`json`/`tson` output (the `tson` format via `write()`, never string concatenation);
      exit codes `0` valid, `1` invalid input (a §8.2 refusal included — the sender still holds the
      fix), `2` usage error, `69` a schema permanently unobtainable, `75` one temporarily so, `78`
      a type with no registered binding, `70` library gap or fault, ranked `70 > 78 > 69 > 75 > 1`
      by who must act first. A run reports `outcome` — `VALID`/`INVALID`/`NOT_CHECKED` — rather
      than a boolean, so a document whose schema was never fetched is not reported invalid. The
      §8.2 policy is configurable from the command line (`--identifier-policy`,
      `--identifier-per-segment`, `--identifier-allow-look-alikes`, `--identifier-scripts`,
      `--token-policy`, `--token-scripts`), stated once per run on the report in `policy.tn`'s
      shape (scripts by their UAX #24 alias), and printable with no document in hand via
      `tson policy`.
      Bootstraps its own copy of
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

- **The JSON encoding's ([TSON-JSON]) scope is narrower than the full spec's, and in one respect
  narrower than the reference implementation's own** (`REVISION-36-PLAN.md`'s own "Scope
  decisions"; the reference records most of these as deferrals, not conclusions). Everything below
  except the object-binding gap matches a deferral the reference records too:
  - **§3.4's in-band root binding is not read.** A document naming its own `$schema`/`$type` at
    the root, with no schema supplied out of band, is not a route this package implements — every
    call to `readJsonTree`/`validateJson` requires `schema`/`root`. `$type` tag dispatch _inside_
    a document already bound out of band (subsumption, record families, choices) is implemented in
    full; what is missing is starting a read with no binding at all.
  - **§8.5's scoped positions** (`declared`, `extern`, `dynamic`, `extern_of`/`extern_type`) are
    read (`json/schema/scoped.ts`), but **the JSON front door takes its foreign schemas from the
    caller**: an EXTERN value's schema is looked up through `compileJsonSchema(linked, {
foreignSchemas })`, and a compile with no lookup reports `SCHEMA_NOT_PERMITTED`. There is no
    JSON-side registry or loader; a caller passes its own lookup (a `Tson` instance's `schemas` map
    serves). A template naming no `extension` — a genuine open template used bare, never applied —
    still takes a `NOT_IMPLEMENTED` reader in JSON, where the text reader reads it.
  - **The §3.5 `TSON-Schema`/`TSON-Accept-Schema` header fields are not implemented.** They are an
    HTTP-transport convention over §3.4's out-of-band route; nothing in this package or the CLI
    reads or writes them. A caller wiring an HTTP layer implements them itself, on top of the
    out-of-band binding this package already takes as a plain argument.
  - **There is no schema-directed JSON encoder.** §9.2's encoder MUSTs (refuse the uncarryable,
    lead an annotation object with its reserved members, tag wherever §8.2 requires, emit
    canonical key content in object-form maps, preserve exact-tier digits and scale, ...) are
    unimplemented; `json/write.ts` only writes a schemaless `JsonValue` tree back to text
    (§9.3's round-trip latitude), never a schema-governed value the way the text stack's own
    `write()` does for `tree/nodes.ts`'s `Value`.
  - **§10.1's resource bounds beyond nesting depth are not enforced by this package specifically**
    — member/element counts, string and number lengths, and decoded-binary sizes are the same gap
    the text encoding already has (`Config`'s own `maxNestingDepth` is the one limit either stack
    checks); default-injection amplification (§10.1's own note) is not tracked either.
  - **There is no JSON counterpart of `readBind`/object binding, unlike the reference.** `json/`
    reads a JSON document into a `JsonValue` tree only (`json/index.ts`'s own top note explains
    why, at length, citing [TSON-JSON] §3.4's "no schemaless reading" and the reference's own
    `JsonValue`-only design note for the _tree_ read); the reference's own `Json` additionally
    exposes an `objectReader()`, and this port has no `objectReader`-shaped function binding a
    JSON document straight into a host object the way `@ltr8/tson/bind`'s `readBind` does for TSON
    text. `src/bind/**` is importable from `src/json/**` (`eslint.config.js`'s own zone comment),
    so nothing structural blocks adding one; it is simply unbuilt.
  - **§7.7 rule 2's contextual carve-out for a joining control does not reach JSON member names.**
    For TSON text, `isIdentifierText` (`unicode/identifier-profile.ts`) enforces the rule ahead of
    name hygiene as a matter of form, so a joiner (ZWNJ/ZWJ) reaching hygiene has already been
    proven to sit in a permitted shaping context (a Persian compound, an Indic conjunct). A JSON
    member name has no such lexer to enforce it first, and `unicode/policy.ts`'s own hygiene scan
    (`firstDisallowedIdentifierStatusCharacter`) excludes every joiner from its check unconditionally
    rather than applying §7.7 rule 2's context test itself — conservative (a joiner with no shaping
    effect is admitted rather than wrongly refused), but not a full implementation of the rule at
    the JSON layer.
  - **§9.4's token policy reaches the schema-directed JSON read** (`ReadJsonOptions.tokenPolicy`,
    `json/schema/tokenHygiene.ts`), at exactly the two positions §9.4 names: a map key
    (`json/schema/map.ts`'s object-form key loop; a pairs-form key reads through an ordinary
    `AtomReader` and is covered by the atom case below) and a string-shaped atom value
    (`json/schema/atoms.ts`'s `makeAtomReader`, checked whenever the arriving event is a JSON
    `'string'`, whatever atom family it is faced to). Checked exactly once per token even where a
    dispatcher (`withAnnotationObject`'s own peek) crosses it first — from the call site rather
    than a stream-level hook, since the two call sites are exactly §9.4's own reach; see
    `tokenHygiene.ts`'s own top note on why a blind stream hook would over-reach into record field
    names, which §9.4 gives to the identifier policy instead. `identifierPolicy` **is** implemented
    for the schema-directed read (`ReadJsonOptions`, `json/schema/nameHygiene.ts`) and the CLI
    passes `--identifier-policy` through to it for a `.json` input exactly as it does for a `.tn`
    one; **`--token-policy`/`--token-scripts` reach only the schemaless _text_ path** — the CLI
    (`packages/cli/src/commands/validate.ts`) threads `tokenPolicy` to neither a `.json` input nor
    a schema-governed text read, a remaining piece of wiring rather than a library gap. The schemaless JSON door
    (`parseJson`/`parseJsonAsync`/`parseJsonCollecting`) takes no token or identifier policy
    either, deliberately: §9.4's policies have nothing to reach there in the first place
    ([TSON-JSON] §3.4: no field names, no `$type`, no schema-typed position at all).
  - **A reserved-member violation (§3.2/§3.3) has no code of its own and reports `UNKNOWN_TYPE_REF`
    instead, a stretched second use of a code whose primary meaning is "the name denotes nothing".**
    `json/schema/reservedMembers.ts`'s own top note lays out the reasoning at length: an unknown
    `$foo`, a `$schema`/`$type` out of lead position, a `$value` with no leading `$type`, and extra
    members beside `$value` in wrapper form are all [TSON-JSON] §9.4's `resolver` category, and
    `UNKNOWN_TYPE_REF` is the closest of `core/diagnostic.ts`'s closed code set that fits both the
    category and (loosely) the meaning — no code here means "a reserved member sits where the
    grammar does not admit one". The reference implementation reports these as
    `Diagnostic.Code.UNRECOGNIZED_FIELD`, which its own `Class2ConformanceSuiteTest.categoryOf`
    files under `validation`, not `resolver` — so this is a divergence in both the code and the
    category from the reference, taken deliberately because §9.4's own table is explicit about the
    category these violations belong to. Whether a dedicated code (a new `RESERVED_MEMBER_MISPLACED`
    or similar) is worth adding to the closed set, over continuing to overload `UNKNOWN_TYPE_REF`,
    is an open question rather than a settled one; recorded here so it is not lost between reviews.
  - **A choice variant that is itself a sealed or abstract-with-no-discriminators record family is
    tagged by its own name, never by a subtype's.** [TSON-JSON] §7.2 (schema series) carves choice
    positions out of the subtype-inclusive subsumption rule it states for "every other typed
    position", giving them §5.4's own variant-membership relation instead
    (`json/schema/dispatchChoice.ts`'s and `compiler/choiceReader.ts`'s own top notes have the
    full citation); the reference implementation's own `DispatchChoiceReader` flattens subtypes in
    too ("a variant, an alias of one, or a subtype of one by its tag"), and this port follows it
    for the alias half only, deliberately. Where the variant's own name has no direct instances
    (an ABSTRACT-with-discriminators/SEALED family, or an ABSTRACT-with-subtypes family reached
    inline), `json/schema/route.ts`'s own `ChoiceSelfTagReadable`/`compiler/subsumption.ts`'s own
    `ChoiceSelfTagReader` let the variant's own name still place a value — reading its
    discriminators exactly as the untagged route would — since it is the only spelling admissible
    at the choice's own tag and the shape would otherwise be unwritable inline in the text
    encoding (JSON alone has a second route via the wrapper form's fresh `$value` object). A
    subtype's own name stays refused at the choice's tag either way; reaching one still means
    typing the position by the record family instead (Part 3 §8.4's own closing paragraph), or,
    in JSON only, wrapping (`{"$type": "<family>", "$value": {"$type": "<subtype>", ...}}`).

- **§8.1's ingest has no implementation.** "Ingest verifies a recorded parameter type and re-runs the
  family checks over the closure", but nothing here reads resolved output back as a schema (the
  reference does not either). The family checks run over the merged closure, ready for such a path.

- **`strip` holds the whole document in memory.** `compiler/strip.ts` parses the schema, rewrites
  it and re-lexes its own output, so memory is proportional to the document rather than to its
  nesting depth. A schema document is small and the command is a one-shot, so this is a deliberate
  departure from CLAUDE.md's streaming rule rather than an oversight.

- **A template's held application is re-serialised, not preserved as written.** §5.10 holds the
  application _as written_, and `compiler/heldBody.ts` builds the text with
  `writeDataValue(application)` from the parsed form, so the author's own spacing does not survive
  (`[ EXTERN ]` where `core.tn` wrote `[EXTERN]`). §5.10 and §8.2 make whitespace free for
  identity — comparison is over the parsed form — so nothing compares wrongly; the resolved output
  simply does not round-trip the source byte for byte. Closing it means carrying the source span
  through the schema parser to the held body.

- **A chained atom refinement records one hop of ancestry where composition records the whole
  chain.** `definitionResolver.ts`'s `resolveAtomRefinement` writes `supertypes: [sourceName]`,
  while `resolveComposition` writes the full transitive chain — so `tiny => !smaller ^ { max: 10 }`
  over `smaller => !small ^ { max: 50 }` over `small => !integer ^ { max: 100 }` resolves to
  `supertypes: [smaller]`, not `[smaller small integer]`. The bundled fixture does not settle it:
  `meta-kernel-resolved.tn` has exactly one atom refinement, `non_negative_integer`, whose source
  `integer` is a constructor _application_ with no supertypes of its own, so `[integer]` is both
  readings at once. Every other refinement in the fixture is a record refinement, and `set_type`
  states `[array product top]` — transitive. §4.2 makes IS-A transitive, so a reader asking
  "is `tiny` an `integer`?" off `supertypes` alone gets the wrong answer today; nothing in the
  corpus asks it. Worth resolving upstream rather than guessing, since it changes resolved output.

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
  `'small'` — a declaration the author never wrote, and possibly in a file they never opened.
  Confirmed still open after §8.3's use-site flattening was removed (`referenceFlattener.ts`
  deleted, resolved output now states every use site exactly as written): the two are independent
  mechanisms. Flattening only ever touched _resolved output_ — the value model `bundled-
schemas-resolve.test.ts` compares — while this gap is `compile.ts`'s own reader-sharing: a
  `Reference` body's compiled reader is `resolve(body.target.name)`, the _cached_ reader already
  built for the target under the target's own name, so every diagnostic baked into it (`expected a
record for 'base', found an array`) names the terminal regardless of how many aliases led there
  or whether resolved output was ever rewritten. The reference implementation renames a shared
  compiled reader per use site at compile time, free at read time. The tree readers here already
  carry a `displayName` distinct from `name`, so the container half is a short step; the atom
  builders have no such parameter across their twenty constructor families, which is what makes it
  a real change rather than a rename.

- **The read stack costs a host call frame per nesting level, and is bounded rather than
  iterative.** §9.1's "nesting depth" bound is `maxNestingDepth`, configurable per call (`parse`,
  `readTree`, `validate`, `parseSchemaDocument`) or once on an instance
  (`createTson({ maxNestingDepth })`), defaulting to §9.1's own 64. Exceeding it is §8.1's fifth
  outcome — a `TsonLimitRefusedError` naming the limit and the configured threshold
  (`core/limits.ts`'s own `nestingLimitRefusal`), never a `TsonParseError`/`TsonReadError` — and
  every enforcement site throws it directly, fail-fast and collecting reads alike, since nothing
  below the point a limit is exceeded is reachable to collect. Lowering the limit is free; raising
  it is bounded by the host's own call stack — around 750 levels for the Tier 3 parser — because
  the recursion is still real. Making Tier 3, the schema grammar and the tree readers iterative
  the way the Tier 2 event stream already is (its explicit frame stack walks a million levels) is
  the proper fix, and the bound is what keeps the failure honest until then. Five distinct paths
  past the bound have been closed, each of which reached a public entry point as an uncaught
  `RangeError`: a schema document's annotation value, its nested array types and its nested choice
  types (all three inside `resolveSchema`/`compile`, which matters most since a schema is
  routinely fetched from elsewhere); a self-recursive schema type read through the compiled reader
  stack, which had no bound at all; and an annotation chain (`@a:@a:@a:…`), which is a real
  descent with no brace or bracket for a structural counter to see.

- **Eleven of [TSON-DATA] §9.1's twelve document-side resource limits are not enforced.** §9.1
  states a limits policy of twelve named counters, each MUST-enforced at its default or a
  configured value; this port builds the refusal mechanism and the nesting-depth counter alone on
  the document side (`core/limits.ts`). A deliberate scope decision, not an oversight: the pinned
  Java reference itself implements only `maxDepth` and leaves the other eleven, and `CLAUDE.md`'s
  "structural parity is worth more than idiom while the reference moves" argument applies to limit
  _coverage_ too — a limit this port enforced and the reference did not would be a divergence
  nobody asked for. No vector in the shared corpus exercises any of these eleven, so nothing here
  is measured red by it, but a document that exhausts one of them (a single 20 MB token, say)
  still reaches an unbounded read rather than a clean refusal. Unenforced, with §9.1's own
  defaults:

  | Limit                  | Applies to                                                               | Default    |
  | ---------------------- | ------------------------------------------------------------------------ | ---------- |
  | token length           | one token's decoded text, in code points                                 | 1,048,576  |
  | decoded text length    | one value's text after escape processing, in code points                 | 1,048,576  |
  | numeric literal length | digits in one numeric token, annotated or not                            | 4,096      |
  | decoded binary size    | one `!bytes` value's octets                                              | 16,777,216 |
  | document size          | the document's bytes                                                     | 16,777,216 |
  | elements               | one array or set                                                         | 1,048,576  |
  | entries                | one map                                                                  | 1,048,576  |
  | fields                 | one record                                                               | 65,536     |
  | annotations            | on one value                                                             | 64         |
  | total values           | all values in one document, containers and scalars alike                 | 16,777,216 |
  | foreign schemas        | distinct schemas a document's scope pushes may load ([TSON-SCHEMA] §7.8) | 16         |

  **All five of [TSON-SCHEMA] §11.5's schema-side limits are now enforced** — import closure,
  schema entries, reference chain, supertype chain, and materialisation depth, each at its own
  §11.5 default (`core/limits.ts`'s own `import-closure`/`schema-entries`/`reference-chain`/
  `supertype-chain`/`materialisation-depth` refusal builders, enforced in `config.ts`'s own
  `resolveAgainstRegistry`, `compiler/referenceChain.ts`'s `walk`, `compiler/definitionResolver.ts`'s
  `checkSupertypeChainLimit`, and `compiler/templates.ts`'s existing depth guard respectively). Unlike
  the document-side eleven, this is not a coverage decision matched to the reference (§11.5 has no
  Java analogue to match, being new in this revision) — §11.5 states all five as a Class 2 MUST on
  the same terms as the document-side limits, so this port builds all five rather than one. **Not
  independently configurable per instance yet**, unlike `maxNestingDepth` — every run enforces each
  at its own spec default, and `Tson.limitsPolicy` reports all six thresholds regardless
  (`core/limits.ts`'s own top note explains the narrower scope). The CLI's `tson policy` and every
  `validate`/`compile` report now carry this whole six-limit policy too (`limits_policy`, beside
  `policy`), reachable with no document in hand exactly as §9.1 asks.

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
- **All three bundled schemas resolve, link, and match their fixtures in written form, with one
  documented difference.** `subtypes` is exact against `meta-kernel-resolved.tn`, and every key annotation (§6) now resolves with its
  value: `schema/annotationReader.ts` reads one through the governing meta's own compiled reader
  for the annotation's name, over `compiler/dataValueEvents.ts`'s replay of the written value.
  `@synthetic` is compared against the fixture exactly; `@doc` is compared against the **source
  document** instead, because `*-resolved.tn`'s own header says it carries long `@doc` strings
  abbreviated and that "a conforming resolver preserves them verbatim" — so the fixture cannot be
  the oracle for their text, and the source is a stronger one.
  `packages/tson/test/bundled-schemas-resolve.test.ts` holds the difference as an assertion
  rather than a skip:
  - `extern_of`/`extern_type`'s held `template` text is re-serialised from the parsed form
    (`compiler/heldBody.ts`'s `writeDataValue(application)`) rather than carried through as
    written, so `[ EXTERN ]` loses its author's spacing. §5.10 and §8.2 make whitespace free for
    identity, so nothing compares wrongly; the resolved output just does not round-trip byte for
    byte. Closing it means carrying the source span through the schema parser to the held body.

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
  `doc => @annotation !type_definition { … }`; this port writes the same annotations as an
  ordinary `annotations: [ … ]` member of the `type_definition` record, which §8.1 does not
  declare. `bundled-schemas-resolve.test.ts` lifts the field into the framing position on both
  sides so the comparison stays about _which_ annotations a value carries, and says so where it
  does it.

  **`type_ref`'s own case is closed.** `type: @alias:type_name token`'s position is `TypeRef`, and
  `schema/bindings.ts`'s `typeRefAnnotatedBinding` (an `annotated()`-wrapped `typeRefBinding`) now
  reads and writes exactly that framing, both directions: `fromDataValue`'s `'annotated'` branch
  recovers a `type_ref` value's own wire annotations into `TypeRef.annotations` on read, and
  `toDataValue`'s does the inverse on write, so a use-site `@alias` round-trips and
  `bind-decode.ts`'s "annotated" kind ({@link AnnotatedBinding}, `bind/combinators.ts`'s
  `annotated()`) is no longer unused outside tests. `RecordField`/`TypeDefinition.annotations`
  are the same underlying gap and remain open: both are still bound as ordinary
  `field()`/`arrayOf()` slots (`recordFieldBinding`, `typeDefinitionBinding`), so a
  `type_definition`'s own `doc => @annotation` still round-trips as an `annotations: [ … ]` field
  rather than framing.

  The cause for the remaining two positions is a genuine type mismatch, not an oversight:
  `bind/binding.ts`'s `RecordBinding.annotationsCarrier` is typed against `annotations/index.ts`'s
  wire `Annotations` (`{ values }`, each value a raw `DataValue`), while `schema/meta` carries
  resolved annotations (`readonly Annotation[]`, each value a _bound_ host value — a tree `Value`
  since `schema/annotationReader.ts`). Those are different things, and a `RecordBinding` cannot
  convert between them through that hook: wire→bound needs a reader for the annotation's type,
  and bound→wire needs an atom encoder, neither of which the carrier hook is handed.
  `typeRefAnnotatedBinding` sidesteps this by not using `annotationsCarrier` at all — it wraps the
  whole position in `annotated()` instead, converting through §4 base type resolution (only
  correct because a `type_ref`-typed value's annotation arguments this package's own bundled
  schemas ever carry are bare tokens, per that binding's own doc); the same trick would need
  checking against `record_field`'s and `type_definition`'s own annotation arguments before it can
  be reused there without narrowing what it accepts.

  Key annotations (§6, `@doc` on a declaration's name) are a separate carrier
  (`compiler/schemaResolver.ts`'s `Schema.keyAnnotations`, `link/link.ts`'s
  `LinkedSchema.keyAnnotations`) and were never affected by this gap; they go through
  `schema/annotationReader.ts` and the compiled readers, never through a binding.

## Scaffold

- [x] Workspace, tooling, CI
- [x] Frozen contract layer — the types every work package builds against
- [x] Conformance harness — discovers and pairs every vector at the pinned suite commit, under
      RUNNER.md's six rules
- [x] Reference fetch — pinned Java source and the vector suite
- [x] Vendored `spec/` — the three spec parts, the change log and the bundled schemas, byte for byte
- [x] Unicode tables — `XID_Start` / `XID_Continue` / `Nd`, generated and checked in
- [x] UTS #39 tables — `Identifier_Status`, the confusables skeleton map, script data and the
      joining-control properties, generated into `src/unicode/` by `scripts/gen-uts39-tables.mjs`
- [x] I-Regexp general categories — all 36 of RFC 9485's, generated into the `regex/` leaf
- [x] Orchestration — `ORCHESTRATION.md` and the eight wave scripts under `.claude/workflows/`
