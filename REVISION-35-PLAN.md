# Revision 35 plan

Taking this port from 2026 Revision 34 to Revision 35. `ORCHESTRATION.md` says how a run is driven —
one Opus manager, Sonnet `tson-porter` sub-agents writing every line of implementation, a gate
between waves — and that shape is unchanged here. This file says what the waves contain, and why.

Read `CLAUDE.md` first. Its hard constraints bind every agent in every stage.

## What moves

|                           | Revision 34                                | Revision 35                                  |
| ------------------------- | ------------------------------------------ | -------------------------------------------- |
| `JAVA_PIN`                | `a576b62966b78ce9e4f7f656b679b238c0353b79` | `6655418d666e26e333e8f3a17f3374c2e603951d`   |
| `SUITE_PIN`               | `bde7d70048bcb03049069a982d8ae0d9583a382f` | `96f4f7870d23c3bb0b4f0061c6945e8c2e3d2ed6`   |
| Conformance subjects      | 233                                        | **277**                                      |
| Bundled schema identities | `tson.io/2026/34/m/*`                      | `tson.io/2026/35/m/*`, all three digests new |
| Package version           | 0.34.0                                     | 0.35.0                                       |

The reference moved 126 commits across 141 production files (+5052/−1851), concentrated in
`tson-compiler` and `tson-schema`. This is a larger bump than Revision 34, and differently shaped:
34 was mostly vocabulary, 35 reshapes `type_definition` itself. Four fields leave it — `constructor`,
`parameters`, `kind`, `disjoint` — and what replaces each is derived rather than stored. Plan for the
schema model to be rebuilt, not amended.

## Stage 0 — Pins and vendoring

Manager only, no sub-agent. One commit.

- Move both pins in `scripts/fetch-references.sh`; re-run it.
- Re-vendor `spec/` from the new `JAVA_PIN`: both spec parts, `m/{meta-kernel,meta,core}.tn`, and the
  three `m/*-resolved.tn` fixtures.
- Rewrite `spec/PROVENANCE.md` for the new pin and revision.
- Regenerate `packages/tson/src/stdlib/schemas.generated.ts` (`npm run gen:stdlib-schemas`).
- Update the subject count in `fetch-references.sh`'s `SUITE_PIN` comment to 277.

This commit deliberately turns the repository red, exactly as `f587f7a` and `0acc02e` did for
Revision 34: the vendored spec and the bundled schemas move first, so every later diff reads against
the document that justifies it.

**Gate:** `vendored-spec.test.ts` green. Everything else is expected red, and the conformance
discovery count must read 277 — a lower number means the harness broke on the new corpus rather than
on the new behaviour.

## Stage 1 — Part 1, the data layer

Five work packages, all Sonnet, run as a `pipeline()`. Only WP1.2's two halves collide, which is why
they are one package.

### WP1.1 — Escapes (§7.2.2)

`\/` is removed from the escape table and becomes a lexer error; the port accepts it today
(`lexer/lexer.ts`, `decodeEscapeSequence`). The braced form `\u{1*6HEXDIG}` is added, reaching the
supplementary planes directly. Surrogate-pair escapes go entirely — the pairing rule is deleted, and
the single remaining constraint is that an escape MUST denote a Unicode scalar value, so `😀`
is now two errors rather than one character.

§1.3 declares the lexer frozen for the 2026 series as of this revision, and names this change as the
one that triggers the freeze. Nothing else in the lexer moves.

### WP1.2 — Trailing commas and field names

Both live in `compiler/cursor.ts`; splitting them across two agents would collide.

**Trailing comma (§2.4–§2.7, §7.4, and [TSON-SCHEMA] §12.1).** A comma may follow a value, so a
trailing one is ordinary. `consumeSeparatorOrCloseCheck` currently throws on it. A comma following
nothing or following another comma stays a parse error. The schema grammar's list productions —
declarations, fields, groups, removal sets, parameters, arguments, tuple elements — take the same
rule.

