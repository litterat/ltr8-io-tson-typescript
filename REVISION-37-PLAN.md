# Revision 37 plan

Taking this port from 2026 Revision 36 to Revision 37. `ORCHESTRATION.md` says how a run is driven:
one Opus manager, Sonnet `tson-porter` sub-agents writing every line of implementation, and a gate
between stages. That shape is unchanged. This file says what the stages contain, and why. Each
stage below **is** the brief its porter receives, so this file is the unit of review rather than a
workflow script per stage.

Read `CLAUDE.md` first. Its hard constraints bind every agent in every stage. The adjudicated change
list is `spec/tson-rev37-changelog.md`. Its §4 digest is the shortest statement of what an
implementer must act on, and §8 holds the third-pass decisions that the digest postdates.

## What moves

|                           | Revision 36                                | Revision 37                                     |
| ------------------------- | ------------------------------------------ | ----------------------------------------------- |
| `JAVA_PIN`                | `0c1512c766a70792b409db3e5f6a717ae68ebd15` | `905330e84a29d64ecf9a83db0c12800b9997c1d9`      |
| `SUITE_PIN`               | `f9fa96f09f5e74dc45b40ceca48fa6dd8115464d` | `09cbce9f58c833b6f917a24f3fef41bc25c9dff3`      |
| Conformance subjects      | 328                                        | **459**                                         |
| Spec vendored             | Parts 1–3, Rev 36 change log               | Parts 1–3, Rev 37 change log, **`m/policy.tn`** |
| Bundled schema identities | `tson.io/2026/36/m/*`                      | `tson.io/2026/37/m/*`, all three digests new    |
| Package version           | 0.36.0                                     | 0.37.0                                          |

The reference moved 158 commits (+18.6k/−7.8k over 549 files). The corpus added 131 subjects
and renamed or reclassified four. **This revision changes the lexer**, the first change since
Revision 35 froze it: a bare `+` is the fifteenth special token.

Where 36 rebuilt `record_field`, 37 rebuilds `field_group`, which now has options. It retires
`element_state` and `unit`, turns `identifier` into a text family with a profile, and gives an enum
a `type` and a template parameter a type.

## Stage 0: pins and vendoring (done, `a649506`)

Both pins moved, `spec/` re-vendored, `tson-rev37-changelog.md` replacing 36's, `m/policy.tn`
added, bundled identities moved to `/2026/37/`, stdlib regenerated.

Measured at Stage 0: Class 1 is green except eleven new vectors (the bare `+`, an IRI directive
argument, `uri_reference`, `iri`, `iri_reference`, and the relative `!uri` now invalid). **All 223
Class 2 subjects fail, for one reason**: the kernel's `atom_specification.spec` is typed by the
kernel's own `iri`, so `meta-kernel.tn` does not bootstrap. Five more fail to parse their sidecar,
because the harness does not admit `refused` in the new `class2/validate/refused/` bucket.

## Stage 1: the contract layer, the grammar, and the bootstrap

**One package, run alone, reviewed by the manager before anything fans out.** As in Revision 36,
this is the contract layer (`schema/meta/`, `ast/schema/`) plus every consumer that must change for
the kernel to load and for `tsc` to pass. The model is frozen once Stage 2 starts, so **every**
Revision 37 field goes in now, including fields whose rules are Stage 2's.

### Model (`schema/meta/`)

Read `spec/m/meta-kernel.tn` (and `git diff a649506~1 a649506 -- spec/m/`) for the authority.

