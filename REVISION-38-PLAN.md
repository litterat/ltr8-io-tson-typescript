# Revision 38 plan

Taking this port from 2026 Revision 37 to Revision 38. `ORCHESTRATION.md` says how a run is driven:
one manager, `tson-porter` sub-agents writing every line of implementation, and a gate between
stages. That shape is unchanged. This file says what the stages contain, and why. Each stage below
**is** the brief its porter receives, so this file is the unit of review rather than a workflow
script per stage.

Read `CLAUDE.md` first. Its hard constraints bind every agent in every stage. The adjudicated change
list is `spec/tson-rev38-changelog.md`. Its §4 digest is the shortest statement of what an
implementer must act on, §5 holds the readings the fourth pass confirmed, and §9 the eleven findings
folded into the text after adjudication. The reference's `design/` notes (under
`.references/ltr8-io-tson-java/design/`) each open with the invariants of their area; `references.md`
and `meta-layer-namespaces.md` are new in this revision and are the two to read before anything
that touches a name.

## What moves

|                           | Revision 37                                 | Revision 38                                                  |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| `JAVA_PIN`                | `905330e84a29d64ecf9a83db0c12800b9997c1d9`  | `d4bba8f3f0e6cc1ce75fa59e9b6212aca6595b93`                   |
| `SUITE_PIN`               | `09cbce9f58c833b6f917a24f3fef41bc25c9dff3`  | `1a558b404ecad7b0a2230e21e1de371aac39c0b3`                   |
| Conformance subjects      | 459                                         | **695**, with a new `class1/identity/` layer (28)            |
| Spec vendored             | Parts 1–3, Rev 37 change log, `m/policy.tn` | Parts 1–3, Rev 38 change log, **`m/net.tn`** and its fixture |
| Bundled schemas           | meta-kernel, meta, core, policy             | meta-kernel, meta, core, **net**, policy; every digest new   |
| Bundled schema identities | `tson.io/2026/37/m/*`                       | `tson.io/2026/38/m/*`                                        |
| Package version           | 0.37.0                                      | 0.38.0                                                       |

The reference moved 133 commits (+28.9k/−11.4k over 878 files). The corpus added 240 subjects,
removed 4 and reshaped 12; its `RUNNER.md` gained rule 3e (the identity layer) and "A meta layer's
own records". **This revision does not change the lexer.** What it changes most is the kernel, and
with it the shape of everything a schema resolves to.

Measured at Stage 0 (`be1e160`): Class 1 is green except the 35 new `hostname`/`host`/`media_type`
vocabulary vectors and the two reader vectors on field names. **Every Class 2 subject fails for one
reason**: the kernel no longer bootstraps — `scheme_name` is restated over `identifier_base`'s new
`ASCII` member, `type_definition` is gone, and the three base kinds are `abstract type & {}`.
`class1/identity/` is not discovered at all. 151 unit tests fail, on the same two causes.

## Stage 0: pins and vendoring (done)

Both pins moved, `spec/` re-vendored (`tson-rev38-changelog.md` replacing 37's, `m/net.tn` and
`m/net-resolved.tn` added), bundled identities moved to `/2026/38/`, `net.tn` embedded as a fifth
stdlib constant and registered after `core.tn`, the harness's short-name table given `net.tn`, and
`strip`'s short form `"38/core"`.

## Stage 1: the contract layer, the bootstrap, and the leaf atoms

Two packages. **1A is the critical path and runs alone in the main checkout**; 1B is leaf work over
disjoint files and runs concurrently in its own worktree, merged after 1A lands.

### WP1A: the kernel model, the grammar, the bootstrap, and resolved output

**One package, reviewed by the manager before anything fans out.** This is the contract layer
(`schema/meta/`, `ast/schema/`) plus every consumer that must change for the kernel to load, for
the fixtures to match, and for `tsc` to pass. The model is frozen once Stage 2 starts, so **every**
Revision 38 kernel field goes in now, including fields whose rules are Stage 2's. Where a Revision
38 rule is not needed for the bootstrap and the fixtures, map the Revision 37 behaviour across and
leave the rule to Stage 2 — but the _shape_ is this stage's, in full.