**A field name is an identifier at every layer (§2.5, §2.8, §7.7).** `expectFieldNameToken` accepts
any bare token today. It must NFC-normalise the decoded text and match §7.7's identifier grammar,
for both spellings — quoting escapes a lexical accident, it does not admit a broader name set. The
§2.8 brace dispatch tightens with it: the record interpretation is selected only when the first
value's decoded text is an identifier. This breaks schemaless documents with non-identifier keys,
which is the intent; the spec's own guidance is that those belong in a map.

### WP1.3 — `null` is a string (§4.1, §4.4, §4.5, §7.3)

Base type resolution loses its null class. `base/baseTypeResolver.ts` carries a `kind: 'null'` today;
resolution becomes boolean → number → string, and the bare word `null` resolves to the string
`"null"` like any other unmatched token. `_` is the format's one spelling of absence.

Under a schema this tightens further, and the change is easy to miss: Revision 34 accepted `null` as
an equivalent spelling of `_` at a `void` position. Revision 35 does not — `void` admits `_` alone,
and `null` there is a validation error. Two corpus vectors state exactly this pair.

§4.1's applicability is also reworded to key on the document header carrying no `!!schema`. Confirm
against §3.3 and §7.8 that base resolution still applies to the unscoped values of a document that
pushes a scope on one element; the rewording reads as a simplification rather than a rule change, but
it is not stated unambiguously.

### WP1.4 — `!bytes` (§5.3)

`!bytes` is the only binary tag and its spelling is base64. `!base64`, `!base64url`, `!base32` and
`!hex` cease to exist as Part 1 vocabulary. An alphabet is a spelling of an octet sequence, not a kind
of value, and a schemaless document has no schema to carry a selector — so the alphabet moves to the
schema layer entirely, as `bytes_type.encoding` (WP3, WP4.5).

The atom parser half belongs here; `atom/numeric/binary.ts` becomes the `bytes` parser. The meta-model
half is Stage 3.

### WP1.5 — duration and period (§5.4)

The largest Part 1 package. One type becomes two, because a month has no fixed length and a second
does, and `min`/`max`/`multiple_of` need a total order to be checkable at all.

- **`duration`** — RFC 3339 Appendix A's `dur-date / dur-time / dur-week`. No `Y`, no month `M`.
  Value space is signed exact decimal **seconds**. A standalone `PnW` is accepted and a week is
  exactly 7 days, so `P2W`, `P14D` and `PT336H` are one value; `P1W2D` and `P1WT1H` are not durations.
  Canonical write is `PTnHnMnS`, so day and week spellings do not survive a round trip — stated as
  intentional.
- **`period`** — `P` with a `Y` component, an `M` component, or both, and nothing else. Value space is
  signed integer **months**.
- `P1Y2M3DT4H5M6S` is now an error under both.
- Fractional seconds are capped at 9 digits across `full-time`, `date-time` and `dur-time`.
- A `duration`'s magnitude MUST NOT exceed 2⁶³−1 nanoseconds, symmetric for negatives, and a
  processor MUST represent the full range and reject outside it.

`value/types.ts`'s `TsonDuration {period, clock}` goes: it exists because no host type covered the
combined form, and the combined form no longer exists. Note that this reverses the port's inherited
strictness on `PnW` — `.references/ltr8-io-tson-java/CONFORMANCE.md` recorded rejecting it as the
conservative reading, and Revision 35 settles it the other way.

`datetime` and `time` are also reclassified as _instant_ and _time of day_, with offset preserved as
written but not part of value identity. That feeds WP2.

**Gate for Stage 1:** the Class 1 lexer, parser and vocabulary vectors green. Schema-layer vectors are
expected red until Stage 6.

## Stage 2 — One value-space equality contract

One Sonnet package. §5.5 adds a foundational clause: a type denotes a value space, an encoding defines
a lexical space over it, and equality, ordering, refinement, disjointness and content addressing are
defined over value spaces only, never over spellings.

Five rules delegate to it, and the spec names them: the set duplicate rule (§7.5), map-key identity
([TSON-DATA] §2.6), the check of a written value against a FIXED one (§5.2), the identity of a value
argument (§8.2), and the digest a pinned reference verifies (§10.2).

