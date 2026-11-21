# Revision 40 plan

Taking this port from 2026 Revision 39 to Revision 40. `ORCHESTRATION.md` says how a run is driven:
one manager, `tson-porter` sub-agents writing every line of implementation, and a gate between
stages. That shape is unchanged. This file says what the stages contain, and why. Each stage below
**is** the brief its porter receives.

Read `CLAUDE.md` first. Its hard constraints bind every agent in every stage. The change list is
`spec/tson-rev40-changelog.md`. **Its §4 is the net change from Revision 39, arranged by what an
implementer touches** — read it whole before anything else; §4.10 (migration notes) and §4.11 (what
is lost) say what a Revision 39 document rewrites to. §3 holds each change item by item (cite items
as "§3.2 item 107"), and §5 the rulings. The register those items dispose of is the reference's
`SPEC-FEEDBACK.md` (`.references/ltr8-io-tson-java/SPEC-FEEDBACK.md`). The reference's `design/`
notes each open with the invariants of their area; `parametric-records.md`,
`parametric-materialisation.md`, `desugaring-forms-over-parameters.md` and `externs.md` are new in
this revision, and `held-template-bodies.md`, `template-materialisation.md` and
`desugaring-open-forms-and-templates.md` are gone with the concepts they described.

**The reference is pinned on its proposal branch** (`r2026-40-proposal`), not `main`: Revision 40 is
proposed, not adjudicated, and a few small changes may still follow. Keeping the port's structure
parallel to the reference (`IDIOM-DEBT.md`) is what makes those a diff to read, so where a choice is
open, prefer the reference's shape.

## What moves

|                      | Revision 39                                     | Revision 40                                                      |
| -------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| `JAVA_PIN`           | `c48b744707128531e82cfe87b0fd584a2e26bc8f`      | `7fe582759319d60a28df613a669d36362281f9f2` (proposal branch)     |
| `SUITE_PIN`          | `fb8757fb2e4ed947e0446a8de247145f990de905`      | `3d769b5999bbe118f400d6e6f4f6e2e6bb3ace63`                       |
| Conformance subjects | 944 (Class 1 316, Class 2 628)                  | **1438** (Class 1 319; schema 516, link 222, validate 381)       |
| Spec vendored        | Parts 1–3, Rev 39 change log, `m/`, `fixtures/` | Parts 1–3, **Rev 40 change log**, `m/` (six), `fixtures/` (five) |
| Bundled identities   | `tson.io/2026/39/m/*`                           | `tson.io/2026/40/m/*`                                            |
| Package version      | 0.39.0                                          | 0.40.0                                                           |

The reference moved 74 merges (+36.3k/−26.5k over 728 files). The corpus added 494 subjects, almost
all Class 2. **This revision does not change the lexer.** It takes both of Revision 39's value forms
back out of the data grammar, and it rewrites parametric records, inline types, dependent fields,
references and record derivation, adds open construction and the extern, and reshapes the kernel
(83 entries; 11 removed, 7 added, 14 changed — change log §4.3).

Measured at Stage 0: Class 1 **315/319** (four parser vectors: an argument list or `kind!` in a data
value must now be a parse error); Class 2 **0/1119**, every one because the kernel no longer
bootstraps (`meta.set_type` is an incomplete entry, `!meta.array ^ { … }`, and the resolver applies
it as a template). 353 of 3496 unit tests fail.

## Stage 0: pins and vendoring (done)

Both pins moved; `spec/` re-vendored — Parts 1–3, `tson-rev40-changelog.md` replacing 39's, the six
schemas under `m/`, the five resolved fixtures under `fixtures/`; the stdlib constants regenerated
(`npm run gen:stdlib-schemas`); every `/2026/39/` identity in code, tests, docs and the harness's
bundled-identity table moved to `/2026/40/`; both packages versioned 0.40.0 (lockfile edited by hand,
never by `npm install`, per `CLAUDE.md`).

## Stage 1: Part 1, the policy rename, and the harness

### WP1: the data grammar and the processor policy

Part 1 §1.3, §1.5, §2.1, §2.3, §2.4, §2.6, §3.2, §4.1, §7.1, §7.2, §7.2.5, §7.4, §7.5, §7.7, §8.2,
§9.1; change log §3.1 whole, §4.1, §4.8, and §3.4 items 7–10 and 14 for the JSON string at a
reference. Read `design/lexer-and-data-parsing.md`, `design/tree-model.md`,
`design/facades-and-tree.md`, `design/writers-and-document-header.md`, `design/references.md`,
`design/processor-policy.md`, `design/conformance-suite.md`. Java (diff each against `c48b7447`):
`TsonDataStream`, `TsonDataParser`, `TsonDataEmitter`, `TsonTreeWriter`, `TsonTreeReader`,
`stream/ReferenceEvent` (gone), `tson-atom/ReferenceGrammar.java` (the argument-list grammar is
gone; what remains is the qualified-name grammar), `tson-atom/parser/{RefParser,TypeNameRefParser}`
(gone), `tson-tree/{TsonReference, TsonApplicationReference, TsonSiblingReference}` (the latter two
gone), `reader/SchemalessTreeReader`, `tson-base/policy/{ScriptPolicy → TokenPolicy}`,
`LimitsPolicy`, the conformance runner `tson/src/test/.../ConformanceSuiteTest.java`.

- **No argument list in a data value** (§4.1). `core-value` loses `reference`; `<` and `>` are
  reserved again, a parse error wherever a value stands — a field, an element, a map key, a schema
  document's payload read as data, a resolved form read as data. Remove the reference event, the
  application-reference AST/tree nodes, and their writers.
- **No sibling form.** `kind!` in a data value is a parse error by the separator rule (§7.5; change
  log §5 "#6 (ruled)": no targeted rule naming the mark). Remove the sibling-reference value. **The
  schema grammar keeps `dependent-type = unquoted-token "!"`** at a record field's or group member's
  type — that is Stage 2's, in the schema parser; if the schema parser currently reaches the data
  stream's sibling production, keep it compiling with the smallest edit and say so.