Read, in this order: `spec/tson-rev38-changelog.md` §1 and §4; `spec/m/meta-kernel.tn` whole, and
`git diff d71661b HEAD -- spec/m/` for what moved; Part 2 §4.1, §4.2, §5.2, §5.10, §8.1, §8.2, §9;
the reference's `design/references.md`, `design/meta-layer-namespaces.md`, `design/schema-resolution.md`,
`design/resolver-vocabulary-and-bootstrap.md`, `design/held-template-bodies.md`,
`design/template-materialisation.md`, `design/linking-and-compilation.md`. Then the Java under
`tson-schema/src/main/java/io/ltr8/tson/schema/meta/` (every file; `Type`, `TypeChain`, `Namespace`,
`KindBody`, `RefBody`, `Ref`, `OpenEntry`, `EntryKind`, `HostnameType`, `HostType`, `MediaTypeType`
are new, `TypeDefinition`, `TypeKind` and `Data` are gone), `TsonSchema`, `TsonLinkedSchema`, and in
`tson-compiler`: `resolver/MetaKernelBootstrapResolver`, `resolver/DefinitionResolver`,
`resolver/SchemaResolver`, `resolver/Ancestry` (new), `resolver/WireForm`, `resolver/MetaRefs`,
`resolver/HeldBody`, `resolver/ApplicationCloser`, `resolver/TemplateMaterialiser`,
`TsonSchemaParser`, `TsonSchemaLinker`, `TsonObjectWriter`/`writer/DataClassObjectWriter`.

#### Model (`schema/meta/`)

The kernel is the authority; the list below is what it forces on this model.