`reader/tree/equality.ts` is a structural `deepEqual` today, which compares a `Uint8Array` by
reference. The corpus's new binary-identity vectors catch exactly that: one octet string written twice
in one spelling must be one map key and one set member, and a FIXED binary field given the value it
declares must be _valid_ — a vector written deliberately so a reference-equality implementation fails
it in the direction that looks like a pass.

Per-family value spaces to implement: `bytes` (octet equality regardless of alphabet), the exact
numeric tiers (`1`/`1.0`/`1.00` one value; `2/4` and `1/2` one rational), `time`/`datetime` (instant
equality regardless of offset spelling), `duration`/`period` (exact seconds and months, so
`PT90M` = `PT1H30M` = `P0DT5400S`).

## Stage 3 — The schema model

One Sonnet package, and it lands alone. `src/schema/meta` is the frozen contract layer every later
stage compiles against, and `ORCHESTRATION.md`'s rule that no agent may edit a contract type another
agent is building against only works if the contract is complete before the fan-out. The manager
reviews this diff before Stage 4 starts.

**`TypeDefinition` loses four fields.**

- `constructor` — the `~` marker is gone from the notation. An entry is a constructor if it IS-A `top`
  (§4.1, §4.2), which is derived from its supertypes, not stored.
- `parameters` — an entry's parameters are its body's (§5.10). Openness is a fact of `body`'s shape.
- `kind` — not resolver output (§4.1, §8.1). A consumer derives it: body is `!template` → TEMPLATE;
  else the body's constructor head is `reference` → REFERENCE; else the entry IS-A `top` → the base
  kind named in its own supertypes, or PRODUCT if none; else the kind of the entry the body's
  constructor head names. `kind` restated what `supertypes` and `body` already determine, and was the
  one thing a document could be lied to about.
- `disjoint` — moves onto `ChoiceBody` (§5.4), a variant list being the only thing it is a fact about.

**Bodies and constructors.**

- `TemplateBody` becomes `{ parameters: string[], template: string }`. The held application is carried
  as **text**, not as a parsed value — this is a real change of representation, not a rename.
  Comparison for identity is over the parsed form of that text (§5.10, §8.2), so whitespace is free.
  The kernel declares `template => top & { parameters: [param_name]  template: text }`.
- `BinaryType` → `BytesType`, with `encoding` a selector facet defaulting to `BASE64` and no `spec`
  field: RFC 4648 governs spellings, not octets.
- `Extern` and `UnknownType` → `Scoped` and `ScopeKind` (§7.8). See Stage 5.
- `DurationType` narrows to seconds; new `PeriodType` over months.
- `IntegerType.members` and `DecimalType.members` — sparse member sets. The kernel gains
  `integer_member_set` and `non_negative_integer` (the type of every counting facet), and `set_type`.
- Annotations: `@discriminator` and `@rest` in as _checked_ annotations, `@title`, `@examples`,
  `@read_only`, `@write_only` in as advisory, `@alias` out. §6 now names three annotation categories —
  checked, representation directive, advisory — and a checked annotation has no third outcome.

## Stage 4 — Resolver and compiler

Nine packages. WP4.1 to WP4.3 all rewrite `compiler/definitionResolver.ts` and run in sequence; the
rest fan out.

### WP4.1 — A reference is a hop, not a rewrite (§8.3)

`compiler/referenceFlattener.ts` is deleted. §8.3's use-site flattening is gone: a use site names what
the author wrote, `target` names only the next hop, and nothing is rewritten in resolved output. The
`@alias` annotation goes with it.

Every rule that needed a terminal type still walks to one — subsumption (§7.2), the choice-variant
void check (§5.4), refinement and composition sources (§4.3, §5.7, §5.9), atom refinement — but the
walk is ephemeral rather than materialised. The reference implementation replaced four ad hoc copies
of that walk with one shared function; do the same rather than inlining it four times.

A processor MAY collapse a chain, but only after linking, when compiling for reading. That makes
chain-collapsing the compiler's business, and it closes `STATUS.md`'s known gap that diagnostics name
the resolved entry rather than the alias written.