- **Field groups (#18, #21).** `FieldGroup` has three facts. `members: string[][]` holds one
  array of field names per option. `optionalMembers?: string[]` lists the members marked `?` within
  their option. `optional: boolean` defaults to `false`. Delete the old `state`.
- **`element_state` is gone (#21).** `voidable: boolean` replaces it on `array` (default false),
  `map` (default false) and `tuple_element`. `set_type` fixes `voidable: false`.
- **Order (#10).** `array.ordered` (default **true**) replaces `unordered`, `set_type` fixes
  `ordered: false`, and `map` gains `ordered` (default **false**).
- **Set bounds (#11).** `set_type` loses its `min_items` default of 1.
- **`unit` is gone (#8).** `value_type` and `void_type` are atom constructors with empty
  vocabularies, `value => !value_type {}`, `void => !void_type {}`. A processor recognises both by
  constructor, never by name.
- **`identifier_type` (#7, #19).** It composes `text_type` and `atom_specification` with six
  profile facets (`start`, `continue`, `start_add`, `continue_add`, `medial`, `exclude`) over
  `identifier_base => !enum [XID ID NONE]`, and its `normalization` defaults to NFC. `identifier => !identifier_type { continue_add: "-" }`.
  `scheme_name` is a second instance (kernel). The kernel's `identifier` is now an ordinary
  instance, not a unit atom.
- **`normalization` (#19)** on `text_type` over `!enum [NONE NFC NFKC NFKC_CASEFOLD ASCII_CASEFOLD]`,
  defaulting to NONE. It is fixed to NONE on `regex_type`, `uri_type`, `iri_type` and `email_type`.
- **`iri_type` and `uri_type` (#13, #14, change log §8.2 item 9).** The kernel declares `iri_type`
  and `iri => !iri_type { allow_relative: false }`, which types `atom_specification.spec`. Meta
  declares `uri_type` and `schema_identity => !iri_type { allow_fragment: false }`. Both gain
  `schemes: scheme_set` (in place of `scheme: text`), `allow_relative ~ true` and
  `allow_fragment ~ true`. Core declares `uri_reference`, `uri`, `iri_reference` and `iri`.
- **Enums (#7).** `enum_type => atom & { type: type_name  members: enum_set }` is the
  constructor. `enum` pins `type?: = identifier` and `text_enum` pins `type?: = text`; those are
  its two refinements. `EnumBody.profile` and `enum_profile` are deleted. `!enum [A B]` is
  unchanged in source and records `source: enum`.
- **Template parameters (#9).** `TemplateBody.parameters` is `TemplateParam[]`, and a
  `TemplateParam` is `{ name, type: TypeRef, bound?: TypeRef }`.
- **Discriminators** on `record` and `template` are `[field_name; 1..]`. Model them as
  `discriminators?: readonly string[]`, never empty. Whether the list is present now says how a
  family is dispatched, replacing whether it is empty.
- **Annotations (#15, #16).** `doc` is `@annotation text` in the kernel, and the kernel's
  `documentation` is gone. Meta's vocabulary is `deprecated` (`@annotation void`), `title`,
  `comment`, `examples` (`[text]`), `read_only`, `write_only`, `ordering` (renamed from `ordered`,
  §8.4 item 1), `bounded`, `exact`, `numeric` and `disjoint`. `todo`, `since` and `lang` are gone.
- Core's seven removed names are removed, and `tuple1<T>` and `voidable_tuple1<T>` are added.

Optionality is `readonly x?: T` (CLAUDE.md).

### Grammar

- **Lexer (Part 1 §4.4, §7.2.4, §7.2.5).** A bare `+` is a special token under `-`'s boundary rule.
  Followed by a continuation character it begins an unquoted token (`+5`, `+0.5` unchanged).
  Otherwise it is emitted alone. In a data value it is a **parse** error.
- **Field groups (Part 2 §12.1).** The grammar is `group-def = *annotation "(" group-option *( "|"
group-option ) ")" [ "?" / "+" ]`, with `group-member = *annotation field-name ["?"] ":" type-ref
["?"]`. The meaning changes: in 36, `( a: A  b: B )` was one-of, and in 37 it is one option holding
  both. `|` separates options.
- **Typed parameters (§12.1).** `type-param = param-name [ ":" type-ref ]`.
- AST: group options, the member's name `?`, the group's `?`/`+` suffix, and a parameter's written
  type.

### Lowering and resolution

- Desugar a group to `members`/`optional_members`/`optional`. `+` lowers to **one option holding
  every member, each marked optional** (change log §8.3 item 2), on a group that is not optional.
- **Parameter types are derived and recorded (#9, Part 2 §5.10).** This includes a type slot, a
  value slot, a routed default, an argument to another template as a fixed point, and a positional
  payload. The bundled fixtures already carry `parameters: [{ name: S  type: schema_identity }]`, so
  derivation is Stage 1's. The Java is `resolver/ParameterTypes.java`, which replaces
  `ParameterKinds.java`, and `compiler/parameterKinds.ts` is its counterpart here. A written `<T: X>`
  is parsed and recorded (`bound` for a type parameter, a narrowed `type` for a value parameter).
  **The checks over it are WP2B's**: agreement, bounds, the call-site check, and where the type is
  read.
- The resolved-output writer writes all of the above. Set-typed fields stay in source declaration
  order.
- Every consumer of `element_state`, `unordered`, `unit`, `EnumBody.profile`, `FieldGroup.state`
  and `parameters: string[]`, across readers, bind, link, JSON, and atom checks, moves to the new
  model **with its Revision 36 behaviour mapped across**, not extended. A `voidable` array admits
  `_` where `OPTIONAL` did. A group with several single-member options behaves as 36's one-of. Rules
  that are new in 37 are Stage 2's.

### Harness (`test/conformance/`)

Admit `refused` in `class2/validate/refused/` (README's "fifth outcome" section, RUNNER.md's
`<bucket>` line). Assert both halves, as the schema layer already does. Change nothing else in the
harness.

### Gate

- `meta-kernel.tn`, `meta.tn` and `core.tn` bootstrap, and `bundled-schemas-resolve.test.ts` is
  green against the Revision 37 `spec/m/*-resolved.tn`. A minted name may embed an inner minted
  name's hash (`array_array_field_name_1_5d4d7dc5_1_xxhash`), so normalise hashes wherever they
  appear.
- Class 1: everything green except the IRI/URI vectors (WP2D). Both `bare-plus` vectors are green.
- 459 discovered. Report the Class 2 pass count and attribute every remaining failure to a WP.
- `npm run typecheck && npm run lint && npm run format:check && npm test` green.

## Stage 2: the Revision 37 rules

Four packages, run **in sequence** because they share `definitionResolver.ts`, `atomChecks.ts` and
the reader. Each package's gate is that the previous packages' vectors stay green and its own go
green.

### WP2A: field-group options (#18; Part 2 §5.9, §5.10.1, §5.11, §7.6, §8.1)

- The three validity rules, and the declaration rules that refuse a group which only restates
  plain fields or another group. A group needs at least two members, so a bare group of one option
  is plain fields, and a bare group of one all-marked option is refused. An option holding no field
  is refused, and so is a mark on an option's only member. `optional_members` may not be empty. `+`
  over several field options is refused.
- Refinement and composition. A restated group member may drop its `?` (§5.8). §5.9 rule 7 is the
  removal rule.
- Reading, in tree and bind modes. A group that is not optional admits exactly one option and an
  optional group at most one. The `+` form admits any non-empty subset. A chosen option must have
  every unmarked member present. Choosing two options is an error.
- `typeInhabitance` guards read `voidable` and chosen options (§5.10.1).
- **Every group refusal is a new code, `FIELD_GROUP`** (Java `RecordDiagnostics`, commits
  `f94d9950` and `349d443c`), where Revision 36 used `TYPE_MISMATCH` or `FIELD_REQUIRED`. There are
  four messages: exactly one option, at most one, at least one (for `+`), and an option needing a
  member. Per-option missing-member reports come before the count of chosen options. A second
  mark after `)` (`)+?`) is a parse error.

Vectors: `a-field-group-option-holds-several-fields`, the eight group vectors in `schema/invalid`,
`a-chosen-option-missing-an-unmarked-member`, `two-options-chosen`,
`an-at-least-one-group-with-no-member`, `an-at-least-one-group-with-every-member`,
`an-option-of-several-fields-chosen-whole`, `an-option-whose-marked-members-are-left-out`,
`an-optional-group-with-no-option-chosen`, `an-empty-discriminator-list`.

### WP2B: typed parameters and declared family members (#9, #4; Part 2 §5.2, §5.10, §8.1, §8.2; change log §8.2 items 2, 5, 6, 10–12)

- **Start from what Stage 1 left.** `compiler/parameterTypes.ts` is a full port of Java
  `ParameterTypes`. It covers derivation, agreement, the may-not-widen bound check, the
  meta-constructor refusal and the structure-namespace reading. Verify each against §5.10 and
  wire it where it is not yet reached; do not build it a second time. The call-site check is the
  part that does not exist.
- **Parameter checks.** Several uses of one parameter must agree by IS-A. A written type narrows a
  value parameter, and is a type parameter's bound. A bound is inherited through another
  template's argument list, and a written bound may not be wider than the one it inherits. A bound
  names a type, never a constructor, so `<T: !C>` is refused. Two same-named entries with the same
  resolved body are one type for these checks (§8.2 item 6).
- **Where a parameter's type is read (§8.2 item 11).** A template applying a meta constructor other
  than `record` reads its value parameters' types in the **structure namespace**, written ones
  included. A record template reads them in the schema's. A bound is always the schema's.
- **The call-site check.** An application is checked against the parameter list: a value argument
  against its parameter's type (an enum argument matched in the enum's form), and a type argument
  against its bound. This holds wherever the application stands, including a composition operand
  and a declaration naming the application.
- **Parametric modifiers take the name mark their literal spelling takes (§3.2 item 33).**
  `w?: T ~ N` is a default, `w?: T = N` an injected pin, and `w: T = N` a marker. `w: T ~ N` is
  refused. Closing changes neither `optional` nor `role`. This reverses the Revision 36 reading
  recorded in `REVISION-36-PLAN.md`'s "to report upstream" list.
- **A family member is declared (#4, §8.2 item 10).** A use-site application is a type read where
  it is written, and is not a member. An instantiation of a family base carries the template in its
  `supertypes` only where a declaration names it. A use-site application whose result composes onto
  a record is a resolver error, located at the declaration that wrote it (or at the declaration
  whose closing minted it, §8.2 item 2). The error names the fix.
- **A family is judged over the closure (§3.3.4).** Two members brought together only by an import
  merge are the importing schema's error, with both origins named. Ingest re-runs the family checks
  over the closure.

Vectors: the eight template vectors in `schema/invalid` and `schema/valid`,
`a-family-member-applied-at-a-use-site`, `two-imports-adding-members-pinning-one-value`,
`a-family-base-dispatches-only-over-declared-members`,
`a-selector-base-applied-inline-is-read-structurally`,
`a-use-site-application-is-read-where-it-is-written`, the positional-enum-template vectors, the
two modified `applying-template-directly*` vectors.

### WP2C: identifier families, enum types, and normalization (#7, #19; Part 1 §2.6, §7.1, §7.7, §8.2; Part 2 §5.4, §5.5, §5.7, §7.4, §7.7, §11.4; change log §8.2 items 4, 8)

- **Start from what Stage 1 left.** `json/schema/atoms.ts`'s `identifierReader` applies §7.7's
  fixed grammar to every `identifier_type`, while the text side (`atomBuilder.ts`) checks none, so
  the two encodings disagree for any profile other than `identifier`. `link/disjointness.ts`
  decides an enum's class by the name `identifier`. Both move to the profile and the `type`.
- **Identifier profiles as data.** The profile is built from `start`, `continue`, `start_add`,
  `continue_add`, `medial` and `exclude`. A profile with an empty Start set, or a medial that is
  also Start or Continue, is refused. Join controls keep §7.7 rule 2's contexts under every
  profile. A profile's own additions are exempt from `Identifier_Status`, and a per-segment unit
  divides at the profile's own separators. The profile facets and `normalization` are **fixed at
  construction**: a refinement may not set or move them, and an instance refinement restates them
  verbatim. The Java is `base/unicode/IdentifierProfile.java` (its `separates` is the per-segment
  rule), `atom/parser/IdentifierParser.java`
  and `schema/meta/IdentifierType.java`. `src/unicode/` already holds the XID tables, and this port
  checks those tables in rather than consulting the host.
- **Normalization.** A text value is its token's text put into the type's form, and every facet and
  comparison judges that value. No comparison goes below NFC (§8.2 item 8): two text values are one
  when, each in its type's form, they are NFC-equal. Map-key and set-member identity read the key
  type's form, and so do enum members and selector pins. NFKC_CASEFOLD needs a case-fold table
  (Java `base/unicode/NfkcCasefold.java`). Generate it as `gen-unicode-tables.mjs` generates XID,
  record its Unicode version, and never consult the host for it. ASCII_CASEFOLD folds A–Z only, with
  no NFC or NFKC step (`ded0acc2`), so a full-width spelling stays distinct. A refusal names the
  token as `'written' (read as 'value' under FORM)` when the form changed it (`a001e62f`).
- **An identifier family's value is a name.** §8.2's per-name mechanisms reach it under the
  family's own profile. Name judgement reports **every** rule a name fails, `RESTRICTED_CHARACTER`
  before `RESTRICTED_SCRIPT`, so one name may draw two diagnostics. A look-alike pair is reported at
  the second element or key. An element that fails to read is excluded from both the duplicate
  check and the look-alike check (`4836f48d`). The keys of a map keyed by one, and the elements of a unique array (a set,
  or any `unique_items` array) of one, are look-alike scopes. This holds in data
  (`validate/refused`) and in schema-layer defaults, pins and annotation values (`schema/refused`).
  `( identifier | int32 )` is disjoint.
- **`enum_type`.** `type` names a text family, each member is a value of it, and no two members are
  one value under its equality. A pinned `type` resolves in the governing meta, and an
  author-written one in the schema's own namespace, so a schema's own `identifier` does not retype
  `!enum`. An enum's class is read from its `type`. A text enum beside text needs the tag. Java:
  `compiler/EnumLabels.java`, `resolver/EnumLabelType.java`.

Vectors: the identifier-, enum-, normalization-, casing-, NFC-, fold-, refused-, and
supplementary-character vectors in `schema/` and `validate/`.

### WP2D: atoms and positions (#5, #8, #10–#15, #20; Part 1 §2.2.1, §3.3, §5.2, §5.4–§5.6; Part 2 §5.4, §5.5, §7.1, §7.3, §7.5, §7.8)

- **URI and IRI.** `!uri` follows RFC 3986's grammar, not 2396's: empty host, empty path, IPvFuture,
  digits-only port. US-ASCII only, and a character beyond it is a **resolver** error. A relative
  reference under `!uri` or `!iri` is a **validation** error. Add `!uri_reference`, `!iri` and
  `!iri_reference` (RFC 3987, private use only in the query) to the built-in vocabulary, the
  schemaless reader, and the harness's vocabulary table. Facets: `schemes` (an ASCII-case-folded
  set, refusing a scheme outside RFC 3986, full-width schemes, and two casings of one scheme),
  `allow_relative` and `allow_fragment` narrow as permissions. Java: `tson-net/.../IriGrammar.java`
  and `Iri.java`, `atom/parser/UriParser.java` and `IriParser.java`. The IRI recognizer is
  hand-written, one function per ABNF rule, with no `RegExp`.
- **Remove WP2B's IRI shim.** `compiler/templates.ts`'s call-site value check skips `iri_type`
  because nothing parsed an IRI yet. Once one does, delete the skip, and
  `an-extern-of-names-an-iri-identity` must stay green.
- **A directive argument is an IRI-reference** (Part 1 §2.2.1, §3.3). An identity without a host
  has an absolute path. `extern_of` and `scoped.schemas` keys are `schema_identity`, so a fragment
  is refused.
- **A leap second** (`:60`) under `!time` and `!datetime` is a resolver error.
- **`!integer`** joins the built-in vocabulary, and the four sign bounds leave it.
- **`value`/`void` by constructor.** `void` admits the void sentinel, and `value` is the atom with
  no class.
- **Containers.** `set<T>` admits `[]`. `tuple1<T>` and `voidable_tuple1<T>` are one-position
  tuples. `ordered` never changes what a document may write, and output keeps the order written.
- **A scoped push (#5, §7.1, §7.8).** A nested `!!schema` at a `scoped` position whose `scope` does
  not hold EXTERN is a validation error (the cell rule). At a position whose type is not scoped
  (a container of scoped elements included), it is a resolver error under a new code,
  `SCOPE_NOT_ADMITTED` (`5e2a3cec`).
- **Lengths count code points.** `min_length`, `max_length` and `length` count code points in the
  text, URI, IRI and email checks (`fd5a5acc`). A JS `.length` counts UTF-16 units, which is the
  bug the reference fixed in its own host.
- **A bare annotation in a schema document** is read as `_` against its type, so a non-void
  annotation written bare is refused (`2b275794`). `@deprecated` is now `void`.
- Atom-family facet coherence for the URI/IRI facets. `a-uri-is-never-normalized` and its siblings
  check that `normalization` is fixed to NONE on those constructors.

Vectors: every `uri`/`iri` vector in Class 1 and Class 2,
`directive-argument-beyond-us-ascii`, the extern-of vectors,
`a-nested-schema-on-a-container-of-a-scoped-type`, `an-empty-set-is-a-set`, the one-position
tuple vectors, `a-container-states-whether-order-is-part-of-its-value`,
`a-schema-importing-core-declares-the-names-core-leaves-free`,
`a-bare-annotation-whose-type-is-not-void`, `the-void-sentinel-at-a-void-position`.

**Gate:** 459/459.

## Stage 3: behaviour the change log does not state

The reference carries behaviour between the pins that no change-log item names. Two packages over
disjoint files, run in sequence.

### WP3A: refusals, policy and identity

- **A name refusal is not a verdict (`b7d84f1d`).** `CONFUSABLE_NAMES`, `RESTRICTED_CHARACTER` and
  `RESTRICTED_SCRIPT` join the non-verdict codes, and `core/diagnostic.ts`'s `isVerdict` is the one
  list that changes. Add an `isNameRefusal`. `tson validate` reports a refused file as
  `NOT_CHECKED` and still exits 1. The exit ladder is unchanged. Check that the conformance
  harness's `refused` assertions still hold: they read `isVerdict` and must not keep a copy.
- **A schema-load name refusal carries its §8.2 code** and a pointer to the refused key, not a
  generic schema error (Java `SchemaRefusalException`, `30d4f2b7`).
- **Processor policy (Part 1 §8.2, `policy.tn`).** Split the existing name policy as the reference
  did. `ScriptPolicy` is a UTS #39 level plus its permitted scripts, with no per-segment option.
  `IdentifierPolicy` is a script policy plus `perSegment` and `skeletonDistinctness`, with
  `defaults()` and `none()`. The processor policy holds an identifier policy, a token policy (a
  `ScriptPolicy`), limits, and the UTS #39 data version. Keep relaxation a code decision at the
  call site, never ambient (CLAUDE.md). **`policy.tn` is a fourth bundled schema**, registered with
  the standard library and served by identity as meta and core are. Nothing loads a policy
  document, and no document selects its own policy.
- **Identity (Part 1 §2.2.1).** An identity is parsed as RFC 3987. With no authority it is the
  absolute path, so `/x.tn`, `file:/x.tn` and `file:///x.tn` are one identity, and a relative path
  with no host is refused. A non-ASCII host is admitted. Fragment, userinfo and port stay refused,
  and the host must be lowercase. The fetch side reads the raw path, undecoded.
- **Wording.** A missing required field reads `(missing)`, never `(absent)`. Rule names and
  messages say "void" and "void sentinel".

### WP3B: `strip` and the CLI

- **`strip` (Java `TsonSchemaStripper`, `StripCommand`).** It parses a schema document, drops
  `!!id`, drops a header argument's `?query` while keeping its `#fragment`, and shortens a bundled
  identity (`meta-kernel`, `meta`, `core`, not `policy`) to `"37/core"`. It drops `@doc`, `@title`,
  `@examples` and `@comment`, or only `@comment` under `--keep-docs`. Output is one line per header
  directive and per declaration, with the schema map's `}` on its own line, runs of whitespace as
  one space, and quoted strings re-emitted single-line. The output is re-lexed and re-parsed, and a
  mismatch is an internal fault. As a library function it belongs in the compiler. In the CLI,
  `tson strip [--keep-docs] <schema>` prints to stdout and exits 0, 1 for a malformed schema
  (`file:line:col: msg`), or 2 for usage or an unreadable file.
- **CLI policy.** Add `--identifier-allow-look-alikes`. The policy report gives
  `identifier_policy` four members (`level`, `per_segment`, `skeleton_distinctness`, `permitting`)
  and `token_policy` two (`level`, `permitting`). Scripts are named by their UAX #24 alias (`Latin`,
  `Old_Italic`). The CLI's diagnostics schema imports `policy.tn`. The CLI's examples and help move
  to `/2026/37/`.

**Gate:** 459/459, unit green, `npm run smoke:cli` green.

## Stage 4: Part 3, the JSON encoding

Part 3 defines no type-system rule. Each change spells, in JSON, a rule Part 1 or Part 2 owns, so
this stage follows Stage 2 and reuses what it built through the paths `src/json` may import. **If a
Stage 2 rule lives somewhere the JSON zone cannot reach (`compiler`, `reader`), move it to `link/`,
`schema/` or `atom/` rather than widening the zone.** The changes are change log §7.1 and §8.3, and
the reference's tson-json diff.

- **Void vocabulary (§6.1.2, §7).** JSON `null` is the void sentinel's spelling, and a member not
  written is missing. Messages follow.
- **Key identity (§3.1, §6.4).** Duplicate member names at a map position are judged after the key
  type's `normalization`, then NFC.
- **Atoms (§5, §5.2, §5.6).** Identifier families are string-class and take their profile and form.
  An enum member is matched in its label type's form. Text is put into its form before facets are
  judged. `uri` and `iri` refuse a relative reference, `uri` anything beyond US-ASCII. A leap
  second is refused.
- **Field groups (§6.1.4).** A group that is not optional admits exactly one option, an optional
  group at most one, and `+` any non-empty subset, under `FIELD_GROUP`.
- **Containers (§6.2, §6.3, §6.4).** A set may be empty. `tuple1<T>` is a one-element array. **An
  ordered map** (`ordered: true`) is delivered in the order read, in object form and pairs form
  alike.
- **Scoped positions (§3.3, §8.5).** Read them, where Revision 36 reported `NOT_IMPLEMENTED`. `$type`
  alone selects LOCAL. `$schema` with `$type` selects EXTERN: fetch the foreign schema through the
  registry, consume `$schema`, and read the rest as a `$type`-led object. A bare value, a missing
  `$type`, a cell the scope does not admit, or a schema or type outside `schemas` is a validation
  error. A type the schema does not declare is `UNKNOWN_TYPE`, and an unobtainable schema takes
  its fetch code. `$schema` at a position whose own type is not scoped is `SCOPE_NOT_ADMITTED`, a
  resolver error. Java: `DispatchScopedReader`, `ForeignSchemas`.
- **Name hygiene (§9.4).** An identifier-typed value is judged under its family's profile, and a
  refused value reads as nothing. An identifier-keyed map's keys, and a set (or `unique_items`
  array) of identifiers, are look-alike scopes. An array that allows repeats is not, and neither
  is a set of text.
- Port the reference's new and changed tson-json tests, case for case, as Revision 36's 4c and 4d
  did. Java-host binding cases are excepted.

**Gate:** the JSON unit tests, 459/459 unchanged, and the browser bundle builds.

## Stage 5: sweep

`/2026/36/` → `/2026/37/` across the unit tests, `README.md`, `skills/tson-ts/` and
`examples/web-demo/`. Version both packages 0.37.0. Refresh `STATUS.md` (459 subjects, the gaps),
`CLAUDE.md` (the `enum_set` quotation and anything the revision moved), `IDIOM-DEBT.md`,
`ORCHESTRATION.md` and `.claude/agents/tson-porter.md`.

**Gate:** the full CI list in `CLAUDE.md`, in order, green.

## To report upstream

- **§8.1's ingest has no implementation on either side.** "Ingest verifies a recorded parameter type
  and re-runs the family checks over the closure", but neither the reference nor this port reads
  resolved output back as a schema. The change log's §6 item 4 says so for the reference. The
  family checks here run over the merged closure, ready for such a path.
- **Removing a group's other options leaves the member's voidability alone (§5.11 Removal).** The
  Java's `dissolveInto` sets a surviving sole member's `voidable` from the group's `optional`. The
  spec says "the field's own voidability is unchanged", and this port follows the spec.
- **A map's elements may be void (§5.10.1).** The Java's inhabitance check ignores a map's
  `voidable`. This port reads it: a map is inhabited when its key is, and its value is either
  voidable or inhabited.
- **A group-shape refusal is a parse error in both implementations**, raised by the schema parser
  (Java `checkGroupShape`), although §5.11 states the rules as the resolver's. The vectors assert
  only `resolver`, the category of a schema that fails to load, so neither reading is tested.
- **`policy.tn` is outside `strip`'s shortening.** The reference shortens `meta-kernel`, `meta` and
  `core` and leaves `policy` its full URL. That may be deliberate, since nothing imports policy as a
  schema, but it is unstated.

_The rest is collected as the run goes._
