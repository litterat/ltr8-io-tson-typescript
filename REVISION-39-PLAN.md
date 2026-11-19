# Revision 39 plan

Taking this port from 2026 Revision 38 to Revision 39. `ORCHESTRATION.md` says how a run is driven:
one manager, `tson-porter` sub-agents writing every line of implementation, and a gate between
stages. That shape is unchanged. This file says what the stages contain, and why. Each stage below
**is** the brief its porter receives, so this file is the unit of review rather than a workflow
script per stage.

Read `CLAUDE.md` first. Its hard constraints bind every agent in every stage. The adjudicated change
list is `spec/tson-rev39-changelog.md`. Its §4 digest is the shortest statement of what an
implementer must act on, §1 states each register entry's normative effect, §3 lists every changed
section by part, and §9 the fourth pass's decisions. The reference's `design/` notes (under
`.references/ltr8-io-tson-java/design/`) each open with the invariants of their area;
`namespace-types-and-value-entries.md`, `kinds-and-name-types.md`, `declared-positions.md` and
`inhabitance-and-record-extension.md` are new in this revision, and `meta-layer-namespaces.md` and
`scope-push.md` are gone with the concepts they described.

**Revision 40 is close behind**, and the reference's `r2026-40-proposal` branch is already moving.
This run pins `main` at its Revision 39 commit and nothing past it. Keeping the port's structure
parallel to the reference (`IDIOM-DEBT.md`) is what makes Revision 40 a diff to read rather than a
port to redo, so where a choice is open, prefer the reference's shape.

## What moves

|                           | Revision 38                                             | Revision 39                                                                 |
| ------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| `JAVA_PIN`                | `d4bba8f3f0e6cc1ce75fa59e9b6212aca6595b93`              | `c48b744707128531e82cfe87b0fd584a2e26bc8f`                                  |
| `SUITE_PIN`               | `1a558b404ecad7b0a2230e21e1de371aac39c0b3`              | `fb8757fb2e4ed947e0446a8de247145f990de905`                                  |
| Conformance subjects      | 695                                                     | **944** (schema 264, validate 231, link 133, vocabulary 149)                |
| Spec vendored             | Parts 1–3, Rev 38 change log, `m/` schemas and fixtures | Parts 1–3, Rev 39 change log, `m/` (six schemas) and **`fixtures/`** (five) |
| Bundled schemas           | meta-kernel, meta, core, net, policy                    | **meta** (the kernel), **numeric**, **temporal**, net, core, policy         |
| Bundled schema identities | `tson.io/2026/38/m/*`                                   | `tson.io/2026/39/m/*`                                                       |
| Package version           | 0.38.0                                                  | 0.39.0                                                                      |

The reference moved 129 commits (+38.4k/−26.1k over 828 files). The corpus added 249 subjects; every
subject is now a complete document carrying its own `!!import` header, and `RUNNER.md`'s
"Schema-governed vectors" (the splice) and "A meta layer's own records" are replaced by "Every subject
is a complete document" and "A fixture schema's own records". **This revision does not change the
lexer.** It changes the data grammar at four positions and the document header for both kinds, and
it replaces the schema ladder with one namespace per schema, which reshapes the kernel and with it
everything a schema resolves to.

Measured at Stage 0: 944 discovered and **944 failing**, every one for the same reason — the corpus's
own sidecars now carry `!!import` headers, which the data parser refuses. 242 of 3018 unit tests
fail, on the same cause and on the kernel no longer bootstrapping (`meta.tn` is now a nested
`!schema` document under a header of `!!id` alone).

## Stage 0: pins and vendoring (done)

Both pins moved; `spec/` re-vendored to the reference's new layout — the six schemas under `m/`, the
five resolved fixtures under `fixtures/`, `tson-rev39-changelog.md` replacing 38's; the six bundled
schemas embedded as stdlib constants (`META_TN`, `NUMERIC_TN`, `TEMPORAL_TN`, `NET_TN`, `CORE_TN`,
`POLICY_TN`) and registered in import order (kernel, the three libraries, core, policy); bundled
identities moved to `/2026/39/`; the harness's bundled-identity table given the six names.
`META_KERNEL_TN` is gone. The kernel is still routed through `bootstrapMetaKernel`, which no longer
reads it — Stage 2's to fix.

## Stage 1: Part 1, and the processor policy

Two packages over disjoint files. **WP1A runs in the main checkout**; WP1B runs concurrently in its
own worktree and is merged after WP1A lands.