### WP4.2 — Applicability is IS-A `top` (§3.3.1, §4.2, §5.5)

`~` leaves the type-def head. It keeps exactly one grammar role, the default-value modifier
(`port: integer ~ 8080`), and at type-def position it is a special token with no role.

What `!C { ... }` may apply is an entry that IS-A `top` — the kernel's `reference` included, which
stops being a dispatched special case and becomes ordinary. Revision 34's separate "level discipline"
rule disappears into the placement rule: constructorness now propagates through composition and
refinement, so an ordinary schema that composes with a constructor has _ipso facto_ declared an entry
that IS-A `top`, and placement refuses it. One check where there were two.

Atom refinement's test is easy to get wrong, and the spec calls it out: it asks whether the body **is
an atom application** (`!integer_type {}`) rather than the constructor's own vocabulary record. It is
not an IS-A `atom` check — IS-A `atom` is true of the constructor and false of every instance, the
opposite of what a reader expects — and it is not a kind check.

### WP4.3 — Open entries, and kind derived (§5.10, §8.1)

An open entry is a `type_definition` whose `body` is a `!template` instance holding its parameters and
its application as text. `compiler/heldBody.ts` becomes a parser and cache over that text rather than
the sole implementation of a structured held body. Parse per closure; do not cache every one forever.

A template closes by application and never by construction: `template` is resolver vocabulary, nothing
is ever typed by it, and a source declaration applying it directly is a resolver error — `<…>` is the
authored spelling of an open entry.

Kind is computed by the four-branch rule and never written. One narrower change rides along: a
parameter with no kind-determining use is now a type parameter by default, where Revision 34 made it
an error outright.

### WP4.4 — A restatement's annotations merge (§5.8)

New rule, not a rewording. A restated field — in composition or refinement, elided-type restatements
included — carries its own annotations in source order, followed by the inherited field's in source
order. Nothing is dropped, there is no per-name dedup, and the restatement leads, which is what
decides "first occurrence" for a rule like `@rest`'s at-most-one-per-chain.

`definitionResolver.ts`'s `resolveField` takes only the restatement's own annotations today.

### WP4.5 — Facet narrowing (§5.7)

Value tightening is per facet kind, and Revision 35 adds a **step** kind (`multiple_of`) and gives the
**selector** kind a family-specific narrowing relation where it previously had none. Four facets carry
selectors:

- `integer_type.size` — a width chain.
- `complex_type.component` — a partial order: `INTEGER ⊂ NUMBER ⊂ RATIONAL`, `FLOAT32 ⊂ FLOAT64`,
  exact and approximate incomparable.
- `float_type.format` — narrows along its own order.
- `bytes_type.encoding` — **no relation at all**. An alphabet narrows nothing, so
  `hexbytes => !bytes ^ { encoding: HEX }` claims an IS-A carrying no narrowing and is a resolver
  error. Another alphabet means a fresh instance, never a refinement.

`compiler/atomNarrowing.ts` states in its own doc comment that there is no generic helper for selector
facets because they are identity-only after being set. That comment is now wrong for three of the
four, and the file is the right home for the relations.

### WP4.6 — Value-typed facets, and sparse member sets (§5.2, §7.4)

A `value`-typed facet is the token, uninterpreted, read by the type the position hands it to — the
resolver reads it under the atom the slot stands for, once that atom is in scope, and stores the
result. `1` and `1.0` at `decimal_type.min` are one number, not an integer beside a float. Base type
resolution is explicitly _not_ the fallback here; it applies in schemaless documents only.

Sparse member sets follow from that: `integer_type.members` and `decimal_type.members` hold values
read under the constrained atom before the set is formed, so `[1 1.0]` is a duplicate caught at schema
load. A body's facets must also cohere — every member of `members` satisfies the body's other facets,
so `{ members: [443], size: { bits: 8 } }` fails — and that check runs again at materialisation when
the members come from a template parameter.

### WP4.7 — Network facets are applied (§5.5)