- **A Class 1 processor reads no structured reference**: a schemaless read reads a qualified name as
  the token it is (§1.5, §4.1).
- **A quoted token at a position typed by a reference is the reference its text spells** (§3.1 item
  22; Part 2 §5.12): each segment a name of the family of what it enters, quoted exactly when a
  segment holds a character outside the token profile. If the decision lives in the schema-directed
  reader (`reader/tree/atom.ts`, `schema/referenceAtoms.ts`), make the read accept the quoted form;
  the walk's family rules (items 117–118) are Stage 2's.
- **The JSON string at a reference** holds a qualified name; `"set<text>"` and `"kind!"` are outside
  the grammar (§3.4 items 7–10, 14). Only the reference-string parse in `json/`; everything else in
  Part 3 is Stage 3's.
- **`policy.script_policy` is `policy.token_policy`** (§3.1 item 23), and the two loosest
  restriction levels judge a token alike (item 24). Rename through `unicode/policy.ts`,
  `unicode/restriction-level.ts`, `config.ts`, `index.ts` exports, the JSON token-hygiene reader,
  and `packages/cli/src/policyNode.ts` / `tson policy`.
- **`policy.limits.max_materialisation_depth` goes** (§3.1 item 4; Part 1 §9.1): remove the limit
  from `core/limits.ts`, `config.ts` and the policy reader. The resolver's materialisation code that
  consults it is rewritten in Stage 2; delete the consultation (or hard-code nothing) with the
  smallest edit that compiles, and say where.
- **The harness** (`RUNNER.md` diff between the pins). Rule 6 is gone: **stop normalising a
  `_[0-9a-f]{8}` suffix** — no entry is minted any more, so nothing has one. An extern's schema is
  served by the same fixture rule as an import; a reference reaching the subject's own `!!id` is a
  cycle, never served (`fixtures/cycle-*.tn`). An expected resolved form lists complete entries only,
  and the runner compares each key's `@meta.completion` as it compares `@meta.application`. These
  Class 2 parts are judged at Stage 2's gates; make the harness say them now. Read `RUNNER.md` whole
  for anything else that moved.

**Touch nothing under `compiler/` (except `dataParser.ts`, `dataValueEvents.ts`,
`dataValueGrammar.ts`, `cursor.ts` where the data productions live), `schema/meta/`, `link/`, or
`ast/schema/`** beyond the smallest edits that keep `tsc` green, each named in the report. Stage 2
rewrites them.

**Gate:** Class 1 **319/319**; 1438 discovered; Class 2 still 0 (the kernel) and no new kind of
Class 2 failure introduced by the harness changes; unit tests: no test that passed at Stage 0 fails,
except tests asserting Revision 39's data forms, which are rewritten to Revision 40's (a test of an
argument list in data becomes a test that it is refused). typecheck, lint, format:check clean.

### Stage 1 outcome

WP1 landed; the gate holds. Class 1 **319/319**, Class 2 0/1119 (every one the kernel's
`meta.set_type` failure), 1438 discovered; unit tests 353 failing of 3476, the same set as Stage 0
by name (the net −20 are argument-list and sibling tests rewritten as refusals). What Stage 2
inherits:

- **The schema parser still reads payloads with the data grammar** (`parseCoreValue`), which now
  refuses `set<text>` and `kind!`. WP2A writes the schema grammar's own payload reading. The local
  `marksSibling`/`siblingField` in `compiler/schemaParser.ts` stand for `dependent-type`.
- **Placeholders to replace:** `schema/referenceAtoms.ts`'s `referenceToWire`, `compiler/desugar.ts`'s
  `refValueOf` and `compiler/wireForm.ts` write an application or a dependent type as token text
  (`pair<uuid B>`, `kind!`); `wireForm.applicationIn` returns `undefined`; `compiler/templates.ts`'s
  materialisation backstop is a bare constant 64 (the policy limit is gone). All die with WP2A/WP2B.
- **`ast/reference.ts`** keeps `Reference`/`ApplicationReference` for the schema model only; the data
  value model has no reference (six core-value kinds).
- **Segments after the first** are still judged as identifiers by the atom parsers; the
  family-by-family walk (items 117–118) is WP2B's.
- **The harness**: names compared as written (rule 6 gone, `synthetic.ts` deleted); `resolvedForm.ts`
  has an `isIncomplete(linked, name)` hook returning false until the model has incomplete entries,
  and compares `@meta.completion`. It never compared `@meta.application`; WP2A adds that when output
  carries it. A `fixtures/cycle-*.tn` subject's own `!!id` is not served (a `not-found`, a
  non-verdict): the cycle verdict must come from the library treating a reference to the subject's
  own identity as a cycle before fetching — WP2D's.
- `@ltr8/tson-cli`'s exported `ScriptPolicy` alias is now `TokenPolicy`.

## Stage 2: the kernel and the type system

Four packages, run **in sequence**: they share the schema model, the resolver, the linker and the
compiled readers. Each package's gate is that the previous packages' vectors stay green and its own
named vectors go green. Class 2 vectors are listed by directory in the corpus; a package's report
names the vectors it moved and those it left, by name and reason.

### WP2A: the schema grammar, the kernel model, inline types, the bootstrap, and resolved output