### WP1A: the data grammar, the header, references in data, and the harness

Part 1 §1.3, §1.5, §2.1–§2.7, §3, §3.1, §3.3, §4, §7.1, §7.2.5, §7.4, §7.5; change log §1 items #3,
#6, #8, #13, #14, #15, #21 and §3.1 whole. Read `design/lexer-and-data-parsing.md`,
`design/tree-model.md`, `design/facades-and-tree.md`, `design/writers-and-document-header.md`,
`design/conformance-suite.md`. Java: `TsonDataStream`, `TsonDataParser`, `TsonDocumentHeader`,
`TsonDocumentPeek`, `TsonDataEmitter`, `TsonTreeWriter`, `TsonTreeReader` (the data side),
`ast/{Document, CoreValue, DataValue, RecordValue, MapValue, ArrayValue, ReferenceValue}` (`ScopedValue`
is gone), `stream/{DocumentStart, FieldName, ReferenceEvent, TsonEvent, EventSkip}` (`SchemaRef` is
gone), `tson-atom/ReferenceGrammar.java` (new; the qualified-name and argument-list grammar below the
token), `tson-tree/{TsonReference, TsonApplicationReference, TsonSiblingReference, TsonDocument,
TsonValue}` (`TsonScopedValue` is gone), `reader/SchemalessTreeReader`, `atom/BuiltinTypeVocabulary`,
and the conformance runner `tson/src/test/.../ConformanceSuiteTest.java`.

**Touch nothing under `schema/`, `link/`, `ast/schema/`, or the compiler's schema parser, desugarer
and resolver** — Stage 2 rewrites them, and WP1B owns `config.ts`'s limits and the policy. Where a
data-side change forces a schema-side edit to keep `tsc` green, make the smallest edit that compiles
and say so in the report.