`within` and `excluding` exist as fields on `Ipv4Type`, `Ipv6Type`, `Cidr4Type` and `Cidr6Type` today
and are never enforced. Revision 35 states the semantics and adds a schema-load obligation: the pair
MUST admit a value.

- An address is inside at least one `within` network when the field is present, and inside no
  `excluding` network.
- A network must be a subnet of at least one `within`, and must not **overlap** any `excluding` —
  overlap, not containment, so a wider value cannot smuggle an excluded block through.
- Prefix bounds are part of the same question: `max_prefix` caps from above and interacts with
  `within`.
- Coherence MUST be decided exactly rather than pairwise. CIDR blocks nest or are disjoint and never
  partially overlap, which is what makes an exact prefix-tree cover tractable.

A CIDR value becomes a network value rather than retained text, which is what lets each family judge
its own facets.

### WP4.8 — Aliased argument identity (§5.7, §8.2)

Of the three ways to name a type after another, only a reference is transparent to template-application
identity: `box<user_id>` over `user_id => uuid` denotes the same type as `box<uuid>` and mints the same
entry. A refinement (`box<!uuid ^ {}>`) and a fresh instance (`box<!uuid_type {}>`) each keep their own.

Argument identity therefore follows reference chains to their terminal entries when computing the
canonical application. This closes `STATUS.md`'s known gap that a value type-argument's identity
compares spelling rather than value equivalence — the same gap, now with the spec stating the rule.

### WP4.9 — Schema-side resource limits (§11.5)

A new section with no Revision 34 analogue: import closure 64, entries per schema map 65 536, reference
chain 64 hops, supertype chain 64, materialisation depth 64. Exceeding one is a **limit refusal**, not
a resolver error, reported with the limit name and the configured threshold. §2.2.3 adds a conformance
MUST for enforcing them on [TSON-DATA] §9.1's terms.

## Stage 5 — Scoped values (§7.8)

One or two Sonnet packages, and the highest-risk stage. Escalate to Opus if two repair attempts do not
make the gate green.

The port parses a scoped value and round-trips it through every reader and writer, but nothing acts on
it — no code switches the governing schema on descent and reverts on exit. Revision 35 makes that a
real feature and rebuilds the vocabulary around it. `extern` and `unknown` are both replaced by one
kernel constructor:

```
scope_kind => !enum [LOCAL EXTERN]
scoped     => sum & { scope: set<scope_kind>  schemas: {uri => [type_name;1..]?; 1..}? }
```

Core declares `declared` (`[LOCAL]`), `extern` (`[EXTERN]`), `dynamic` (`[LOCAL EXTERN]`), and the
templates `extern_of<S>` and `extern_type<S, T>`.

`dynamic` is narrower than the `unknown` it replaces: the value must still name a type and validate
against it in full, drawn from either namespace. Revision 34's `unknown` accepted any well-formed value
with no constraint.

Dispatch becomes uniform, by declared `scope` membership and value shape: `!!schema` present → EXTERN;
`!type` alone → LOCAL; neither → a validation error in every mode. Which positions admit a nested
`!!schema` is now derived structurally from whether the position's type resolves to a `scoped` instance
carrying EXTERN, replacing Revision 34's fixed list of permissive types. And a schemaless document
opens no schema scope of its own, so a nested `!!schema` inside one is a validation error.

The foreign-schema count is a §9.1 limit, defaulting to 16, which needs a lookup seam the compiler can
hand to each compile it performs.

Five corpus vectors under `class2/validate/` depend on this stage, plus the two `scoped-host.tn` /
`scoped-claim.tn` fixtures.

## Stage 6 — Resolved-output writing

One package. The writer follows Stage 3's model: no `kind`, `disjoint` inside the `!choice` body, no
`parameters`, a template body written as text, no `@alias` and no use-site collapsing, `!bytes`.

**Gate:** `bundled-schemas-resolve.test.ts` green against the re-vendored `spec/m/*-resolved.tn`, and
the seven `class2/schema/valid` resolved-form sidecars matching.