The package that makes the kernel and the five libraries load again and match their resolved
fixtures, which needs most of the new kernel's machinery at once. Change log §4.2, §4.3, §4.4, the
"Inline types" and "Open construction" blocks of §4.5 as far as the kernel and libraries need them,
§4.6's resolver-output bullets; §3.2 items 33–57 (#5), 58–69 (#6's grammar and kernel), 84–100
(references and applications), 103–109, 113, 123, 132, 133, 136. Read `design/schema-grammar.md`,
`design/schema-grammar-and-desugaring.md`, `design/resolver-vocabulary-and-bootstrap.md`,
`design/schema-resolution.md`, `design/constructor-application.md`, `design/kinds-and-name-types.md`,
`design/linking-and-compilation.md`, `design/class2-compilation.md`, `design/references.md`. Java:
`TsonSchemaParser`, `resolver/{SchemaDesugarer, SchemaResolver, DefinitionResolver,
KernelBootstrapResolver, ConstructionSugar, ConstructionRewrite, IncompleteEntries, WireForm,
WaitOrder, NameType}`, `schema/meta/{TypeInline, RefBody, RecordBody, TypeSlots, EntryDisplayName}`
(and the deleted `ReferenceBody`, `RecordTemplateBody`, `RecordTemplateField`, `EntryKind`),
`TsonSchema`, `TsonCompiledVocabularyRegistry`, and the test `ResolvedFixtureTest`/`ResolvedForm`.

#### Grammar (Part 2 §12)

- `refined-def` goes: `^` follows `!name` alone; `name ^ {`, `name<args> ^ {` and `^` after a name at
  a type slot are parse errors naming `name & { … }` (item 108).
- `field-type = type-expr ["?"] / dependent-type`, `dependent-type = unquoted-token "!"`;
  `group-member` takes a `field-type`; `[ kind! ]`, `box< kind! >`, `( kind! | text )`, `x => kind!`
  are parse errors (items 59, 61–62, 66, 69).
- `brace-type = map-type / record-def` at a type slot (a record body may stand there); `{ {`, `{ [`,
  and `&`/`^`/`-` after a field's type are parse errors (items 71, 75–76).
- `type-arg = type-expr`; no `value-literal` (a number or quoted token is no argument);
  `size-bound` is decimal-natural; `map-key = type-ref` (items 14, 30, 43, 55).
- The application is schema grammar, `<` adjacent (§12.3 row). `type-params` parse before any body;
  the resolver admits them before a record body alone (item 30). `!C ^ { values }` is a form (item
  106).
- A definition mark (`abstract`, `final`) stands before a record definition alone — braces, a
  composition or a subtraction; before `!`, a type expression or a declared application it is a
  parse error (item 136).
- The schema parser's application grammar is its own now that the data grammar has none
  (`compiler/schemaParser.ts`, `cursor.ts`); `atom/referenceGrammar.ts` keeps the qualified name.

#### Model (`schema/meta/`)

The kernel's entries per change log §4.3, read off `spec/m/meta.tn`:

- **Removed:** `meta.template`, `meta.template_param`, `meta.record_template`,
  `meta.record_template_field`, `meta.record_template_field_map`, `meta.tuple1`,
  `meta.voidable_tuple1`, `meta.synthetic`, `meta.field_type_ref`, `allow_sibling`,
  `meta.reference_type`, `meta.field_name`.