- **The header (#8).** `document = ws [id-directive] *import-directive data-value ws`, the leading
  whitespace Revision 38 allowed kept (change log §9). `!!meta` and `!!schema` in a header are parse
  errors **naming `!!import`** as their replacement. A data document imports as a schema does; several
  imports read under one namespace. The header model carries an optional id and an ordered list of
  imports, nothing else.
- **No scope push (#6).** `scoped-value` is gone: a directive anywhere but the header — on a field, an
  entry, an element — is a parse error. Remove the scoped-value event, AST node and tree node.
- **Classification (#8; Part 1 §2.2, §7.1).** A document is a schema document exactly when its root is
  tagged `!schema`, read past the root's leading annotations. Classification reads the header, those
  annotations and the tag, never the root's value. `!meta.schema` does not classify (change log §9).
  A Class 1 processor recognises a schema document this way and rejects it with the categorised
  diagnostic (§1.5).
- **Qualified names (#14, #15).** A tag is `"!" qualified-name`; an annotation is `"@" qualified-name
[":" data-value]` (`@atom.ordering:TOTAL`, `@meta.disjoint`). Part 1's tag production is `tag` and
  its token production `qualified-name-token` (change log §9). A qualified name is one unquoted token
  whose segments are identifiers joined by `.`; judge it with the identifier grammar per segment.
- **References in data (#13; §4, §7.2.5, §7.4, §7.5).** `core-value` gains `reference =
qualified-name "<" ws type-args ws ">"`, with an `application` production split out (change log
  §9). `<` must be adjacent to the name; a quoted token is never a reference; `t: set<text>` is a data
  value; `!int32!` and `box< text>` are parse errors. `type-arg` admits no sibling reference (change
  log §9). A value argument is any token (change log §5, #13 remainder: the running grammar). Port
  `ReferenceGrammar` as hand-written functions, one per rule, no `RegExp` (CLAUDE.md).
- **Sibling references (#21; §2.5, §4, §7.4).** `kind!` — an unquoted token followed by an adjacent
  `!` — is a sibling reference at a value position. The end of the document counts as the following
  whitespace (change log §5, running). `"name"!` is refused. A record's field order is insignificant
  except that a dependent field's free sibling is written before it (§2.5); that ordering is judged
  where the schema says which field is dependent (Stage 2), not here.
- **The value model.** The event stream emits a reference event; the data AST, the tree and the
  schemaless reader carry a reference value (a name and its argument list, arguments recursive) and a
  sibling reference (a field name) as structured values (§1.5, §4). The tree writer and the data
  emitter write both back in canonical form.
- **The emitter at a disjoint choice (#3; §2.4).** A schemaless writer quotes every host string and
  writes every number and boolean bare, so a value written round-trips through a disjoint choice to
  its variant. Port what `TsonDataEmitter` and `TsonTreeWriter` do.
- **The built-in vocabulary (§5.5's library column, change log §1 housekeeping).** The kernel's root
  holds `boolean`, `text`, `bytes`, `regex`, `iri`, `iri_reference`, `integer`, `int64` (and `void`);
  `uuid`, `uri`, `uri_reference` and `email` move from core to `net`; `iri` IS-A `iri_reference`. The
  schemaless reader and the harness's vocabulary table name each type with its library.
- **The harness (RUNNER.md, "Every subject is a complete document").** Feed every subject exactly as it
  is on disk; remove `spliceSchemaDirectives`/`spliceSchemaDirective` and every read of a sidecar's
  `meta`/`import`/`schema` field. Serve the corpus's own schemas by path under
  `https://tson.io/test-suite/schemas/`; any other identity a Class 2 subject imports is a bundled
  schema the processor already holds; a Class 1 subject's imports are never fetched. A subject is a
  schema document exactly when its root is tagged `!schema`, decided by the processor, never by the
  sidecar. Sidecars import their layer's schema with `!!import` and are parsed with our own parser.
  The identity layer's directive is `!!id` or `!!import` (rule 3e). Read RUNNER.md whole; rules 1–6
  are unchanged and still bind. **The discovered count must stay 944.**

Vectors: every `class1/` vector — `lexer` 35, `parser` 56, `reader` 34, `resolver` 14, `identity` 28,
`vocabulary` 149. Report any Class 1 vector still red with the reason, and attribute it to WP1B or a
Stage 2 package by name.

**Gate:** Class 1 green except vectors attributed by name to another package. 944 discovered.
`npm run typecheck && npm run lint && npm run format:check` clean; unit tests over the data side
green (tests asserting the Revision 38 header or the scope push are rewritten to Revision 39, not
deleted). Report the Class 2 failures by layer; they are expected.

### WP1B: limits, the processor policy, and the Revision 38 tail

Leaf work, in its own worktree. Owns `config.ts`'s limits and policy surface, `core/` (diagnostics and
refusal), `packages/cli/src/policyNode.ts` and the `tson policy` command, and the two items below from
the Revision 38 tail. **Touch nothing under `stream/`, `lexer/`, `tree/`, `ast/`, `reader/`,
`compiler/`, `schema/`, `link/`, `test/conformance/`** — WP1A and Stage 2 own them.

Part 1 §8.2, §9.1; Part 2 §11.5; change log #4, #6, #10, #16, §1's `policy.script_policy` note. Java:
`tson-base/policy/LimitsPolicy.java`, `ProcessorConfig.java`, `Diagnostic.java`,
`SchemaRefusalException.java`, `diagnostics/RecordDiagnostics.java`; `tson-cli/CliPolicy`,
`PolicyOptions`; `spec/m/policy.tn` whole; `design/processor-policy.md`.

- **Limits.** The table is Part 1 §9.1 plus Part 2 §11.5 as `policy.tn`'s `limits` carries it:
  `max_wait_depth` (default 64) joins; `max_alias_chain` replaces the reference-chain limit; the
  foreign-schemas limit is gone. Every limit is a positive `int64` (`policy.limit => !int64 ^ { min:
1 }`), and a processor that holds one in a narrower host type caps it (§9.1). Reading a limit and
  refusing on it is this package's; consulting `max_wait_depth` and `max_alias_chain` where the
  resolver waits and follows aliases is Stage 2's, against the accessor names this package fixes.
- **The policy's shape.** `policy.tn` declares `policy` at its root and its records under a `policy`
  map: `policy.processor`, `policy.script_policy` (the token policy's record; its field on
  `policy.processor` is `token_policy`), `policy.limit`. `tson policy` reports the processor policy in
  that shape, every name by path.
- **A boolean position admits its members' string spelling** (reference `3434b342`, Part 2 §5.2): if
  the change is confined to `atom/boolean.ts` and its callers' atom-level checks, take it here; if it
  needs the reader, leave it to WP2B and say so.
- **The JSON object writer refuses annotations unless configured to strip them** (reference
  `19d640c9`; `json/` writer only).

**Gate:** in the worktree, against the Stage 0 commit: `npm run typecheck && npm run lint && npm run
format:check`, the package's own unit tests, and `npm run smoke:cli`'s policy cases where they do not
need the kernel. Stage 1 ends when WP1B is merged onto WP1A and the combined gate holds.

## Stage 2: the kernel and one namespace

Three packages, run **in sequence** because they share the schema model, the resolver, the linker and
the compiled readers. Each package's gate is that the previous packages' vectors stay green and its own
go green. Each porter reads the reference's design note for its area first.

### WP2A: the schema grammar, the kernel model, the bootstrap, and resolved output

**One package, reviewed by the manager before anything follows it.** This is the contract layer
(`ast/schema/`, `schema/meta/`) plus every consumer that must change for the kernel to load, for the
libraries to register, for the five fixtures to match, and for `tsc` to pass. The model is frozen
once WP2B starts, so **every** Revision 39 kernel shape goes in now, including shapes whose rules are
WP2B's or WP2C's. Where a rule is not needed for the bootstrap and the fixtures, map the Revision 38
behaviour across and leave the rule to its package — but the _shape_ is this one's, in full.

Read, in this order: `spec/tson-rev39-changelog.md` §1 and §4; `spec/m/meta.tn` whole (it is the
authority), then `numeric.tn`, `temporal.tn`, `net.tn`, `core.tn`; the conventions note at the top of
`spec/fixtures/meta-resolved.tn`; Part 2 §2.2, §2.2.3, §3, §3.3.1, §3.4, §3.4.1, §4.1, §4.2, §8.1,
§8.2, §9, §12; the reference's `design/resolver-vocabulary-and-bootstrap.md`,
`design/schema-resolution.md`, `design/schema-grammar.md`, `design/schema-grammar-and-desugaring.md`,
`design/namespace-types-and-value-entries.md`, `design/references.md`, `design/kinds-and-name-types.md`,
`design/linking-and-compilation.md`, `design/compiled-registries.md`. Then the Java: every file under
`tson-schema/src/main/java/io/ltr8/tson/schema/` (the model now lives in one package per kernel map —
`meta/`, `atom/`, `numeric/`, `unicode/`, `net/`, `binary/`, `temporal/` — and `KernelNames`,
`SchemaPaths` are new); `tson-compiler`'s `ast/schema/` (every file), `TsonSchemaParser`,
`resolver/{KernelBootstrapResolver (replacing MetaKernelBootstrapResolver), WaitOrder, SchemaResolver,
DefinitionResolver, ConstructionReader, SchemaDesugarer, MetaRefs, WireForm, AliasChain (was
ReferenceChain), ImportedSynthetics, DerivedName, InternalName, HeldBody}`, `TsonSchemaLinker`,
`TsonCompiledVocabulary`/`TsonCompiledVocabularyRegistry` (replacing the meta-schema registry),
`config/SchemaModelNameBinder`, `config/TypeRefTextBridge`, `TsonObjectWriter`,
`writer/DataClassObjectWriter`, `writer/AstWriter`.

#### Grammar (Part 2 §12.1, §12.2)

- The schema header is the data header: `[!!id] *!!import`; a schema document's root is tagged
  `!schema`.
- `type-ref` is renamed `type-expr` at every use; `type-ref` is kept for `qualified-name ["<"
type-args ">"]`, which `map-key`, `supertype-ref` and `refined-def` use (#22). Every reference
  position takes a `qualified-name`. `x => [int32]`, `x => (a | b)` and `x => kind!` parse (change log
  §9).
- `schema-map-entry` admits `"!schema" ws schema-map`: `geo => !schema { … }` nests a map (#14).
- `!C { … }` is an instance of `C` (#5), whether or not `C` builds types; `^` refines any value whose
  type states refinement rules, with no new token (§12.1's `atom-refinement` head generalised).
- A sibling reference (`kind!`) parses at every reference position; at a refinement source, a
  composition operand or a map key the resolver refuses it naming the slot (change log §9).
- A record template is its own form (#19; Java `ast/schema/RecordTemplateDef`), its fields labelled.
- Rename the AST's references and type expressions as the reference does (`NameRef`, `ApplicationRef`,
  `SiblingRef`, `Reference` for references; `ArrayExpr`, `MapExpr`, `TupleExpr`, `ChoiceExpr`,
  `TypeExpr` for expressions; `SchemaMapDef`), in this port's own idiom (a discriminated union, not a
  class per node). The Java's names are the vocabulary the reference's next diff will speak.

#### Model (`schema/meta/`)

The kernel is the authority; the list below is what it forces on this model.

- **One namespace per schema (#7).** A resolved schema is a map from **qualified name** to entry. A
  schema's namespace is its own entries plus its import closure's; every name resolves there from the
  root; there is no meta level, no structure/type-name split, no placement or import-level rule.
  Remove the `!!meta`-governed lookup, `link/importLevel.ts`, and every "governing meta" path.
- **Nested schema maps (#14).** `geo => !schema { … }` declares; its members are entries named
  `geo.address`; a map of one path declared by several documents of one closure is the union of their
  members, and a member path two of them declare collides as any name does. Synthetics mint at the
  root. Every name in a closure is reserved: a schema importing the kernel reserves its thirteen root
  names and its six map names (§2.2.3).
- **The kernel's layout (#15).** Root: `void`, `boolean`, `integer`, `int64`, `text`, `bytes`, `iri`,
  `iri_reference`, `regex`, `doc`, `enum`, `set`, `schema` (an alias of `meta.schema`). Maps: `meta`,
  `atom`, `numeric`, `unicode`, `net`, `binary`. A kernel-name table (Java `KernelNames`) is the one
  place a qualified kernel name is spelled in code.
- **An entry is a type exactly when its value is built by a constructor IS-A `meta.type` (#9);** any
  other entry is a value, marked by nothing but its tag (`create_order => !operation { … }`).
  `meta.top`'s subtypes include `meta.alias` and `meta.template`; `meta.type`'s exclude them. There is
  no NAMESPACE kind; a value entry takes no kind of its own (change log §9).
- **`namespace` refines `map` (#9).** `meta.namespace => meta.map ^ { key_type: meta.identifier_ref
voidable?: = false }`; `schema => !meta.namespace { key_type: meta.type_name  value_type:
meta.declared }`; `field_map => !meta.map { key_type: text  value_type: meta.record_field  ordered:
true }` — a plain ordered map keyed by `text` that no qualified name enters.
- **The alias body is `meta.alias` (#10):** `!meta.alias { target: T }`.
- **One reference atom (#11).** `meta.reference_type => meta.atom & { of: meta.type_ref
allow_sibling?: boolean ~ true }`, spelled `meta.ref<T>`. `kind_type`, `ref_type`, core's `kind`, the
  `members` field and the KindBody/RefBody shapes are gone. `meta.type_ref` (`!meta.field_type_ref ^ {
allow_sibling: false }`) and `meta.identifier_ref` (`!meta.type_ref ^ { of: unicode.identifier_type
}`) replace `type_kind` and `identifier_kind`. `meta.field_type_ref` types `meta.record_field.type`
  and `meta.record_template_field.type`.
- **An application is a reference value (#12).** The `type_ref` and `type_argument` records are gone:
  `meta.alias.target`, `meta.type_chain.parents`, `meta.type_chain.supertypes`/`subtypes` and
  `@meta.application` are typed `meta.type_ref`; an application is held as its parsed form (name plus
  arguments, recursive) and written unquoted (`!meta.alias { target: pair<uuid B> }`). A tag carries no
  arguments.
- **A record template is its own constructor (#19).** `meta.record` is closed;
  `meta.record_template` carries `parameters: [meta.template_param; 1..]` and `fields:
meta.record_template_field_map`, each `meta.record_template_field` labelling a whole parameter as
  `type_param` or `value_param`. Java: `RecordTemplateBody`, `RecordTemplateField`, `RecordHead`.
- **Dependent fields (#21).** `meta.record_field.value?: type!` — the field's `value` slot typed by its
  sibling `type`'s value; a sibling reference is a `meta.field_type_ref` value. Java: `SiblingRef`.
  The model carries it now; the rules are WP2C's.
- **`value` and `value_type` are gone (#17, #21).** Every facet is typed by its family's own instance
  (`numeric.decimal_type.min: number`, `temporal.date_type.min: date`, `net.ipv4_type.within:
[cidr4]`); a field's default or pin is read against the field's own type.
- **Counts (#16).** `numeric.count => !int64 ^ { min: 0 }` types every count facet;
  `numeric.integer_type.multiple_of` and `numeric.integer_size.bits` are `integer`.
- **Declared positions (#6).** `meta.declared_type => sum & {}` and `meta.declared =>
!meta.declared_type {}`; `scoped`, `scope_kind`, `scope_set`, `schema_identity`, `extern`,
  `dynamic`, `extern_of` and `extern_type` are gone. Java: `DeclaredType`.
- **Annotations.** `meta.synthetic` and `meta.application` are the resolver-attached key annotations
  (`@meta.synthetic`, `@meta.application`); `meta.disjoint`; the classifying annotations are
  `atom.ordering`, `atom.bounded`, `atom.exact`, `atom.numeric`; `meta.annotation` is `void`'s alias.
  Core declares the author annotations.
- **Movement between maps.** `uuid_type`, `uri_type`, `email_type` are `net.*`; `iri_type`,
  `scheme_set`, `scheme_name` are `net.*` in the kernel; text constructors `unicode.*`; integer
  constructor `numeric.integer_type` in the kernel, the rest of the numeric constructors in
  `numeric.tn`; temporal constructors `temporal.*`; `binary.bytes_type`. Model files may follow the
  reference's package split (`atoms-net.ts`, `atoms-numeric.ts` …) — keep one file per kernel map
  where it reads naturally.

Optionality is `readonly x?: T` (CLAUDE.md). A switch over the entry union is exhaustive.

#### Bootstrap, resolution and output

- **The bootstrap (#4; Part 2 §3.4).** The kernel is pre-loaded: header `!!id` alone, importing
  nothing. Its one wait cycle is the 25 entries holding `meta.record`; every other entry is read in
  wait order (Java `KernelBootstrapResolver`, `WaitOrder`). `schema/bootstrap.ts` and
  `stdlib/index.ts` follow; the libraries then resolve ordinarily, each importing the kernel, core
  importing the three, policy the kernel.
- **Resolution.** The definition resolver resolves each entry to its value under one namespace; a
  bare name at any reference position resolves from the root; a qualified name walks nested maps. The
  wait order (§3.4.1 Pass 2, rules 1–7) is the resolution order in every schema; source order is never
  consulted; a wait cycle is a resolver error; `max_wait_depth` is WP1B's accessor.
- **Linking.** `chain.subtypes` is the inverse over the namespace of the schema being resolved
  (change log §9). The four-plus-namespace base-kind reading of Revision 38 becomes `atom`, `product`,
  `sum` under `type`, with `alias` and `template` under `top`.
- **Resolved output (§8.1).** An entry as its value; a nested map written `name => !meta.schema { … }`
  per the fixtures' conventions note; a record as `!meta.record { fields: { … } }`; a record template
  as `!meta.record_template { … }` with `type_param`/`value_param`; an application unquoted;
  `@meta.synthetic` and `@meta.application` on the key; a body tagged by its constructor's path. The
  CLAUDE.md paragraph on naming the applied head (the `set_type`/`enum_set` case) still holds; check it
  against `fixtures/meta-resolved.tn` and say if the reference now writes the head itself.
- **Harness.** `test/conformance/resolvedForm.ts` and `schema.ts` compare the new shape; a
  `class2/schema/` vector's expected resolved output is read under the subject's own imports, and
  under the pre-loaded kernel alone when it has none (RUNNER.md). "A fixture schema's own records":
  this port binds nothing to host classes, and reads a value entry's record into the generic record
  value Revision 38 defined — say so where the harness reads it. `bundled-ids.ts`'s splice is gone
  (WP1A).

#### Gate

- The six bundled schemas bootstrap and register, and `bundled-schemas-resolve.test.ts` is green
  against all five `spec/fixtures/*-resolved.tn`. Normalise minted hashes wherever they appear.
- Class 1 stays as WP1A left it.
- 944 discovered. Report the Class 2 pass count by layer and attribute every remaining failure to WP2B
  or WP2C by name.
- `npm run typecheck && npm run lint && npm run format:check && npm test` green. A unit test that
  asserted the Revision 38 shape is rewritten to the Revision 39 shape, not deleted; one whose subject
  is gone (the scope push, `!!meta`, the import-level rule, `kind<T>`) is deleted with its subject and
  listed in the report.

### WP2B: references, values, aliases, refinement and wait order (#4, #5, #6, #9–#12, #16–#18; Part 2 §2.2.3, §3.3.1, §3.4, §4.1, §4.2, §5.2, §5.5, §5.7, §5.8, §5.12, §6, §7.4, §7.8, §8.3, §11.5)

Java: `TypeInhabitance`, `ValuesByName`, `HeldValues` (new), `RecordExtension`, `ChoiceDisjointness`,
`TsonSchemaLinker`, `resolver/{KindMembers, ApplicationCloser, AliasChain, WaitOrder, SyntheticMerge,
NumericIdentity, NameType}`, `reader/{DeclaredReader, TypeNameSlotReader, ValueEntryReader,
UnclosedApplicationReader, PendingTypeReader, RecordedNameReader, ReferenceNameReader,
NamespaceInstanceReader, TypeRefCheck, Subsumption, DiscriminationClass, ValueIdentity}` (`ScopedReader`,
`ScopePush`, `KindSlotReader`, `RecordedApplicationReader` and `ForeignSchemas` are gone),
`tson-atom/parser/{RefParser, TypeNameRefParser}` (`KindParser` is gone), the atom parsers' facet
changes; `design/references.md`, `design/namespace-types-and-value-entries.md`,
`design/declared-positions.md`, `design/inhabitance-and-record-extension.md`,
`design/atom-refinement-and-coherence.md`, `design/choice-disjointness.md`,
`design/constructor-application.md`.

- **The reference atom (#11; §4.2, §5.12).** A name is admitted exactly when the named entry's value,
  past its alias hops, has a type IS-A `of`. Over a constructor the slot holds a type's name; over any
  other type a value's qualified name. A constructor is an ordinary record type at every name slot. A
  bound refuses a constructor. In a data document a name at a `meta.ref<T>` slot is judged by the same
  walk over the namespace its imports bind and delivered with its referent; a field's default or pin at
  one is a name judged at link.
- **Values by name (§5.12).** A further segment selects a key of a namespace value or a field of a
  record value; no segment selects a field declaration; `field_map` is never entered. Each refusal
  names its step.
- **Applications (#12).** Identity is the parsed form; arguments compare past aliases; an application
  inside a reference closes (reference `28d575d7`). `@meta.application` states the application as
  written, nested arguments unreduced; an expansion does not state it (change log §5, #12 remainder:
  the resolver keeps it in memory only).
- **Value entries (#9).** An entry whose value is an instance of an ordinary type is a value; naming
  it where a type is expected is a resolver error. A namespace value is refused at `^`.
- **`!` and `^` (#5; §5.5, §5.7).** `!C { … }` is a value of `C`, and whether the entry is a type
  follows from `C`'s chain. `^` refines a value field by field under the rules its type states; a type
  stating no rule for a field is refused at `^`, naming the type.
- **A restated field narrows by IS-A (#18; §5.7, §5.8).** `void` at a voidable position is the one
  non-nominal case.
- **Declared positions (#6; §7.8).** `meta.declared` admits every type of the closure by its tag.
- **Facets and counts (#16, #17; §5.3, §5.10, §5.11).** A facet is read against its family's instance;
  a count against `numeric.count`; a bound past what a processor's values reach is met or never
  reached, never a schema error.
- **Wait order (#4; §3.4, §3.4.1, §6, §11.5).** Rules 1–7 as the resolver's order in every schema, a
  wait cycle a resolver error, `max_wait_depth` consulted. A reference orders nothing; a held value
  orders nothing.
- **Aliases (#10).** "Alias chain" in diagnostics; `max_alias_chain` consulted.
- **Reservation (#7; §2.2.3).** Every name in a closure is reserved; the collision rule's exception
  for open maps (change log §9).

Vectors: every `schema/`, `link/` and `validate/` vector naming `ref`, `reference`, `by-name`,
`qualified`, `value-entry`, `value-not-a-type`, `namespace`, `alias`, `declared`, `refine`,
`restat`, `narrow`, `wait`, `cycle`, `count`, `facet`, `reserv`, `collision`, `nested`, `map`.

### WP2C: record templates, dependent fields, and the editorial rules (#1, #19, #20, #21, #23; Part 2 §1.3, §5.4, §5.5, §5.7, §5.8, §5.10, §5.10.1, §5.11, §8.1, §8.2; Part 1 §2.5)

Java: `DependentFields` (new), `reader/DependentFieldReader` (new), `resolver/{RecordTemplateSubstitution
(new), TemplateMaterialiser, TemplateRegularity, ParameterTypes, FieldModifiers, Ancestry, HeldBody,
ImportedSynthetics}`, `FieldNames`, `EnumLabels`; `design/held-template-bodies.md`,
`design/template-materialisation.md`, `design/desugaring-open-forms-and-templates.md`.

- **Record templates (#19).** Built directly and applied on the model; labelled fields; the two
  declaration-time rules — a literal value under a closed field type is judged at the declaration
  (change log §9), and a parameter may not be spelled like a name written among an absorbed field
  type's arguments — and the two shadowing refusals. A record template named bare at an operand stays
  a resolver error.
- **Dependent fields (#21).** A sibling is required, defaulted, pinned or a group member, never
  voidable; a free sibling is written before the dependent field (declaration order and data order);
  the three ways a type is known; schema documents hold a dependent field's value as written; a
  qualified name goes on through a dependent field; a value entry's dependent field is judged against
  the type its sibling names. The open remainders (change log §5) run as the reference runs them.
- **A refinement source is a trigger position (#1).** The reference runs it order-dependently; port
  what it runs, and record the gap.
- **The head edge of an applied parent (#20).** Port what the reference runs; record the gap.
- **Floats (#23; §5.4, §5.5, §5.7).** A bounded float's discrimination class is read off `allow_nan`
  and `allow_infinity` as written (change log §9); a float admitting specials and a compound-keyed map
  have no discrimination class (reference `4dd62abd`). The NaN-excluded-by-a-bound rule and the
  infinity half are open in the reference's backlog; port what it runs and record the gap.
- **One synthetic minted by two documents is one entry** (reference `09190da9`); an entry reached by
  two import routes (the reference's backlog `cba25b25`) as the reference runs it.
- **A boolean position admits its members' string spelling**, if WP1B left it here.

Vectors: everything still red after WP2B, by name.

**Gate:** 944/944.

## Stage 3: Part 3, the JSON encoding (change log §3.4, §7.1)

Runs in its own worktree once WP2B is merged, concurrently with WP2C. Part 3 defines no type-system
rule; each change spells in JSON a rule Part 1 or Part 2 owns, so this stage reuses what Stage 2 built
through the paths `src/json` may import. **If a Stage 2 rule lives somewhere the JSON zone cannot
reach (`compiler`, `reader`), move it to `link/`, `schema/` or `atom/` rather than widening the
zone.** Java: the `tson-json` diff between the pins, every file (`InBandBinding`, `DependentReader`,
`DispatchDeclaredReader` and `AliasChain` new; `DispatchScopedReader`, `ForeignSchemas` and
`ValuePositionReader` gone); `design/json-*.md`.

- **`$import` is a list (#8; §1.6 item 22, §3.5)**, standing for the header's `!!import`s; a
  one-element list serialises as the single string.
- **`$type` is a qualified name (§3.3)**; references and applications as strings (§5.6), a sibling
  string (§5.6); a dependent member's order exception (§6.1.6).
- **Declared positions** replace the scoped reader (item 14 names `meta.declared_type`).
- **Facets typed by family, counts, aliases, value entries** as Stage 2 built them.
- Port the reference's new and changed `tson-json` tests, case for case; Java-host binding cases
  excepted.

**Gate:** the JSON unit tests, Class 1 and Class 2 unchanged, the browser bundle builds.

## Stage 4: CLI and sweep

Runs as Stage 3 does, beside WP2C, for the parts that need no Stage 2 rule; finished after the merge.

- **CLI.** `strip` shortens every bundled identity (`"39/meta"`, `"39/numeric"`, `"39/temporal"`,
  `"39/net"`, `"39/core"`); `init` writes an `!!import` header and a `!schema` root; the diagnostics
  schema follows the reference's `diagnostics.tn`; `compile`/`hash`/`validate` as the reference's
  commands moved. `npm run smoke:cli` green.
- Version both packages 0.39.0.
- Refresh `STATUS.md` (944 subjects; the gaps the reference also carries: #1's order-independent
  closing, #20's head edge, #23's NaN and infinity rules, float bounds judged after rounding, ingest),
  `CLAUDE.md` (the Part URLs and revision, the five → six bundled schemas, `fixtures/`, the applied-head
  paragraph, "meta-kernel" wherever it survives, the zone list if a path moved), `IDIOM-DEBT.md`,
  `ORCHESTRATION.md` (this plan, the 944 count), `README.md`, `skills/tson-ts/`, `examples/web-demo/`,
  and `.claude/agents/tson-porter.md` (the plan name and the 944 count).
- Tests named for a stage or a repair pass move into the test files of their subjects.

**Gate:** the full CI list in `CLAUDE.md`, in order, green.

## To report upstream

Collected from the stage reports. Each entry states the section, the reading this port chose, and why;
a corpus item names the file.

- **§8.1 (Part 2), resolved-output writing.** Carried from Revision 37: whether the reference still
  writes `!array { … }` for a body headed by `set_type` is WP2A's to check.