The `!set` versus `!array` divergence this port reports upstream (see `CLAUDE.md`, "Spec feedback")
survives the revision and stays reported — Revision 35 does not settle it.

## Stage 7 — Runner, sweep, documentation

`RUNNER.md`'s contract is unchanged; the only diff is the revision segment in a prose example. The
runner work is therefore data, not rules:

- `test/conformance/bundled-ids.ts` to `/2026/35/`.
- Discovery expects 277 subjects.
- The vocabulary type table gains `period`; `duration`'s expected value becomes a bare `decimal`
  count of seconds rather than a `{period, clock}` pair.
- `base_value` drops its `null` member — three classes, matching §4.
- Six new fixture schemas load: `scoped-host.tn`, `scoped-claim.tn`, `validate-binary-identity.tn`,
  `validate-bounds.tn`, `validate-ports.tn`, `validate-precision.tn`.
- One new category instance to watch: `a-constructor-marker-is-not-grammar` is parser-shaped and
  asserted as `resolver`, which the existing layer-aware rule already covers — confirm the harness
  does not read it off the internal diagnostic.

Then the sweep: `/2026/34/` → `/2026/35/` across roughly 25 test files, `README.md`, `config.ts`'s
doc comment and `skills/tson-ts/`; version both packages 0.35.0; refresh `STATUS.md`, `CLAUDE.md` and
`IDIOM-DEBT.md`.

`ORCHESTRATION.md` and `.claude/agents/tson-porter.md` both still tell an agent to check for 146
discovered vectors. That has been stale for two revisions and misdirects every agent that reads it;
fix it in this pass.

**Gate:** the full CI list in `CLAUDE.md`, in order, green.

## Scope decisions

Three things Revision 35 raises that this plan deliberately does not build. Each is a judgement, not
an oversight, and each belongs in `STATUS.md`'s known gaps.

**§9.1's twelve resource limits — build the mechanism, match the reference's coverage.** The section is
rewritten from two SHOULD-level sentences into a table of twelve named limits with defaults, and
exceeding one MUST be reported as a refusal — §8.1's fifth outcome, which now covers resource limits
alongside name hygiene rather than name hygiene alone. The reference implements `maxDepth` and leaves
the other eleven. This port carries one depth bound defaulted to 512.

Build the refusal machinery and the depth limit at its spec default of 64, and build the expanded
refusal report, which is a new MUST: a refusal-bearing report carries the UCD version, the identifier
policy and the token policy it was judged under, and a processor SHOULD make those available with no
document in hand. Record the other eleven limits as gaps. `CLAUDE.md` holds that structural parity is
worth more than idiom while the reference moves, and the same argument applies to coverage: a limit
this port enforces and the reference does not is a divergence nobody asked for.

**The §6 JSON reader — out of scope.** Revision 35 deletes the JSON-superset claim, states plainly
that a JSON document is not a TSON document, and replaces the claim with a distinct JSON reader: a
second encoding of the same model, mapping JSON `null` to absence and a non-identifier-keyed object to
a map rather than a record. Neither implementation has one. What this port must do now is stop
claiming the superset — `README.md` and `skills/tson-ts/` both assert it — and record the reader as a
gap.

**`@Unbound` — nothing to port.** It exists in the Java so `TypeDefinition.kind` can be computed at
resolution for the resolver's own use and never written. Here a `Binding` is bidirectional by
construction, so leaving `kind` out of the binding does the same job with no annotation. The Java's
`@Unbound` is a binding-layer mechanism and appears nowhere in either spec part.

## To report upstream

- The corpus's `REVISION` file reads `33` while the corpus is baselined at Revision 35.
- `ltr8-io-tson-java`'s `CLAUDE.md` still links `/2026/34/` for both spec parts in its Project
  section, although its own `spec/` now holds Revision 35.
- §4.1's applicability condition is reworded to key on the document header carrying no `!!schema`.
  Read against §3.3 and §7.8, it is not clear whether base resolution still applies to the unscoped
  values of a document that pushes a scope on one element. Almost certainly yes; the prose does not
  say so.