- **Added:** `meta.param`, `meta.type_inline` (`{ of: meta.type }`), `meta.type_expr`
  (`@meta.disjoint ( meta.type_ref | meta.type_inline )`), `meta.dependent` (final, `on: text`),
  `meta.apply` (final, `head`, `arguments`), `meta.completion` (annotation), `meta.extern` (model
  and kernel entry only; the semantics are WP2D's).
- **Changed:** `meta.record` gains `parameters?: [meta.param; 1..]` (the model only; materialisation
  is WP2B's); every type slot that may hold a type in place is `meta.type_expr`
  (`record_field.type`, `array.element_type`, `map.value_type`, `tuple_element.element_type`,
  `choice.variants`, `type_chain.parents`); `meta.ref => meta.atom & { of: meta.type_ref }` is the
  one reference constructor, `meta.type_ref => !meta.ref { of: meta.type }`; `@meta.application` is
  a `meta.apply` value; `type_chain.supertypes`/`subtypes` are sets; `meta.namespace` is
  `meta.map & { … }`; the derived kind label goes (item 132; a consumer reads kind from the
  constructor); `discriminators` requires `extension: ABSTRACT` (item 133).
- `meta.field_name` removal: a record stating no name type has `meta.identifier`'s (item 123).
- `temporal`'s `precision` is `fraction_digits` (item 113); `policy.token_policy` was Stage 1's.

#### Inline types (#5)

A type slot holds a name or a type written in place; **nothing is lifted, minted or merged**. Sugar
(`[T]`, `{K => V}`, `T?` where it applies, a record body at a slot) and an applied constructor
(`set<text>`, `meta.ref<order>`) at a type slot resolve in place to `{ of: !C { … } }`. Delete the
synthetic machinery: `compiler/{syntheticMerge, internalName, mintedNames, derivedName}.ts`,
`link/importedSynthetics.ts`, `@meta.synthetic`, comparison up to renaming. A type written in place
has no name, no chain, no parameters, IS-A nothing, is named by no tag and is a member of nothing; a
name and a type in place are never one type; two equal types in place are one (items 33–57, 70–76).
A diagnostic locates a type in place by its field path (item 52).

#### Open construction, as far as the kernel needs it (#10)

`!C ^ { values }` over a constructor declares an **incomplete entry**: no type and no value,
completed by `!X { … }`, `!X value` or `X<A …>`, refused wherever a type is named, not written in
resolver output; a declared completion carries `@meta.completion` (items 106–107, 109). The kernel's
`meta.set_type` and `enum` are incomplete entries and `set` an alias of `meta.set_type`, so
`!meta.set_type { element_type: integer  min_items: 1 }` and `!enum [A B]` are completions.
`C<args>` over a constructor is construction over its argument slots — the required fields with no
default or pin that hold a type, in declaration order — and over an incomplete entry completes it.
The full rule set (refusals at each type-naming position, field-written-twice, `^` refining
collection types, record refinement's removal) is WP2C's; take what the kernel, libraries and their
fixtures need, and the parts that fall out naturally.

#### Bootstrap, resolution and output

- The kernel bootstraps; `numeric`, `temporal`, `net`, `core`, `policy` load; **all five
  `spec/fixtures/*-resolved.tn` compare equal** in written form (the applied-head rule in
  `CLAUDE.md` still holds: a closed entry is written under the constructor recorded in its facts).
  Resolver output writes no synthetic entry, no incomplete entry, no kind label; a type in place as
  `{ of: !C { … } }`; `@meta.completion:{ of: [...] }` on a completion's key;
  `@meta.application:{ head: …  arguments: […] }`.
- `meta-resolved.tn` writes 80 entries; the wait cycle around `meta.record` holds 31 entries and its
  closure 66 (§4.3) — useful assertions.

**Gate:** kernel and libraries load; the five resolved fixtures match; Class 1 stays 319/319; the
Class 2 count rises substantially (report it by layer, and list the failing vectors grouped by the
package below that owns their rule). Unit tests for removed concepts (templates as their own
constructor, synthetics, sibling references in data) are deleted or rewritten to Revision 40's
rule, never skipped.

### WP2A outcome

The kernel bootstraps; the five libraries load; all five resolved fixtures compare equal in written
form. Class 1 319/319; Class 2 **783/1119** (schema 410/516, link 160/222, validate 213/381); unit
tests 40 failing of 4052, all on closing or composing an application. The synthetic machinery,
held template bodies, record templates, `meta.reference_type`, `allow_sibling` and `ast/reference.ts`
are deleted; `compiler/{constructionRewrite,constructionSugar,incompleteEntries,parameterBounds}.ts`
and `schema/meta/typeInline.ts` are new; the harness compares `@meta.application`. Readings to
confirm: an alias of a value entry is admitted (§8.3); a value read at a type in place carries no
tag in the tree; a default or pin on a field typed in place only on a reference (item 42); a
reference's `of` refuses incomplete entries and parametric records (§4.2); parametric records are
left out of `subtypes`. What the remaining 336 Class 2 failures need:

- **WP2B (183):** closing an application in place (held as `{inline, of: ApplyBody}`), a declared
  application, an operand application and `<T> !meta.record { … }` (each `NotImplemented`, so no
  `@meta.application` is produced) and the rules a use-site application breaks — 166; held
  recursion — 3; references and qualified names (items 117–118, spaced and decomposed segments,
  segments in the family's form) — 14. `ParameterTypes.checkSlots`'s walk is not ported;
  `compiler/heldValues.ts` survives in its smallest form for dependent held values.
- **WP2C (99):** `!T ^` over an array, map or namespace type (`NotImplemented`) — 54; facets
  (exclusive bounds, the offset-carried instant bound) — 24; choices (items 125–129, a nested choice
  disjoint) — 12; an incomplete entry's per-field read (it holds only the written value) — 5;
  other (an enum `name_type` restated through an alias, a subtraction's restatement, item 101, item 111) — 4. `asWritten` restores annotations only at a record-in-place's top level.
- **WP2D (52):** externs. Also the two import-cycle vectors (`a-schema-importing-its-own-identity`,
  `two-schemas-importing-each-other`): preload detects no cycle and reports `SCHEMA_NOT_FOUND`.
- **Stage 3:** the JSON reader neither refuses a tag at a position typed in place nor drops its
  type name, and a record in place with its own `name_type` gets no reader name type in either
  encoding.

### WP2A review: repairs, after WP2B

An adversarial review of `439026f` against the spec and the reference. Repaired in one pass once
WP2B lands, since most of it is in files WP2B owns:

1. **An alias of a value entry is refused** (the reading above was wrong). `meta.alias.target` is
   a `meta.type_ref`, whose `of` is `meta.type`, so a value entry's name is no member; the reference
   refuses it (`TsonSchemaLinker.validateTypeRef`, `target instanceof ValueEntry`). Judge the
   terminal entry past alias hops, not only the immediate target
   (`link/referenceValidation.ts`, the `alias: true` path returning before `isValueEntry`). Today
   `o => orders` over a value entry loads and a field typed `o` reaches a `NotImplemented` — a
   non-verdict where the reference gives a verdict.
2. **The schema parser's type-argument path skips the nesting guard**: `parseTypeArg` reaches
   `parseChoiceRef`/`parseBracket`/`parseBraceType` and the `name<` path without `nested()`, and a
   record body can now be an argument, so `{ f: a<{ f: a<{ …` overflows the JS stack instead of the
   §9.1 nesting-limit parse error. Route every structural descent through the guard; add a test.
3. **Two equal types in place compare by `JSON.stringify`** (`schema/meta/typeInline.ts`), so key
   order decides identity. Compare canonically (the reference uses record equality).
4. **Tests that accept any error**: `test/schema-read-helpers.ts`'s `loadError` returns any
   message, `TsonNotImplementedError` included, and six assertions in
   `parametric-records.test.ts` check only `toBeDefined()`. Assert the class or the message.
5. **Dead Revision 39 text**: `bundled-schemas-resolve.test.ts`'s `canonicalName` still normalises
   `_[0-9a-f]{8}` (remove: names compare as written), its `parsedTemplate`, `MONOMORPHIC` set and
   `@synthetic` docs; comments naming deleted files or concepts in `compiler/tokenForms.ts`,
   `schema/meta/typedef.ts` (`@application` is a `meta.apply`; no "type-argument's literal"),
   `definitionResolver.ts` and `link/fieldNameRule.ts` (the kernel's `field_name` is gone),
   `write/bindingWriter.ts` (`meta.field_type_ref`), `test/conformance/resolvedForm.ts`
   (`!meta.template`); `json/schema/record.ts`'s diagnostic showing `'field_name'`;
   `schemaParser.ts`'s "`refined-def` is gone" narrates history.
6. **`size-bound` is not judged as `decimal-natural`** (§12.1): `[text; 0x10]` loads with
   `min_items` 16. The reference defers to `min_items` too; judge it in the parser, and correct
   `ast/schema/fields.ts`'s claim that desugar checks it. Report upstream.

Shared with the reference, to report rather than diverge on: an explicit `!meta.alias { target: C }`
cannot be applied (`desugar.ts checkApplication` / `SchemaDesugarer.java:587`), against §8.3's "the
explicit spelling of the alias … applied as its target is"; and a parameter's bound naming an alias
of a constructor, a value entry or a bare parametric record passes (`parameterBounds.ts` /
`ParameterTypes.java:218`), against §5.10.

### WP2B: parametric records and applications (#3, #18, #20; references #2, #14, §5.12)

Change log §1's six steps, §4.5 "Parametric records", "Applications", "References and qualified
names"; §4.6; §4.10's parametric-record notes; §3.2 items 2–32, 77–83, 84–102, 117–118, 130, 131, 135. Read `design/parametric-records.md`, `design/parametric-materialisation.md`,
`design/desugaring-forms-over-parameters.md`, `design/references.md`. Java: `resolver/{
ParametricMaterialiser, ParameterTypes, HeldRecursion, ParametricRegularity, FamilyJoiners,
ConstructionSugar, ConstructionRewrite, DefinitionResolver}` and the deleted `TemplateMaterialiser`,
`RecordTemplateSubstitution`, `HeldBody`, `TemplateRegularity`, `MetaRefs`, `NumericIdentity`;
`TsonSchemaLinker`, `ValuesByName`, `RecordExtension`, `TypeInhabitance`.

- A parametric record is a `meta.record` with `parameters`; nothing else takes parameters. Delete
  `compiler/{templates, templateSubstitution, heldBody, heldValues, numericIdentity}.ts` in favour
  of the reference's shape (`parametricMaterialiser`, `heldRecursion`, `parametricRegularity`,
  `familyJoiners`, …), keeping `IDIOM-DEBT.md`'s parallel-structure rule.
- A parameter is a type, standing at a field's type, any slot of a type in place there, or as an
  argument of an application at either or in a parent; anywhere else a resolver error naming the
  slot. A field typed by a parameter takes no value and is no selector. A bound is written, never
  inherited, names a type (never a constructor or incomplete entry); a parameter passed to a bounded
  one carries a bound that IS-A it.
- `H<args>` over a parametric record is `meta.apply`: declared, the substituted record under that
  name (`@meta.application` on the key); at an operand absorbed; at a type slot closed in place,
  never looked up; over a parameter it stays `meta.apply` until the holder is applied. An argument
  is a name or a parameter — a sugar form, an applied constructor or an application as an argument
  is refused. No application is IS-A its head; no position, reference, operand or `subtypes` index
  names a parametric record bare; `final` on one is refused; a family is an abstract base, a
  parametric record composing it, and members composing a declared application. An alias of a
  parametric record is another name for it (item 135).
- A recursive application ties to the declaration closing it and is refused where none does; a
  parametric record that could never close is refused at its declaration; closing holds each
  parametric record at most once on a path (replacing the materialisation-depth limit).
- References: `meta.ref` is the one reference constructor and `of` says types or values; a
  qualified name is the text of one token of either form split at `.`, each segment a name of the
  family of what it enters; a namespace `key_type` or record `name_type` admitting `.` is a resolver
  error (items 117–118). A tag naming a parametric record in data is a validation error.
- The change log §5 "#3 (remainder)" lists what the reference itself does not yet do; match the
  reference, and note any vector that depends on it.

### WP2B outcome, and WP2C's facet slice

WP2B landed; the facet slice of WP2C ran beside it in a worktree and was cherry-picked; the
validate harness took the reference's rule for a `parser`-category vector (the document fails the
Class 1 parse, since a Class 2 read reports base syntax under no category). Class 1 319/319; Class
2 **982/1119** (schema 477/516, link 186/222, validate 319/381); unit 4084/4084. New:
`compiler/{parametricMaterialiser,heldRecursion,parametricRegularity,substitution,
canonicalApplication,restatements}.ts`, `schema/meta/typeSlots.ts`; `parameterBounds.ts` became
`parameterTypes.ts` with `checkSlots`; off-the-chain restatements (applied and subtraction
operands, #962) are judged at link. The harness's resolved-form comparison skips an in-place
node's `application`, a message-only field model identity already ignores. The facet slice added
exclusive bounds on date, time and datetime, a time's instant wrapping at midnight, and one option
per field group in a constructor body (`schema/metaReader.ts`'s `refuseSeveralOptions`; the
resolver's constructor-body check is the better home, and WP2C may move it).

Readings to note: name hygiene on a value's qualified name judges the entry segment only (the
reference judges none); `@meta.application` is found on a direct import's keys only, so an applied
parent two imports away is missed (no vector); a canonical application compares by a string key
(an `IDIOM-DEBT.md` line). `typeInline.ts`'s `applicationsOf`/`parameterIn`/`mapInPlace` overlap
`typeSlots.ts`.

Remaining 137: **WP2C ~74** — `!T ^` over a collection or namespace type (54), choices (11), an
incomplete entry's per-field read (5), an enum `name_type` restated through an alias, item 101
(`FamilyJoiners`, not ported: `a-member-declared-after-the-value-that-selects-it-by-pin-is-waited-on`),
item 111 (2); **WP2D 63** — externs (61) and the two import cycles.

### WP2B review: repairs, after WP2C

An adversarial review of `439026f..e0ed1b5`, with probes. Repaired in one pass after WP2C lands:

1. **Closing in place is exponential** (`parametricMaterialiser.ts` `instantiate`): `r_i => <T> {
a: r_{i+1}<T>  b: r_{i+1}<T> }` then `x => r0<text>` doubles per level (n=18 2.3 s; n≈30 never
   ends). Memoise a closed in-place record by canonical application outside an active recursion —
   a pure function of its key, so no verdict changes. The reference has the same code: report
   upstream (item 29 bounds a path, not the work).
2. **In-place closing has no nesting guard**: a 3000-deep chain of applications throws a JS
   `RangeError` out of `validateSchema`. Bound it and report a positioned schema diagnostic.
3. **Applied-parent edges ignore alias arguments and imported alias heads**
   (`schemaResolver.ts` `completed()`, `appliedParentEdges`): `pet_of<dog_alias>` loses the edge
   `pet_of<dog_type>` gets, against §8.2's "every argument's alias chain followed". Dereference both
   sides. Same in the reference: report upstream.
4. **Regularity and passed-on bound checks read the head as written** (`parametricRegularity.ts`,
   `parameterTypes.ts`): `sw => swap` then `swap => <A,B> { x?: sw<B,A> }` passes where the direct
   spelling is refused; same for bounds through `bx => boxed`. Follow the head to its parametric
   record (§8.3, §5.10: an alias of one is applied as it is), as `heldRecursion.ts` already does.
   Same in the reference: report upstream.
5. **`checkRange` prints `[object Object]`** for a temporal bound (`atomCoherence.ts`): use
   `renderBoundValue`.
6. **Stale TSDoc**: `value/equality.ts` still says `compareTime` does not wrap; `link/restatedFields.ts`
   has two consecutive doc blocks and `checkRestatedFieldTypes` none; `atom/temporal/date.ts` "a a".
7. **Deferred argument checks dedupe by name** (`checkArguments` keys drop `param`): key on whether a
   name is a parameter, as the reference's record equality does.

Upstream only: a refinement switching a bound's strictness (`!p ^ { exclusive_min: 5 }` over `min:
1`) merges to both options and is refused (§5.7's field-wise merge with §5.11); the reference
refuses it too, and no spelling moves an inclusive floor to an exclusive one.

### WP2C: open construction, derivation, dependent fields, choices (#4, #6, #7, #8, #10–#12, #15–#17, #19)

Change log §4.5 "Open construction and record derivation", "Dependent fields", "Choices and tags",
"Other rules"; §3.2 items 58–69, 101, 105–112, 119–122, 125–129, 132–136. Java: `resolver/{
IncompleteEntries, Restatements}`, `RecordExtension`, `DependentFields`,
`reader/{DependentFieldReader, ChoiceReader, NamedDispatchReader}`, `FieldNames`, `TypeInhabitance`.

- The rest of open construction: an incomplete entry refused at a field's type, a variant, a bound,
  an operand of `&`, a reference's `of`, a reference-typed slot, an annotation and a parameter's name,
  and as a tag in data; a field written twice over an incomplete entry refused; `^` that leaves
  nothing open refused.
- `^` follows `!name` and takes values; `&` is the one way to derive a record; `!R ^ { … }` over a
  record is a resolver error naming the composition; a restated field's rules (§5.8; the reference's
  `Restatements`). `!T ^ { values }` refines a type built by `meta.array`, `meta.map` or a constructor
  IS-A either, namespace types included; a type-holding facet is restated by the entry it reaches
  (items 120–121).
- Dependent fields: the type is a sum in place, `{ of: !meta.dependent { on: kind } }`, `kind!` its
  sugar at a record field's or group member's type alone; `on` is `text`; the sibling is typed
  `meta.type_ref` or `meta.type_expr`. Port the reference's reader changes.
- Choices: a tag at a choice names a variant, or a type IS-A exactly one, by the entry it reaches; a
  tag IS-A two and naming neither is a validation error; a choice listed as a variant is disjoint;
  variants compare in order (items 119, 125–129).
- `discriminators` requires `extension: ABSTRACT`; a value placed by its pins waits on each
  declaration that may be its member (item 101); a type value written as data is held to its shape
  alone (item 122); a name in an annotation's value is judged in the annotating document's
  namespace (item 111; the reference does a data document's and not yet a schema document's);
  `net.uuid_type.version` (item 112); the facet changes in the reference's `facets/*` merges
  (fraction digits, exclusive bounds, instant bounds).

### WP2D: the extern (#13)

Change log §4.5 "Externs", §4.8; §3.1 item 21; §3.2 items 114–116, 124; Part 2 §5.13, §7.8, §7.9,
§11.5. Read `design/externs.md`. Java: `ExternHops`, `schema/ExternAdmission`,
`reader/ExternReader`, `writer/ExternTags`, `TsonCompiledVocabularyRegistry`,
`DefaultTsonReadContext`, `TsonSchemaCompiler`.

- `!meta.extern { schema: …  type: … }` names one entry of another schema under a local name: a hop
  judged by its target's identity, naming a type a value can have, sealed against `&`, `-`, `^`, a
  construction or application head, defaults, pins and qualified names through it.
- The foreign schema is a dependency loaded with the imports, on the same library, policy and
  kernel; the reference relation is acyclic; the import-closure count includes it.
- A value at an extern position is read under its own schema, the tag in front of it the enclosing
  scope's (by identity, §3.2 item 124); a diagnostic inside it names the foreign schema and the
  extern. Tree read and validation; binding to host classes is "not implemented", not a verdict, as
  the reference does. The JSON half is Stage 3's.

### Stage 2 outcome

WP2C (with the WP2A review's six repairs) landed in the main checkout; WP2D and Stage 3 ran beside
it in worktrees and were merged onto it. **Conformance 1438/1438**: Class 1 319/319, Class 2
1119/1119 (schema 516, link 222, validate 381). Unit 4285/4285. The one conflict of substance was
the text choice reader: WP2C's tag table (`link/choiceSelection.ts`) takes WP2D's extern variant
names through its `externNames` seam. `Tson.loadSchema` puts a schema in flight under its own
identity before fetching its imports and its externs' schemas; the class2 harness loads through it.

Readings to note: the import-closure limit counts externs (§11.5; the reference counts nothing);
an annotation value of an imported type falls back to a checkpoint read in the document's namespace
when the import's own compile refuses it (the reference always checkpoints); pins compare by token
text (`0xFF` ≠ `255`) in `refuseMovedPins` and `placedByPins`; annotation names in front of a foreign
value are checked against the enclosing scope, their values not read; `size-bound` naming a parameter
is a parse error (§12.1's `decimal-natural`) where §5.3 calls it a resolver error.

### WP2E: integration — the JSON extern, the WP2B review's repairs, and the seams

After the merge, in the main checkout:

- **The JSON extern** (Part 3 §1.6, §3.3, §6.4, §8.2, §8.6, §9.2; §3.4 item 13): a foreign value's
  leading `$type` is the enclosing scope's and every other name the foreign schema's; port
  `json/reader/ExternReader`, the foreign scope and the `$import`-in-foreign-value error. Stage 3
  left `ExactReader.takesWrapper` as the seam; compile gives an extern `notImplementedReader` today.
- **The WP2B review's seven repairs** (above).
- **One choice tally**: Stage 3 wrote `json/schema/choiceSelection.ts` beside WP2C's
  `link/choiceSelection.ts`; the JSON reader uses the link one, extern names included, and the local
  copy goes. Remove `json-choice-subtype-tag.test.ts`'s `TEXT_SELECTS_SUBTYPES` guard (now always
  true), `json/schema/dispatchChoice.ts`'s stale note, and `voidable_tuple1` in
  `json-atom-rules-read.test.ts`.
- **Name hygiene of a record in place** judges its field names under the default profile, not its own
  `name_type`'s (`link/nameHygiene.ts`): `<T> !meta.record { name_type: json_name … }` applied in place
  with an `@id` field is refused at link.
- **Extern seams WP2D left**: `externChecks.ts`'s nested-choice rule and WP2C's
  `checkChoiceVariantsAreDisjoint` may report one choice twice — make one rule; the linker's IS-A
  through hops for restated field types and reference narrowing (`TsonSchemaLinker:2027`, `:2137`)
  and parameter bounds through externs are not ported (no vector) — port them.

## Stage 3: Part 3, the JSON encoding (change log §3.4, §4.7)

Runs beside WP2D in its own worktree for everything but the extern, which follows WP2D's merge.
`$type` naming a parametric record refused; a type in place has no `$type`; `$type` at a choice
names a variant or a type IS-A exactly one; one value, one type name (a wrapper's `$value` carries no
`$type`); a foreign value's leading `$type` is the enclosing scope's (`json/reader/ExternReader`);
the map escape names the variant; sorting leads with annotation members only for records of
`meta.identifier` names; a set described by its facets; a one-position tuple declared.

## Stage 4: CLI and sweep

Beside Stage 3 for what needs no Stage 2 rule; finished after the merge. `strip` shortens
`"40/<library>"`; the CLI's commands follow the reference's; `npm run smoke:cli` green. Refresh
`STATUS.md` (1438 subjects; the gaps the reference also carries, from change log §5's
"remainder" rows), `CLAUDE.md` (revision, counts, the minted-name runner rule removed, the
applied-head paragraph against the new kernel), `IDIOM-DEBT.md`, `ORCHESTRATION.md`, `README.md`,
`skills/tson-ts/`, `examples/web-demo/`, `.claude/agents/tson-porter.md`.

**Gate:** the full CI list in `CLAUDE.md`, in order, green.

## To report upstream

Collected from the stage reports and the reviews above. Each entry says the section, what the
reference does, what this port does, and why. "Same" means the reference's code behaves as the port's
did before its repair, so the finding is the reference's too.

### Spec and reference

1. **Part 2 §12.1, `size-bound = decimal-natural`.** _Reference:_ the grammar is not enforced at the
   bound; the parse defers to `min_items`, so `[text; 0x10]` loads with `min_items` 16. _Port:_ the
   schema parser judges the bound as decimal-natural and refuses `0x10`. _Why:_ §12.1 states the
   production; a hex size is a grammar error, and a bound naming a parameter (`[T; N]`) is a parse
   error too, where §5.3 calls it a resolver error (the two sections disagree on the category).
2. **Part 2 §8.3, an explicit `!meta.alias { target: C }`.** _Reference:_ cannot be applied
   (`SchemaDesugarer.java:587`). _Port:_ the same (`compiler/desugar.ts`'s `checkApplication`).
   _Why:_ §8.3 says the explicit spelling of an alias is applied as its target is; both run the
   other reading, and no vector pins it.
3. **Part 2 §5.10, a parameter's bound naming an alias of a constructor, a value entry or a bare
   parametric record.** _Reference:_ passes (`ParameterTypes.java:218`). _Port:_ passes
   (`compiler/parameterTypes.ts`). _Why:_ §5.10 says a bound names a type and never a constructor or an
   incomplete entry; following an alias to its terminal would refuse all three.
4. **Part 2 §5.10.1 / §3.4.1 item 29, closing in place is exponential.** `r_i => <T> { a:
r_{i+1}<T>  b: r_{i+1}<T> }` then `x => r0<text>` doubles per level (n=18 takes 2.3 s; n=30
   does not end). _Reference:_ the same code; item 29 bounds a path, not the work. _Port:_ memoises a
   closed in-place record by canonical application outside an active recursion (WP2E), a pure
   function of its key, so no verdict changes. _Why:_ a schema is routinely fetched from elsewhere;
   exponential closing is a denial of service the §11.5 limits do not cover.
5. **Part 2 §8.2, an applied parent's edge over aliases.** `pet_of<dog_alias>` loses the IS-A edge
   `pet_of<dog_type>` gets, against §8.2's "every argument's alias chain followed", and an imported
   alias head is not followed either. _Reference:_ the same. _Port:_ dereferences both sides
   (`compiler/schemaResolver.ts`, `completed()`/`appliedParentEdges`) (WP2E).
6. **Part 2 §8.3, §5.10, regularity and passed-on bound checks read the head as written.** `sw =>
swap` then `swap => <A,B> { x?: sw<B,A> }` passes where the direct spelling is refused; the same
   through `bx => boxed` for a bound. _Reference:_ the same. _Port:_ follows the head to its
   parametric record, as the held-recursion check already did (WP2E). _Why:_ §8.3 and §5.10 say an
   alias of a parametric record is applied as it is.
7. **Part 2 §5.7, §5.11, a refinement switching a bound's strictness.** `!p ^ { exclusive_min: 5 }`
   over `min: 1` merges to both options and is refused. _Reference:_ refuses it. _Port:_ refuses it.
   _Why:_ §5.7's field-wise merge with §5.11's one-option group leaves no spelling that moves an
   inclusive floor to an exclusive one; the text should say how, or say it cannot.
8. **Part 2 §5.12, a name in a qualified value reference under hygiene.** _Reference:_ judges no
   segment. _Port:_ judges the entry segment alone. _Why:_ §11.4 names the scopes a name is judged in;
   a qualified name's first segment is a declared name, a later one a field or key already judged in
   its own scope.
9. **Part 2 §11.5, the import closure counts a schema an extern reaches.** _Reference:_ counts
   nothing. _Port:_ counts it. _Why:_ §11.5 and §5.13 say the closure includes every dependency read
   with the imports.
10. **Part 2 §5.2, §5.7, constructor-body pins compared by token text.** _Reference:_ compares the pin a
    constructor body restates, and the pin a value is placed by, as values. _Port:_ `refuseMovedPins`
    and `placedByPins` compare a pin by its token text, so `0xFF` and `255` are two pins there. A
    record's restatement is compared as the reference compares it, at the link, by the inherited
    field's type (`link/restatedFields.ts`'s `changedPin`), so `= 255` over `= 0xFF` is the identity
    case; no corpus vector reaches the constructor-body spelling. _Why:_ the constructor-body
    comparison is token text until it moves to the field type's own equality.
11. **Part 2 §6, §5.12, an annotation value of an imported type.** _Reference:_ checkpoints the read in
    the document's namespace. _Port:_ reads it through the import's own compile and falls back to a
    checkpoint read when that refuses the value. _Why:_ the import's compiled reader is the declared
    type's, and a value naming a name of the annotating document only resolves in the checkpoint.
    Annotation names in front of a foreign value are judged in the enclosing scope and their values
    are not read, as the reference does.
12. **Part 2 §4.1, §5.10, "no parametric record is a type a position names".** The text states the
    refusal on references (§4.1's predicate keeps `meta.record` a type); the port follows the
    reference, so a parametric record is left out of `subtypes` and refused by a reference's `of`.
    Both readings are the change log's own "for confirmation".
13. **Part 2 §5.2, item 42, a default or pin at a field typed in place.** Admitted only where the
    type in place is a reference. A value read at a type in place carries no tag in the tree. Both are
    the port's readings of §5.3 and §7.2, matched to the reference; no vector separates them from the
    alternative.
14. **Part 2 §5.9, §5.11, one option per field group in a constructor body.** The port judges it where a
    constructor body is read (`schema/metaReader.ts`'s `refuseSeveralOptions`); the resolver's
    constructor-body check is the better home. A vector pinning a body that states two options of one
    group would say which phase's error it is.
15. **The corpus, `validate` `parser` vectors (Part 1 §8.1, RUNNER.md).** A `parser`-category
    vector at the validate layer is judged by the subject failing a Class 1 parse, because a Class 2
    read reports base syntax under `VALIDATION_ERROR`, which the runner maps to `validation`. The
    reference lists this as an open backlog entry; the harness rule is the same in both.
16. **The reference's `BACKLOG.md` items the port runs the same way, from change log §5's "remainder"
    rows:** a name in a schema document's annotation value is not judged at link (#8); a dependent
    field whose sibling holds a type written in place is not read by a tree read (#5); a constructor
    composed with `&` that adds no field cannot be applied (#11); five extern points (#13).
    `STATUS.md` lists them as known gaps. The reference closed its #3 remainder (a parametric record
    nothing applies) and the pin half of #11 in `014891681` and `99135120`, and the port with them.

### Ported behaviour the reference's Java fixture test cannot see

17. **Part 2 §8.1, resolved output names the applied constructor.** The port compares written form;
    the reference's `ResolvedFixtureTest` binds the fixture into the value model and compares bodies,
    so two spellings of one body (a head, or a restated field at its default) arrive as one value
    there and cannot differ. A text comparison is the stricter check of the fixtures' own text.

18. **Part 2 §5.2, §11.5, §3.4.1 rule 7, a bound on closing in place.** §3.4.1 says closing "needs no
    bound of its own"; §5.2 lets a processor bound inline nesting and calls exceeding it an error;
    §11.5 calls exceeding a limit a refusal, not a resolver error. The port bounds closing in place by
    `max_nesting_depth` and reports a positioned resolver error, the reference overflows its stack.
    The three sentences need one reading.
19. **Part 2 §11.5, the size of a closed type.** Rule 7 bounds termination, not size: a 40-line
    doubling chain closes to a type of 2⁴⁰ nodes. Memoising the closing (the port does) keeps
    construction linear, but every walk of the written-out type is exponential. §11.5 may want a size
    limit on a closed type, or a rule that closed types are shared.
20. **Part 2 §5.10, §5.13, an argument judged against a bound through an extern.** _Reference:_ judges
    by name, so `box<order_x>` against `<T: order>`, `order_x` an extern of `order`, is refused.
    _Port:_ follows the extern by identity and admits it.
21. **Part 2 §5.8, §4.2, IS-A through an extern in the linker.** _Reference:_ `TsonSchemaLinker`'s
    `isA` (the restated-field and reference-narrowing checks) compares identity and the local chain,
    missing a subtype reached through an extern (`rush_x` against `order`). _Port:_ also reads the
    chain of the entry the extern lands on.

### Divergences that are not spec questions

- **CLI.** The reference's `validate` takes a flat file list and classifies each file as a schema or
  data document; this port keeps `--schema`/`--root` and takes the schemas an import or an extern
  names as further `--schema` files, served by `!!id` and never fetched (`compile` serves every file
  it is given to the others). Both refuse a schema with no `!!id` (the reference's backlog item
  asks for a file-URI identity instead): this port reports it as a rejected schema.
- **Identity by string key** for a canonical application, and by structure for a type in place
  (`IDIOM-DEBT.md` §12): a JavaScript `Map` has no record equality.