- **An entry is its value (#14).** `TypeDefinition` goes. A resolved schema is a map from name to
  `Top`, and `Top` is a closed union of four kinds of value: a **type** (every atom, product and
  sum body), a **reference**, a **held template body**, and a **namespace value**. `source` is gone
  everywhere; what it carried is now the `@application` key annotation (below) and the body's own
  tag.
- **A type carries its chain (#9, #14).** `type => abstract top & { chain?: type_chain }`, with
  `type_chain => { parents?: [type_ref]  supertypes?: [type_name]  subtypes?: [type_name] }`. Every
  type body (atom, product, sum) carries `chain`. `parents` is what was written — the only list that
  ever holds an application — and is kept on a record template's entry; `supertypes` is the closed
  chain, sorted bare names, empty for a fresh record, an instance and a subtracted record; `subtypes`
  is the linker's inverse over the map. `record.supertypes` is gone. A declaration never writes
  `chain`; the resolver computes it and the linker inverts it. The predicates `isConstructor`
  (IS-A `top`) and "is a type" (IS-A `type`) are both read off the chain; `top` itself counts by
  name. `kind_type.of` and the kind-membership walk are Stage 2's, but the chain they read is this
  stage's.
- **Abstract kernel entries (#15).** `top`, `type`, `atom`, `product`, `sum` and `namespace` carry
  `extension: ABSTRACT` in resolved output, and a direct application of one is refused as any
  abstract record's is.
- **`namespace` (#23) and its two kernel instances.** `namespace => abstract top & { key_type:
identifier_kind  value_type: type_kind  ordered?: boolean ~ false }`. A value of a type IS-A
  `namespace` is written and read as a map from `key_type` to `value_type`, never as a record of
  its facets. `schema => namespace & { key_type: = type_name  value_type: = top }` and `field_map
=> namespace & { key_type?: ~ field_name  value_type: = record_field  ordered?: = true }` are the
  kernel's two. Model a namespace value as one shape — the constructor's name and an ordered map
  from key to value, each key keeping its annotations — and hold the schema map and a record's
  fields as that shape. A meta layer's own namespace type (`api => namespace & { … }`) and an
  entry applying one (`myapi => !api { … }`) are a **value, never a type**; what this port reads
  the map's values into is below under "A meta layer's own records".
- **A record's fields are a map keyed by name (#12).** `record_field` loses `name`; `record.fields`
  is `field_map`. The author's brace form is unchanged; the explicit form is `!record { fields: { x
=> { type: int32 } } }`. A spelling written twice is the map's duplicate key; two spellings that
  are one value of the record's name type are the linker's resolver error (Stage 2A).
- **A record's field names have a type (#10).** `record.name_type?: identifier_kind`;
  `enum_type.type` is renamed `name_type` and typed `identifier_kind`; `enum => enum_type ^ {
name_type?: = identifier }`; **`text_enum` is gone**, and its `EnumBody` discriminator with it.
  `record.discriminators` is `[text; 1..]` and `field_group`'s member slots are `text`, each judged
  by the record's name type. Carry `nameType?: string` on the record body and `nameType: string` on
  the enum body now; the judgement is Stage 2A's. `identifier_base` gains `ASCII` (Start `A–Z a–z`,
  Continue adding `0–9 _`), and `scheme_name` is restated over it (`start: ASCII  continue: ASCII
continue_add: "+-."  exclude: "_"  normalization: ASCII_CASEFOLD`, the same set as before).
- **A record template is a `record` with `parameters` (#17).** `record` gains `parameters?:
[template_param]`; `template` loses `extension` and `discriminators` and holds every _other_ open
  body. A record template is not held: its fields are resolved with parameters standing in `type`
  and `value` as written, resolved output included, and its `chain.parents` are the parents as
  written, one of which may be an application. The base is ABSTRACT by construction and the record's
  own `extension` is each application's. §5.10's three places a parameter stands, and the operand
  rule (#16), are Stage 2C's checks; the shape is this stage's.
- **Kinds (#22).** `kind_type => atom & { of: type_name  members?: [type_name] }`, `kind => <T>
!kind_type { of: T }`, and the kernel's `identifier_kind`, `atom_kind`, `type_kind`. **Every slot
  that names the type of a value is `type_kind` and holds one bare name**: `record_field.type`,
  `tuple_element.element_type`, `array.element_type`, `map.key_type`/`value_type`,
  `namespace.value_type`, `choice.variants`, `template_param.type`/`bound`. `type_ref` stands only
  where an application may: `type_chain.parents`, `type_argument.name`, `reference.target` (which
  may name a constructor), the `@application` annotation, and held text. In this model that means
  those slots are typed `string`, not `TypeRef`; what the resolver does with a braced application
  written at one (the sugar lift, which mints and leaves the bare name) is unchanged in effect. A
  type parameter is one whose `type` is `type_kind`. `members` is a resolver-derived index, computed
  at link (Stage 2B); carry the field now.
- **References (#24).** `ref_type => atom & { of: type_name }`, `ref => <T> !ref_type { of: T }`.
  Kernel vocabulary only; core declares none. The atom's value is a qualified name. The judgement
  (§5.12) is Stage 2B's; the body is this stage's.
- **`@application` (#14).** `application => @annotation type_ref` joins `synthetic` among the
  resolver-attached key annotations: written on an entry's key wherever the entry closes an
  application (a declaration naming one, a minted instantiation, the alias a template's application
  closes to), read as stated on ingest, never written by a declaration.
- **Meta (`spec/m/meta.tn`).** Three atom constructors: `hostname_type => atom & atom_specification
& { spec?: = "…rfc5890"  allow_idn?: boolean ~ true }`, `host_type` (`spec?: = "…rfc3987"`) and
  `media_type_type` (`spec?: = "…rfc6838"  allow_parameters?: boolean ~ false  types?: [text]
suffixes?: [text]`). Model all three in `atoms-network.ts`. Their parsers are WP1B's; wire the
  constructors to the parsers through whatever seam `atomBuilder.ts` already uses for `ipv4_type`,
  against the function names WP1B's brief fixes below, so the merge is one import.
- **Core and net.** `ipv4`, `ipv6`, `cidr4`, `cidr6` and `mac` leave `core.tn` for `net.tn`, which
  adds `hostname`, `host` and `media_type`. Core declares `kind` as a sibling of the kernel's. Read
  `git diff d71661b HEAD -- spec/m/core.tn spec/m/net.tn`.

Optionality is `readonly x?: T` (CLAUDE.md). `link/bodyKind.ts`'s `isDataBody` exclusion goes with
`Data`; a switch over `Top` is exhaustive with an explicit namespace arm.

#### A meta layer's own records

`RUNNER.md` ("A meta layer's own records") says a runner in a language that binds must supply a host
class per record a fixture meta-schema's namespace types hold, and names the fixtures'
`@doc` as the list. **This port binds nothing to host classes.** Its schema model reads the kernel's
own records into the typed bodies above and must read a meta layer's records — `meta-service.tn`'s
`method`, `binding`, `route` and the rest — into a generic record value: the record's constructor
name and its fields by wire name, nested values recursively, with a name at a kind- or
reference-typed slot kept as the name written. That is what a qualified name's field step reads
(Stage 2B) and what resolved output writes back. So the runner supplies nothing, and `RUNNER.md`'s
rule is met by construction. Say so in the harness where it reads the sidecar's `meta`.

#### Grammar

The lexer is unchanged. In the schema grammar (Part 2 §12.1) a declared field name is **any
single-line token**, judged at link by its record's name type; `type-name`'s field-name clause reads
so. Parse it as the token's decoded text. In the data grammar (Part 1 §2.5, §2.8) a record's first
field name is a bare unquoted or single-line token, and the identifier match **moves from the parser
to the resolver**: `{ "first name": 1 }` parses, and is a resolver error in a document that names no
schema, judged by the schema's record under one. **This stage moves the match out of the parser and
into the schemaless read path as a resolver error** (`reader/invalid/a-field-name-is-not-an-identifier`
states `resolver`); the schema-governed judgement is Stage 2A's. Annotation and type-annotation names
stay parse errors (§7.7).

#### Bootstrap, resolution and output

- `schema/bootstrap.ts` lifts the new kernel: `type_chain`, `namespace`, `field_map`, `kind_type`,
  `ref_type`, the `kind`/`ref` templates, the three kinds, the abstract marks, and `schema` as a
  namespace type. Its `requireStated` checks follow the restated `scheme_name`.
- `definitionResolver.ts` resolves an entry to its value, computes `chain` (`Ancestry.java` is the
  reference's new home for it), flattens a composition's fields with `chain` first, and attaches
  `@application`. The four base-kind names are three plus `namespace`, read off the chain excluding
  `top` and `type`.
- `link/link.ts` inverts the chain into `subtypes` and judges a `type_kind` slot by resolution and
  arity, a bare name only. Kind membership (`members`) and values by name are Stage 2B's; a slot
  holding a name nothing declares is still an unresolved reference now.
- The resolved-output writer (`write/`, `TsonObjectWriter`'s port) writes the new shape: an entry
  as its value, `chain` first in a flattened body, `fields` as a map, a record template as `!record
{ fields: { … }  parameters: [ … ] }`, `@application` on the key, and the `!schema { … }` tag
  the kernel's fixture writes for the schema map. Set-typed fields stay in declaration order.
- `test/conformance/resolvedForm.ts` and `schema.ts` compare the new shape and read a `schema/`
  vector's expected side under the sidecar's own `meta` (RUNNER.md: a fixture meta imports `meta.tn`
  and adds constructors, and a namespace entry is typed there). `link.ts` gains the `members` fact
  (compared as a set, minted names normalised) — the comparison only; the index is Stage 2B's.

#### Gate

- `meta-kernel.tn`, `meta.tn`, `core.tn`, `net.tn` and `policy.tn` bootstrap and register, and
  `bundled-schemas-resolve.test.ts` is green against the Revision 38 `spec/m/*-resolved.tn`,
  `net-resolved.tn` included. Normalise minted hashes wherever they appear.
- Class 1: everything green except the 35 `hostname`/`host`/`media_type` vocabulary vectors (WP1B)
  and `reader/valid/a-schema-bound-documents-field-names-are-the-schemas` (Stage 2A).
  `reader/invalid/a-field-name-is-not-an-identifier` is green.
- 667 discovered (695 less the 28 identity subjects WP1B's harness work discovers). Report the Class
  2 pass count by layer and attribute every remaining failure to a Stage 2 package by name.
- `npm run typecheck && npm run lint && npm run format:check && npm test` green. A unit test that
  asserted the Revision 37 shape is rewritten to the Revision 38 shape, not deleted.

### WP1B: the network atoms and the identity layer

Leaf work, in its own worktree, over `atom/network/`, `unicode/`, `scripts/gen-*.mjs`,
`reader/schemaless/`, the built-in vocabulary table, `link/identity.ts`, and `test/conformance/`'s
`vocabulary.ts`, `vectors.ts`, a new `identity.ts` and the one place `runner.test.ts` lists layers.
**Touch nothing under `schema/`, `compiler/` or `ast/`** — WP1A is rewriting them. Export the three
parsers as `parseHostname`, `parseHost` and `parseMediaType` from `atom/network/index.ts` (or the
file the existing `ipv4` parser lives in), each returning the atom's value with its canonical text,
so WP1A can wire the constructors by name.

- **`hostname` (#5; Part 1 §5.5; Java `ltr8-net/HostName.java`, `Punycode.java`,
  `ltr8-unicode/IdnaProperty.java`, `BidiRule.java`, `Nfc.java`, `tson-atom/parser/HostnameParser.java`).**
  A domain name in LDH, A-label or U-label form, in any mix; `A–Z` read as `a–z` and nothing else
  mapped; each label at most 63 octets and the name at most 253 in A-label form; no trailing dot;
  the last label not beginning with a digit; a U-label valid under IDNA2008 (RFC 5891 §5.4: the
  Unicode `IDNA2008` derived property, NFC, the hyphen rules, the contextual rules, RFC 5893's Bidi
  rule). The value is the name, so `Example.COM`, `example.com`, `xn--bcher-kva.example` and
  `bücher.example` are two values; canonical text is the lowercase U-label form. Generate the IDNA
  property table from the UCD as the XID tables are generated, record its Unicode version, never
  consult the host. NFC may use `String.prototype.normalize` (CLAUDE.md says why).
- **`host` (#6; Java `Host.java`, `HostParser.java`).** RFC 3987's `ihost` profiled to DNS: a
  `hostname`, an IPv4 address, or an IPv6 address with or without brackets, no zone identifier,
  no IPvFuture. One string-class atom whose value is the member's with the member's equality
  (`[::1]` and `::1` one value, canonical text unbracketed; an IPv4 address never equal to an
  IPv6 one). `ipv6` itself still refuses brackets.
- **`media_type` (#8; Java `MediaType.java`, `MediaTypeParser.java`).** RFC 6838 `type/subtype`,
  with RFC 9110 §8.3.1 parameters where an instance's `allow_parameters` admits them; type,
  subtype, parameter names and a `charset` value compared without ASCII case; parameters a map;
  canonical text lowercase with parameters sorted by name; `types` and `suffixes` as member sets
  compared without ASCII case. The parsers take the facets as arguments so WP1A can pass the
  constructor's.
- **The built-in vocabulary** gains the three (`!hostname`, `!host`, `!media_type`) in the
  schemaless reader and the harness's vocabulary table, each named with its library.
- **Identity (#4; Part 1 §2.2.1; Java `tson-base/CanonicalIdentity.java`,
  `source/SchemaReference.java`).** An identity's host is a `host` value: an `ireg-name` a
  `hostname`, an `IPv4address` an `ipv4`, an `IP-literal` an `ipv6`; IPvFuture and zone identifiers
  refused. Canonical identity is the host's canonical text plus the path, the path NFC, no scheme
  and no query. `!!id` is written in canonical form only; a reference may use any spelling — the
  other label form, ASCII case, an uncompressed or bracketed IPv6 address, the URI spelling with
  percent-encoded UTF-8 read back and hex case ignored — and is read to canonical form before
  comparison. What has no IRI form stays an error. No authority means an absolute path, as now.
- **The identity layer (RUNNER.md 3e).** `tests/class1/identity/{valid,invalid}/`: a subject is a
  header and an empty body; the vector is about the first directive's argument alone, nothing
  fetched. `!!id` must be canonical; `!!schema` may be any spelling. A `valid` vector's `identity`
  is compared byte for byte with the computed canonical identity; an `error` vector's category is
  `resolver`. Add the layer to `LAYERS` and the discovery, so 695 are discovered.
- Hand-written grammars, one function per ABNF rule, no `RegExp` (CLAUDE.md).

Vectors: the 35 `vocabulary/*/host*`, `hostname-*` and `media-type-*` vectors, the 28 `identity/`
vectors, `validate/*` vectors over `fixtures/validate-net-host.tn` where they do not need WP1A.

**Gate:** the 63 vectors above, `npm run typecheck && npm run lint && npm run format:check` and
the package's own unit tests green, in the worktree, against the Stage 0 commit. 695 discovered.
Stage 1 ends when WP1B is merged onto WP1A and the combined gate holds.

## Stage 2: the Revision 38 rules

Three packages, run **in sequence** because they share `definitionResolver.ts`, `link/link.ts` and
the reader. Each package's gate is that the previous packages' vectors stay green and its own go
green. Each porter reads the reference's design note for its area first.

### WP2A: name types and field names (#10, #12; Part 1 §2.5, §7.1, §7.4, §7.7, §8.2; Part 2 §5.2, §5.4, §5.8, §5.11, §7.4, §7.7, §11.4; change log §9 items 4)

Java: `compiler/FieldNames.java`, `resolver/NameType.java`, `tson-atom/IdentifierGrammar.java`,
`EnumLabels`, `TsonSchemaLinker.checkFieldNameTypes`/`checkEnumTypes`, `reader/RecordAbstractReader`,
`RecordTreeReader`, `SchemalessTreeReader`, `base/diagnostics/RecordDiagnostics`;
`design/name-hygiene-and-minted-names.md`, `design/name-hygiene-read-path.md`.

- A name type is an identifier family whose `normalization` implies NFC: `NONE` is refused,
  `ASCII_CASEFOLD` admitted only over an all-ASCII profile. A profile may not add a
  Default_Ignorable_Code_Point, a control, or a space other than U+0020.
- A record's name type is set where declared and a subtype cannot change it: absent, it is its
  supertypes' one name type, and `field_name` for a record with none; supertypes with different name
  types do not compose. The brace form states a type by composition onto a fieldless abstract base.
  A pinned `name_type` resolves in the governing meta, an author-written one in the schema's own
  namespace (as `enum_type.name_type` already does).
- Every name in `fields`, `discriminators` and the groups is a value of the name type, judged at
  link; two spellings that are one value are a resolver error. A schema's own references to its
  fields match exactly.
- A document's field name is matched in the record's name type's form; an undeclared name is a
  closure error whether or not it is a value of the type — **after** a value of the name type meets
  §8.2 (change log §9 item 4). A document that names a schema has its field names judged by that
  schema alone; a Class 1 processor reading it holds them to no name rule
  (`reader/valid/a-schema-bound-documents-field-names-are-the-schemas`). Schemaless, a name that is
  no identifier is a resolver error (Stage 1 left this in place; check it).
- A record's field names and an enum's members are §8.2 scopes under their type's profile, and the
  hygiene rules run under that profile in both the schema layer (§11.4) and the read path.
- `!text_enum [...]` is gone: a closed set of text is `!text ^ { members: [...] }`, an enumeration
  of names beyond the identifier is an enum over the author's own `identifier_type`. An enum's class
  is read off its members under its `name_type`.

Vectors: every `schema/`, `link/` and `validate/` vector naming `name-type`, `field-name`,
`name_type`, `enum`, `members`, `ascii`, `casefold`, `json-name`, and `reader/valid/a-schema-bound-…`.

### WP2B: kinds, namespaces, references and values by name (#22, #23, #24, #13, #15; Part 2 §3.3.1, §4.1, §4.2, §5.3, §5.6, §5.12, §8.1, §8.3, §9; change log §5's confirmed readings)

Java: `resolver/KindMembers.java`, `compiler/ValuesByName.java`, `reader/KindSlotReader.java`,
`NamespaceInstanceReader.java`, `RecordedApplicationReader.java`, `RecordedNameReader.java`,
`ReferenceNameReader.java`, `TypeRefCheck.java`, `tson-atom/parser/KindParser.java`, `RefParser.java`,
`config/RefNameBridge.java`, `TsonSchemaLinker.validateBody`/`readAsMaps`, `TsonSchema.SlotType`,
`TypeInhabitance`, `DiscriminationClass`; `design/references.md` (the kernel's slots table) and
`design/meta-layer-namespaces.md` are the brief's other half.

- **Membership (`KindMembers`).** A kind's `members` is computed at link over the governing
  closure: an entry is a member when, past alias hops, the constructor its value applies is `of` or
  IS-A `of`, a constructor template followed to the constructor it applies, and it is not itself a
  constructor of types — except a namespace constructor, whose instances are maps. Membership is by
  construction, so a kind holds an abstract type and a record template; `top` is a member of
  `type_kind`, `kind<product>` and `kind<record>`; `kind<namespace>` holds `namespace` itself. A
  namespace _entry_ (`myapi => !api { … }`) is listed by its constructor's kinds and by no kind of
  types. `of` resolves in the structure namespace and names `type` or `namespace` or a constructor
  below either; any other (`kind<reference>`) is a resolver error at the declaration. A kind with no
  members admits no value.
- **A kind-typed slot's value** is one bare name, judged a member at link; a braced application at
  one in a value body is refused naming the alias spelling. In a data document a kind value resolves
  in the governing schema's type-name namespace; in a schema document where the slot says, and is
  judged when that schema links. A recorded name carries its slot's declared type, so the linker
  never walks the path back through the meta's declarations.
- **A namespace type** is declared only by a meta-schema, declares nothing but its three facets (a
  field beside them is refused, blaming the namespace type), and a value of it is read as its map.
  An entry applying one is a value: naming it where a type is expected is a resolver error ("a value
  and not a type"), and every type position refuses it. A read delivers the map's values as the
  generic record values Stage 1 defined.
- **Values by name (§5.12, `ValuesByName`).** A qualified name — segments joined by `.`, the first a
  type name resolved as a `type_ref` is, each further one a key of a namespace value or a field of a
  record value, every hop written, no index and no quoted segment — stands at a slot typed `ref<T>`
  and nowhere else; a slot typed `T` holds the value inline. Found first, judged after, never a
  choice among candidates; the referent IS-A `of`; a map that is no namespace is not entered; an
  optional field the value does not hold is refused as not present after the type is judged. Each
  refusal names its own step. `ref_type.of` names a type of the writer's namespace, never a
  constructor (`ref<record>` is refused: that is `kind<record>`). A reference is declared only in a
  kernel-governed schema; `!ref_type { of: order }` under `meta.tn` is refused by the linker for the
  schema's level.
- **Abstract applications (#15).** A direct application of `top`, `type`, a base kind or `namespace`
  is refused naming the subtypes that would satisfy it; an annotation typed by a base kind is a
  schema error in either §6 position.
- **The positional form (change log §5, confirmed).** `record_field.type` being an atom,
  `fields: { p => x }` is an atom-typed positional fill; in a schema document a product- or
  sum-typed positional fill is written as the explicit record.

Vectors: every `schema/`, `link/` and `validate/` vector naming `kind`, `members`, `namespace`,
`ref`, `by-name`, `qualified`, `value-not-a-type`, `abstract`, `interface`, `api`, `service`, and
the `link/` vectors over `fixtures/meta-service.tn`, `meta-api.tn`, `meta-headers.tn`,
`meta-resources.tn`, `link-orders-interface.tn`, `validate-kind-ids.tn`, `validate-own-namespace.tn`.

### WP2C: templates, the resolver's remaining rules, and the outcomes (#1, #3, #16–#21, #25; Part 1 §1.5, §3.2, §5.1, §5.6, §8.1, §9.1; Part 2 §2.2.3, §4.3, §5.7–§5.10, §8.2, §10.1, §11.2)

Java: `resolver/Ancestry.java`, `ApplicationCloser.java`, `TemplateMaterialiser.java`,
`TemplateRegularity.java`, `HeldBody.java`, `ParameterTypes.java`, `SyntheticMerge.java`,
`SchemaResolver.java` (the import-level rule), `tson-base/Diagnostic.java`, `source/SchemaReference.java`,
`HttpSchemaSource.java`, `FileSchemaSource.java`; `design/held-template-bodies.md`,
`design/template-materialisation.md`, `design/diagnostic-model.md`, `design/processor-policy.md`.

- **Where a parameter stands (#16).** In a `!record` body only at a field's type, a field's default
  or fixed value, or an argument of an application (in either, or in a parent); anywhere else a
  resolver error naming the slot. An operand of `&` or `^` may carry arguments naming parameters;
  an operand that is itself a parameter is a resolver error under the shadowing rule. A record
  template named bare at an operand is a resolver error (#17). Templates over other constructors are
  held as before.
- **An application nothing declares is its expansion (#18).** A fully-bound application of a
  template materialises its expansion, a synthetic entry keyed on content, and mints no
  instantiation entry unless the expansion names the application itself (the knot tied on the
  application). A minted record is a member of nothing; one whose chain would name a declared type
  is a resolver error at the declaration that wrote the application. **One verdict changes**:
  `u: vip<text>` over `vip => <T> box<T> & { … }` beside `w: box<text>` now loads.
- **Selectors and pins (#19, #20, #21).** A selector's declared type mentions no parameter at any
  depth, and a parameter-free application satisfies it. A routed `= P` is FIXED where written and
  materialisation substitutes into `value` changing no other fact; a FREE field never carries a
  value. A parameter pin is a selector whatever the name's mark: the base reads it required with the
  pin dropped, each member FIXED to its argument, optional as the name was marked.
- **Subtraction (#14, §5.9 rule 8).** A subtracted record's chain is empty and keeps no lineage; a
  subtracted construction headed by a constructor is not a constructor, so applying it is refused as
  not applicable.
- **An import stands at the importer's governing level (#25).** Both named the meta-kernel as
  `!!meta` or neither, judged per import edge: a `meta.tn`-governed schema importing the kernel or a
  meta layer, and a kernel-governed schema importing `core.tn`, are refused.
- **An unknown schemaless type annotation is a resolver error (#3).** `!nonesuch` in a document
  with no schema in scope is refused where it was a preserved marker, in the schemaless reader and
  the tree. `@` annotations stay preserved uninterpreted.
- **Refused and undetermined (#1).** `core/diagnostic.ts` states two outcomes beside §8.1's four
  categories: _refused_ — this processor declined the document under its own configuration (§8.2
  policy and data version, §9.1 limits, a schema it will not fetch or one past its size limit), a
  rejection and never a finding about validity, naming the rule or limit — and _undetermined_ — it
  could not obtain what it would judge against (nothing at the reference, no answer). `isRefusal`
  counts `SCHEMA_NOT_PERMITTED` and `SCHEMA_TOO_LARGE`; `SCHEMA_NOT_FOUND`, `SCHEMA_UNREACHABLE` and
  `SCHEMA_TIMEOUT` are undetermined. Map the CLI's `NOT_CHECKED`/exit ladder across unchanged unless
  the Java's `Outcome` moved. **A refusal under a fetch policy does not disclose the allowlist**
  (§11.2): the message names the reference and that this deployment will not supply it, never the
  hosts it would.
- **Resolved-output ingest.** Change log §6 item 4: ingest is unimplemented on both sides. Do not
  build it; note it in STATUS.md's gaps.

Vectors: everything still red after WP2B — the template, parameter, selector, import-level,
unknown-annotation, subtraction and refusal vectors, by name.

**Gate:** 695/695.

## Stage 3: Part 3, the JSON encoding (change log §3.4, §7.1)

Part 3 defines no type-system rule; each change spells in JSON a rule Part 1 or Part 2 owns, so this
stage reuses what Stage 2 built through the paths `src/json` may import. **If a Stage 2 rule lives
somewhere the JSON zone cannot reach (`compiler`, `reader`), move it to `link/`, `schema/` or
`atom/` rather than widening the zone.** Java: the `tson-json` diff between the pins, every file;
`design/json-*.md`.

- **A member name is a value of its record's name type** (§1.3, §3.2, §3.3, §6.1.1, §8.3.1, §9.4):
  matched in the type's form, an undeclared name a closure error after hygiene; the three reserved
  members (`$schema`, `$type`, `$tag`) are used, not reserved, and a schema SHOULD NOT declare them.
- **Kinds (§5, §5.6).** `$type` is a string holding a type name; a kind-typed slot reads one bare
  name. `ref_type` stands in schema documents only, which have no JSON form.
- **The outcomes (§9.4, §10.1)** read refused and undetermined.
- **Atoms (§5).** `hostname`, `host` and `media_type` are string-class and read through WP1B's
  parsers; the net library's names in the schemaless vocabulary.
- **Namespace values** have no JSON read path unless the reference built one; port what it built.
- Port the reference's new and changed `tson-json` tests, case for case; Java-host binding cases
  excepted.

**Gate:** the JSON unit tests, 695/695 unchanged, the browser bundle builds.

## Stage 4: CLI and sweep

- **CLI.** `strip` shortens `net` as it does `core`; the diagnostics schema follows the Java's
  `diagnostics.tn` (its `outcome` and the two outcomes of #1); `tson policy` unchanged unless
  `policy.tn` moved. `npm run smoke:cli` green.
- `/2026/37/` → `/2026/38/` wherever Stage 0 did not reach; version both packages 0.38.0.
- Refresh `STATUS.md` (695 subjects, the gaps: ingest), `CLAUDE.md` (the `enum_set`/`set_type`
  paragraph, the `type_definition` and `source` sentences, the fourth bundled schema → five, the
  zone list if a path moved), `IDIOM-DEBT.md`, `ORCHESTRATION.md` (this plan), `README.md`,
  `skills/tson-ts/`, `examples/web-demo/`, and `.claude/agents/tson-porter.md` (the plan name and
  the 695 count).
- Tests named for a stage or a repair pass move into the test files of their subjects.

**Gate:** the full CI list in `CLAUDE.md`, in order, green.

## To report upstream

Collected from the six stage reports. Each entry states the section, the reading this port chose,
and why; a corpus item names the file.

- **§8.1 (Part 2), resolved-output writing.** The Java still writes `!array { … }` for a body headed
  by `set_type`; this port writes the applied head. Carried from Revision 37; still open.
- **§8.2 (Part 2), applied-parent fold keys.** The fold and the minted-member refusal key operand
  parents on classified but not dereferenced arguments, as the Java does, so `& box<user_id>`
  beside `bu => box<uuid>` gets no IS-A edge even though §8.2 compares arguments after following
  reference chains. Matched to the reference; a gap in the reference worth raising.
- **§8.1 (Part 2), ingest.** Unbuilt on both sides (change log §6 item 4). This port reads `chain`
  as the resolver computed it and recomputes `members` at link; nothing reads resolved output back.
- **§9.4 (Part 3) against Part 2 §5.2 and §11.4, which field names meet §8.2.** The reference's
  JSON reader judges only an unmatched name that is a value of the name type; its text reader, and
  this port's, judge every field name. The two encodings disagree on the data document's names
  that meet the policy. One rule should be stated for both.
- **§9.4 (Part 3), which spelling is judged and which pointer is reported.** This port's JSON reader
  judges the name in the type's form; the reference's JSON judges the unfolded NFC name. A folded
  match's schema pointer is the declared field in JSON (the reference's test) and the written
  spelling in the text reader. Both differ only under a folding name type.
- **§9.4 (Part 3), the lookup miss.** The outcome paragraph names refused and undetermined but not
  which code a foreign-schema lookup miss maps to. Both implementations report
  `SCHEMA_NOT_PERMITTED` for a miss with no source behind it and `SCHEMA_NOT_FOUND` where a source
  looked; worth a sentence.
- **§4.2 (Part 2), a dotted name at a kind-typed slot.** The identifier grammar refuses it before
  §5.12's "a type through a namespace of types is a gap" branch can be reached, in the reference
  and here. The branch is unreachable text.
- **§4.1 (Part 2), the tag of a namespace entry's value.** `get_order => !method { … }` under an
  `api` whose value type is `method` is written untagged in resolved output; the corpus's
  `resolved-output-writes-a-namespace-entry-as-written` expects that, though its description says
  "as written". The tag is kept only where it names a strict subtype or family member.
- **§5.5 (Part 1), an A-label decoding to an invalid U-label.** `xn--abc` is refused for the
  U-label's own fault (a code point IDNA2008 does not permit), not as "not an A-label"; the text
  does not say which. An ASCII label over 63 octets is refused before Punycode decoding.
- **§5.5 (Part 1), `media_type` parameters.** `text/plain;` and `;;` are admitted, following the
  reference and RFC 9110's empty list element; a repeated parameter name is refused.
- **§2.2.1 (Part 1), hostless identities.** `file:///x.tn` and `/x.tn` keep an empty host as one
  identity; a schema source refuses a reference with no scheme or host.
- **§5.12 (Part 2), an annotation on a value inside a namespace payload.** Refused here, since the
  generic value model has nowhere to keep it; the text speaks only of a name carrying none.
- **§4.1 (Part 2), an untagged choice-typed slot in a value body** takes the first variant that
  reads; the text says nothing and no fixture exercises it.
- **Corpus, `RUNNER.md` rule 5** says "Exactly three grounds are legitimate" and lists four.
- **Corpus, `README.md` against `RUNNER.md` 3e**: the README's identity-layer paragraph says an
  `error` vector is "a reference that names no identity, or an `!!id` written in another
  spelling", while 3e speaks of the first directive alone. The runner here judges `!!id` where
  present, else `!!schema`; no vector has both.
- **`tson-cli`'s exit ladder.** `70 > 78 > 69 > 1 > 75`: a refusal under a fetch policy
  (`SCHEMA_NOT_PERMITTED`, `SCHEMA_TOO_LARGE`) is `REJECTED` and still exits 69, as the Java does —
  rejected and permanently unavailable are separate axes. Worth stating in the CLI's own docs.
