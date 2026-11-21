# Status

← back to the [README](README.md)

Built against TSON Part 1 (lexer + data format) of the **2026 Revision 40** series, a working draft:
https://tson.io/raw/2026/40/tson-part1-data.md, Part 2 (schema grammar + type system), also a
working draft: https://tson.io/raw/2026/40/tson-part2-schema.md, and Part 3 (the JSON encoding,
`./json`): https://tson.io/raw/2026/40/tson-part3-json.md. Revision 40 is proposed, not adjudicated;
the reference is pinned on its proposal branch, so a few small changes may still follow.

A TypeScript port of the reference Java implementation. Conformance is measured against the shared
corpus at https://github.com/litterat/ltr8-io-tson-test-suite, pinned to a commit — 1438 subjects
over `tests/<class>/<layer>/<bucket>/`.

**Conformance: 1438 / 1438 subjects passing at the pinned suite commit, Class 1 and Class 2.**

Class 1 (319): 28 identity, 35 lexer, 60 parser, 33 reader, 14 resolver, 149 vocabulary. Class 2
(1119): 516 schema, 222 link, 381 validate.

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
reason. §8.2's refusal is asserted as the outcome apart from §8.1's four categories that it is:
something was refused, _and_ nothing was also reported under one of the four. No position is ever
asserted. Every name is compared as written: no entry is minted (Part 2 §8.2), so nothing carries a
resolver-chosen suffix. An expected resolved form lists complete entries only, and the runner
compares each key's `@meta.application` and `@meta.completion`. An extern's schema is served by the
fixture rule an import's is, and a reference reaching the subject's own `!!id` is a cycle, never
served. A `parser`-category validate vector is judged by the subject failing a Class 1 parse, since
a Class 2 read reports base syntax under no category.

The identity layer (`class1/identity/`, RUNNER.md rule 3e) judges a subject's first directive
alone, nothing fetched: a `!!id` must be written in canonical form, an `!!import` may be any
spelling of its identity, and a `valid` vector's `identity` is compared byte for byte with the
computed canonical identity (`test/conformance/identity.ts`). Every subject is a complete document carrying its own `!!import` header; the corpus is served
through a `SchemaSource` and resolved on demand. A fixture schema's own records are read into a
generic `MetaValue`, so the runner supplies no host class for them.

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
- [x] Name hygiene (§8.2) — enforced by default and refused as an outcome distinct from §8.1's
      four categories. A record's field names are values of its name type and meet the per-name
      rules (`Identifier_Status`, restriction level) under that type's profile on read, with the
      look-alike rule applied to a declaration's names (§11.4); a type-ref or annotation name sees
      the two per-name rules but not the look-alike one, a lone name having no scope to be distinct
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
      beyond US-ASCII, an IRI admits `ucschar`/`iprivate`; a `!!id`/`!!import` argument and a
      schema identity are read as IRI-references
- [x] Identity (§2.2.1) — an identity is parsed as RFC 3987 and its host is a `host` value (an
      `ireg-name` a `hostname`, an `IPv4address` an `ipv4`, an `IP-literal` an `ipv6`; IPvFuture and
      zone identifiers refused); the canonical identity is the host's canonical text plus the
      path, the path NFC, no scheme and no query. A `!!id` must be written in canonical form; a
      reference may use any spelling — the other label form, ASCII case, an uncompressed or
      bracketed IPv6 address, percent-encoded UTF-8 with hex case ignored — and is read to canonical
      form before comparison. With no authority it is the absolute path, so `/x.tn`,
      `file:/x.tn` and `file:///x.tn` are one identity; a relative path with no host, a fragment,
      userinfo and a port are refused (`link/identity.ts`, `source/reference.ts`)
- [x] Field names (§2.5, §7.1) — a field-name position admits any single-line token, and the
      identifier match moved from the parser to the resolver: `{ "first name": 1 }` parses, and
      with no schema in scope a name that is no identifier is a resolver error. A document that
      names a schema has its field names judged by that schema alone, so a Class 1 processor
      reading one holds them to no name rule. Annotation and type-annotation names stay parse
      errors (§7.7)
- [x] An unknown schemaless type annotation (§6) — `!nonesuch` in a document with no schema in
      scope is a resolver error in the schemaless reader and the tree, where it was a preserved
      marker; `@` annotations stay preserved uninterpreted
- [x] Void vocabulary (§2.9) — `_` is the void sentinel throughout: tree node `'void'`, token
      `'void-token'`, diagnostic `VOID_MAP_KEY`, `VoidNode`/`voidNode`/`VOID`, `VoidValue`,
      `VoidEvent`, `Emitter.voidValue()`, following the reference's `TsonVoid`/`VoidValue`/
      `VoidEvent`. **Breaking at 0.37.0:** the Revision 36 names (`AbsentNode`, `absentNode`,
      `ABSENT`, `'absent'`, `ABSENT_MAP_KEY`, `Emitter.absentValue()`) are gone. A required field not
      written reads `(missing)`, and "absent" survives only for a field or facet a body does not
      state
- [x] The data grammar carries no reference (§2.3, §2.4, §4.1, §7.2.5, §7.5) — six core-value
      kinds, no argument list and no sibling form: `<` and `>` are reserved for the schema grammar
      and a parse error wherever a value stands (a field, an element, a map key, a schema
      document's payload read as data, a resolved form read as data), and `kind!` is a parse error
      by the separator rule, `!` being the type prefix alone. A schemaless read reads a qualified
      name as the token it is. A quoted token at a position typed by a reference is the reference
      its text spells (`schema/referenceAtoms.ts`); the lexer is unchanged
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
- [x] Identifier types — `uuid`, `uri`, `uri_reference`, `iri`, `iri_reference`, `email`
- [x] The network library (`net.tn`; §5.5) — `ipv4`, `ipv6`, `cidr4`, `cidr6` and `mac`, and three
      string-class atoms whose value is the canonical text, so two values are one exactly when
      their canonical texts are equal (`atom/network/`, hand-written, no `RegExp`): `hostname`
      (IDNA2008: A-label or U-label in any mix, ASCII fold only, nothing mapped, NFC, the hyphen
      and contextual rules, RFC 5893's Bidi rule, 63 and 253 octet bounds in A-label form; facet
      `allow_idn`), `host` (a `hostname`, an IPv4 address or an IPv6 address with or without
      brackets, no zone identifier, no IPvFuture; `[::1]` and `::1` one value) and `media_type`
      (RFC 6838 with RFC 9110 parameters under `allow_parameters`; facets `types` and `suffixes`;
      names and `charset` compared without ASCII case, parameters a map). The IDNA2008 derived
      property and `Bidi_Class` are checked-in tables (`unicode/idna-tables.ts`,
      `unicode/bidi-tables.ts`), never the host's
- [x] Binary types — `base64`, `base64url`, `base32`, `hex`
- [x] Temporal types — `date`, `time`, `datetime`, `duration`
- [x] Tree model — `Value` nodes, RFC 6901 pointers
- [x] Writers — streaming emit, optional `!!id`/`!!import` header
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
- [x] The kernel, one namespace per schema (§4.1, §4.2, §8.1) — `spec/m/meta.tn` loads and its resolved form
      matches `spec/fixtures/meta-resolved.tn` (83 entries, 80 written; the wait cycle around
      `meta.record` holds 31 entries and its closure 66). An entry is its value: a resolved schema
      is a map from name to `Top`, a closed union of a type, a value, an incomplete entry, an
      alias, an extern and a namespace value (`schema/meta/`). `type` is a kernel kind that
      `atom`, `product` and `sum` compose (`meta.apply` and a dependent sum compose it directly),
      and every type carries `chain: { parents? supertypes? subtypes? }` — `parents` what was
      written, `supertypes` and `subtypes` sets of bare names, IS-A read off the chain. No entry has
      a derived kind label: a consumer reads a kind from the constructor. `top`, `type`, the three
      base kinds and `namespace` are ABSTRACT, and applying one directly is refused
- [x] Types written in place (§4.2, §5.2, §5.3, §8.2, #5) — a type slot holds a name or a type
      written in place, `meta.type_expr` (a `meta.type_ref` or a `meta.type_inline { of }`).
      Nothing is lifted, minted or merged: sugar (`[T]`, `{K => V}`, `T?`, a record body, an applied
      constructor) resolves where it stands to `{ of: !C { … } }`. A type in place has no name, no
      chain and no parameters, IS-A nothing, is named by no tag and is a member of nothing; a name
      and a type in place are never one type, two equal types in place are one, compared canonically
      (`schema/meta/typeInline.ts`); a diagnostic locates one by its field path. A value at such a
      position carries no tag in the tree. A choice that is not disjoint names every variant
- [x] Parametric records (§5.10, §5.10.1, #3, #18, #20) — a parametric record is a `meta.record` with
      `parameters`, and nothing else takes parameters. A parameter is a type, standing at a field's
      type, at a slot of a type in place there, or as an argument; anywhere else a resolver error
      naming the slot. A bound is written, never inherited, names a type and not a constructor, and
      a parameter passed to a bounded one carries a bound that IS-A it
      (`compiler/parameterTypes.ts`). `H<args>` is `meta.apply`: declared, the substituted record
      under that name carrying `@meta.application`; at an operand absorbed; at a type slot closed in
      place, never looked up; over a parameter held until the holder is applied
      (`compiler/parametricMaterialiser.ts`, `compiler/substitution.ts`). No application is IS-A
      its head; no position, operand or `subtypes` index names a parametric record bare; an alias of
      one is another name for it. A recursive application ties to the declaration closing it
      (`compiler/heldRecursion.ts`), a record that could never close is refused at its declaration,
      closing holds each parametric record at most once on a path
      (`compiler/parametricRegularity.ts`), and a family is an abstract base, a parametric record
      composing it and members composing a declared application (`compiler/familyJoiners.ts`). A
      canonical application is compared by a string key (`compiler/canonicalApplication.ts`)
- [x] Namespaces (§4.1, §5.12) — `namespace` is a constructor whose instances are maps
      (`meta.map & { … }`), and `schema` and `field_map` are its two kernel compositions; a schema
      declares its own, and an entry applying one is a value, never a type (naming it where a type
      is expected is a resolver error). A record's `fields` is a map from name to `record_field`
      with no `name` inside, so a name written twice is a duplicate map key. A schema's own
      namespace records are read into a generic `MetaValue` directed by its declarations
      (`schema/namespaceReader.ts`)
- [x] References, qualified names and values by name (§4.2, §5.3, §5.12) — `meta.ref` is the one
      reference constructor and its `of` says whether it names types or values. A qualified name is
      the text of one token of either form, split at `.`, each segment a name of the family of what
      it enters and matched in the family's form (so `get` selects `GET` under a case-folding
      family); a namespace `key_type` or a record `name_type` admitting `.` is a resolver error. A
      reference over a constructor admits every type built with it
      (`link/kindMembers.ts`); a reference over values is judged at link step by step through
      namespace keys and record fields (`link/valuesByName.ts`); a slot typed by a type holds the
      value inline
- [x] `@meta.application` — a derived key annotation, a `meta.apply` value, on a declared
      application's key alone; applications compare as values, head and arguments
- [x] `@meta.completion` — a derived key annotation naming the incomplete entries a declaration
      completed (§8.1), compared by the harness beside `@meta.application`
- [x] Open construction and incomplete entries (§5.5, §5.7, #10) — `!C ^ { values }` over a constructor
      declares an incomplete entry: no type and no value, written field by field through
      `!X ^ { values }`, completed by `!X { … }`, `!X value` or `X<A …>`, imported like any entry,
      written in no resolved form, and refused wherever a type is named (a field's type, a variant,
      a bound, an operand of `&`, a reference's `of`, an annotation, a parameter's name, a tag in
      data) (`compiler/incompleteEntries.ts`). The kernel's `meta.set_type` and `enum` are
      incomplete entries and `set` an alias of `meta.set_type`. `C<args>` over a constructor is
      construction over its argument slots — the required fields holding a type, in declaration
      order (`compiler/constructionRewrite.ts`, `compiler/constructionSugar.ts`)
- [x] Record derivation and restatement (§5.7, §5.8, #11, #12) — `^` follows `!name` and takes
      values; `&` is the one way to derive a record; `!R ^ { … }` over a record is a resolver error
      naming the composition; a restated field's rules are judged at link
      (`compiler/restatements.ts`, `link/restatedFields.ts`). `!T ^ { values }` refines a type built
      by `meta.array`, `meta.map` or a constructor IS-A either, namespace types included
- [x] Dependent fields (§5.2, #6) — a dependent field's type is a sum written in place, `{ of:
!meta.dependent { on: kind } }`, whose sugar `kind!` stands at a record field's or a group
      member's type alone; `on` is `text`; its sibling is typed `meta.type_ref` or
      `meta.type_expr` (`link/dependentFields.ts`)
- [x] Choices and tags (§5.4, §7.2, #15) — a tag at a choice names a variant, or a type that IS-A
      exactly one, by the entry it reaches; a tag IS-A two variants and naming neither is a
      validation error; a choice listed as a variant is disjoint; variants compare in order
      (`link/choiceSelection.ts`)
- [x] Externs (§5.13, §7.9, §11.5, #13) — `!meta.extern { schema: …  type: … }` names one entry of
      another schema under a local name: a hop judged by its target's identity, naming a type a value
      can have, sealed against `&`, `-`, `^`, a construction or application head, defaults, pins and
      qualified names through it (`link/extern*.ts`). The foreign schema is a dependency loaded with
      the imports (`Tson.loadSchema`) on the same library, policy and kernel, the reference
      relation acyclic, the import-closure count including it. A value at an extern position is
      read under its own schema in TSON text, the tag in front of it the enclosing scope's, and a
      diagnostic inside it names the foreign schema and the extern
      (`compiler/externReader.ts`); binding to host classes is `NOT_IMPLEMENTED`, as in the
      reference
- [x] Declared applications as entries — a declaration naming a fully-bound application
      (`bx => box<text>`) resolves to the closed record itself under that name, no twin and no
      alias hop; a use-site application closes in place
- [x] Enum classes (§5.4) — an enum's class is read off its members under its `name_type`;
      `enum` is an incomplete entry, so a slot holding an enum type is `meta.enum_type`, and
      `enum_set`'s element type is `text`
- [x] `text_type.members`, settable once beside `pattern` (also settable once); every member
      checked against the facets beside it
- [x] `disjoint` class stability — an approximate atom still admitting NaN or infinity, and a map
      keyed by a compound type, are never disjoint in any encoding
- [x] One namespace per schema (Part 2 §2.2.3) — a schema's imports merge into the one namespace it
      resolves in (`link/importClosure.ts`): a diamond is unified by identity, a name two imports
      declare differently refuses the whole namespace, and a data document's several `!!import`s
      read under a schema of no entries of its own importing each (`Tson.readDocument`,
      `Tson.validateDocument`). A schema's closure holding the kernel reserves its root names and
      the six map names (§9)
- [x] Refused and undetermined (§8.1, §10.1) — two outcomes beside the four error categories,
      neither a verdict on validity. _Refused_: this processor declined the document under its own
      configuration (§8.2's policy and data version, §9.1's limits, a schema it will not fetch or
      one past its size limit), naming the rule or limit. _Undetermined_: it could not obtain what
      it would judge against (nothing at the reference, no answer), located at the reference. A pin
      mismatch stays a resolver error. A refusal under a fetch policy names the reference and not
      the hosts it would have fetched from (§11.2)
- [x] All-or-nothing reads — a document that reported anything yields no value, in tree mode and
      bind mode alike; there is no tree placeholder for a refused value, so a void node always
      means a written `_`
- [x] Name hygiene at the schema layer (§11.4) — the four scopes §11.4 names: one enum's members,
      one record's field names including group labels, one schema's declared names, and the merged
      namespace at `!!import`, where two schemas each clean alone collide on import; plus a fifth
      this implementation adds, a parametric record's own type parameters, which §11.4's list omits though
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
- [x] Bounded parameters (§5.10, #9) — `<T: bound>`: a bound is written and names a type; an
      argument outside its bound is refused where the application closes, and an argument is a name
      or a parameter, never a literal, a sugar form or an application (`compiler/parameterTypes.ts`)
- [x] Declared family members (§5.2, §5.10, §8.2) — a family's members are the declarations that
      name them; two members pinning one selector value are refused, comparing pins under the
      selector's own type; only a pin on an _unmarked_ name is a selector; a value placed by its
      pins waits on each declaration that may be its member (item 101)
- [x] Identifier families (§5.4, §5.5, §7.7, #7) — `identifier` is a text family with a profile
      (`identifier_type`: `start`/`start_add`/`continue`/`continue_add`/`medial`/`exclude`,
      `normalization`), refinable but fixed once moved; a value of the family is a name, so §8.2's
      mechanisms reach it under its profile (`unicode/identifier-profile.ts`)
- [x] `enum_type` (§7.4) — an enum's `name_type` is an identifier family whose form implies
      NFC, and its members are judged under that type's profile; a pinned `name_type` is followed
      through enum refinements to the constructor that pins it, and a
      schema's own constructor refining `enum_type` reads through its binding. A closed set of
      text is `!text ^ { members }`; an enum over a text family is refused. A narrowed member set
      keeps the inherited order
- [x] Name types (Part 2 §5.2, §7.2, §7.7, §11.4; Part 1 §2.5, §8.2) — a record's field names are
      values of its `name_type`: set where declared, a composition's supertypes' one type
      (applications at an operand included), `meta.identifier` by default (item 123), resolved in
      the author's namespace first. Judged at link (`link/fieldNames.ts`): an identifier family, `NONE`
      refused, `ASCII_CASEFOLD` only over an all-ASCII profile, every declared name and selector a
      value, two spellings of one value refused; a profile may add no Default_Ignorable, control,
      or space but U+0020. The tree reader matches a document's names in the type's form, judges a
      name by the type before closure, and holds a value of it to §8.2 under the type's profile
      (`reader/tree/fieldNames.ts`); a sealed family's selector is found in that form too. The JSON
      reader applies the same rule (`json/schema/record.ts`, over the shared
      `link/fieldNameRule.ts`), judging an unmatched name under the type's profile before closure
      (Part 3 §9.4). Bind mode has no schema in view and matches the wire name exactly
- [x] `ordered` (§5.3, §7.5) — part of array and map identity: a unique array of unordered arrays
      refuses a reordering, a map's entry order matters only when `ordered: true`
- [x] `void` and facets by family — `void_type` in the kernel; every facet holding a value of the constrained
      family is typed by that family's own instance and every count by `numeric.count` (#16, #17)
- [x] Processor policy (Part 1 §8.2, `m/policy.tn`) — `TokenPolicy` (a UTS #39 level and its
      permitted scripts; `policy.token_policy`, whose two loosest levels judge a token alike),
      `IdentifierPolicy` (a level, the permitted scripts, `perSegment` and
      `skeletonDistinctness`), §9.1's limits (no materialisation-depth limit: closing holds each
      parametric record at most once on a path) and the UTS #39 data version, held in
      one `ProcessorPolicy`. `policy.tn` is the sixth bundled schema, served by identity; nothing
      loads a policy document and no document selects its own policy. A name refusal
      (`CONFUSABLE_NAMES`/`RESTRICTED_*`) and a §9.1 limit refusal (`LIMIT_REFUSED`) are not verdicts (`isRefusal`), and a schema-load
      refusal carries its §8.2 code and a pointer to the refused key
- [x] Resolved output names the applied constructor (§8.1) — a closed entry is written under the
      constructor recorded in its facts (`!numeric.integer_type { … }`, `!meta.record { … }`), a
      completion under its base constructor (`!meta.array { … }`, `!meta.enum_type { … }`) with
      `@meta.completion` on its key; a type in place as `{ of: !C { … } }`; a parametric record as
      `!meta.record { parameters: … }`; no synthetic entry, no incomplete entry, no kind label. The
      five bundled fixtures (`spec/fixtures/*-resolved.tn`) compare equal in written form
- [x] `tson strip` (`compiler/strip.ts`, the reference's `TsonSchemaStripper`; `tson strip [--keep-docs] <schema>`) — drops `!!id`,
      a header argument's `?query` and the reader-facing annotations (or none under
      `--keep-docs`), shortens a bundled identity (`meta`, `numeric`, `temporal`, `net` and `core` become `"40/net"` and so on),
      and re-parses its own output
- [x] Desugaring — every sugar form resolved in place where it is written (`compiler/desugar.ts`)
- [x] Resolution — composition, refinement, constructor application, construction, parametric
      records and their applications
- [x] Linking — reference validation, transitive `!!import` merge (diamonds unified), `subtypes`
      reverse-index population, choice disjointness and `@disjoint` assertion checking
- [x] Identity and hashing — canonical `!!id` (`link/identity.ts`), `?sha256=` pinning and content
      hashing via a hand-written, zero-dependency SHA-256 (`link/contentHash.ts`'s own
      `sha256HexSync`; `sha256Hex` is the same computation wrapped `async` for existing callers).
      Registering a schema (`config.ts`'s `resolveSchema`/`loadSchema`/`preload`) pin-checks it like a fetched
      one either way — its own `!!id` pin against its own content, and a later pinned reference to
      its identity against the recorded hash
- [x] Bundled schemas — `meta.tn` (the kernel), `numeric.tn`, `temporal.tn`, `net.tn` and `core.tn` resolving
      end to end, and `policy.tn` served by identity; the first five match their `spec/fixtures/*-resolved.tn`
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
- [x] Revision 38 changes (§1.3, §3.2, §5.6, §6.1.1, §9.4) — a member name is a value of its
      record's name type, matched in the type's form, a repeat under a folding type
      `DUPLICATE_FIELD`, an unmatched name the type admits held to §8.2 under the type's profile
      before closure; `$import`, `$type` and `$value` used and not reserved, so any other
      `$`-initial member is a field name; `$type` a qualified type name and a kind-typed slot one
      bare name judged a member; a namespace-typed slot read as its map;
      `hostname`, `host` and `media_type` string-class through the net atoms' parsers.
      **Two encodings, two spellings** (open): the text reader judges every field name, the JSON
      reader only an unmatched one, and a folded match's schema pointer is the written spelling in
      text and the declared field in JSON
- [x] Revision 37 changes (§3.1, §5, §6, §8.5, §9.4) — duplicate member names judged after the key
      type's `normalization`, then NFC; identifier families string-class under their profile;
      text put into its form before facets; `uri`/`iri` refusing a relative reference; a leap
      second refused; a set may be empty; a one-position tuple a one-element array; an `ordered` map
      delivered in the order read, object form and pairs form alike; `FIELD_GROUP` for a group
      that is not optional admitting exactly one option, an optional group at most one, `+` any
      non-empty subset; an identifier-typed value judged under its family's profile and an
      identifier-keyed map's keys a look-alike scope
- [x] Declared positions (§3.3, §3.4, §8.5; [TSON-SCHEMA] §7.8) — a `meta.declared_type` position
      (`json/schema/declared.ts`) reads an object led by `$type`, a qualified name read against the
      governing closure; a bare value or an object with no leading `$type` is `VALIDATION_ERROR`, a
      `$type` outside the closure `UNKNOWN_TYPE`. `$import` stands for the header's `!!import`s and
      at any value position is `SCOPE_NOT_ADMITTED` (`json/schema/tags.ts`)
- [x] Revision 40 changes (§1.3, §3.3, §3.4, §5.6, §6.3, §8.1, §8.3.1; change log §3.4, §4.7) — a
      JSON string at a reference holds a qualified name, each segment a name of its family, and
      `"set<text>"` and `"kind!"` are strings outside the grammar; a `$type`, or a root type
      supplied out of band, naming a parametric record is refused, and a type in place has no
      `$type`; `$type` at a choice names a variant or a type IS-A exactly one; one value, one
      type name (a wrapper's `$value` carries no `$type`); the map escape names the variant;
      sorting leads with the annotation members only for records of `meta.identifier` names; a set
      is described by its facets and a one-position tuple is declared
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
- [x] Standard library, embedded — `@ltr8/tson/stdlib`: the six bundled schemas as source-text constants generated from `spec/m/` by `scripts/gen-stdlib-schemas.mjs`, plus
      `standardLibrary(config?)` (a `Tson` with all six already registered, what the reference
      implementation's `Tson.builder().build()` hands back) and `registerStandardLibrary(tson)`.
      Its own subpath, never the default entry, so a browser consumer of `parse`/`readTree` does
      not carry the schema text it never looks at — verified against the built bundles, not
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
      a type with no registered binding, `70` library gap or fault, ranked `70 > 78 > 69 > 1 > 75`
      by who must act first (`75` only when an unanswering origin is all that went wrong). A run
      reports `outcome` — `ACCEPTED`/`REJECTED`/`UNDETERMINED` (Part 1 §8.1's refused outcome
      rejects; undetermined is what could not be judged) — rather than a boolean, so a document
      whose schema was never fetched is not reported rejected. The
      §8.2 policy is configurable from the command line (`--identifier-policy`,
      `--identifier-per-segment`, `--identifier-allow-look-alikes`, `--identifier-scripts`,
      `--token-policy`, `--token-scripts`, and the two depth bounds `--max-depth` and
      `--max-wait-depth`), stated once per run on the report in `policy.tn`'s
      shape (scripts by their UAX #24 alias), and printable with no document in hand via
      `tson policy`.
      Bootstraps its own copy of
      the six bundled schemas, embedded at build time from `spec/m/` via a generator script
      under `scripts/`, so `validate --schema`/`compile` work offline. Both load a schema
      with `Tson.loadSchema`, so what it imports and what its externs name are fetched too —
      from the other schema files on the command line alone, served by their `!!id`
      (`compile a.tn b.tn`; a repeated `--schema`, the first binding the run), never from the
      network or a directory; a reference no file declares is unobtainable (`compile` rejects,
      `validate` exits `69`). `hash` is read-only: it prints the pinned reference rather than rewriting the
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

- **Revision 40 gaps the reference carries too** (change log §5's "remainder" rows and the reference's
  `BACKLOG.md`; this port runs what the reference runs, so each is open in both):
  - **A name in a schema document's annotation value is not judged at link (#8, §5.12).** The
    value's shape is checked and the name is delivered unjudged; a data document's is judged at the
    read.
  - **A dependent field whose sibling holds a type written in place is not read by a tree read
    (#5, §5.2).** A tree read, in either encoding, reports the value as `NOT_IMPLEMENTED`; a sibling
    holding a dependent type is refused as naming no type a value can be read against.
  - **An instance of a constructor composed with `&` that adds a field, or that composes
    `meta.record`, cannot be applied (#11, §5.8).** It reports not implemented. A constructor over
    one constructor of types that adds no field (`minlist => meta.array & { min_items?: = 1 }`) is
    applied as its parent is, its pin in force (`schema/meta/composedOver.ts`).
  - **Five points on the extern (#13, §5.13, §7.9, §11.5; Part 3 §8.6).** In TSON text a root typed by an
    extern, and an extern reached through an alias of a container, write no boundary tag; a tag
    naming an extern at a position no extern types is refused in both encodings; a map key typed by
    an extern reports outside the foreign scope in JSON; no JSON writer writes a `$type`, a boundary's
    included. **Divergence from the reference:** the import-closure limit counts a schema an extern
    reaches (§11.5); the reference counts nothing.
  - **A field of an incomplete entry typed by a type written in place is read only where the entry is
    completed (§5.5).** A wrong value there is reported at the completion, and a name it holds is not
    judged when an entry never completed links.
  - **A float's bounds skip NaN and the infinities (#23).** `!float64 ^ { max: 100 }` accepts
    `+.inf` and `.nan`; an infinity is ordered and should be judged against the bounds, and a body
    with any bound admits no NaN.
  - **A float's bounds are compared after rounding (§5.5).** §5.5 validates a bound against the
    value as written, before rounding, so `!float32 ^ { max: 1.0 }` accepts a written `1.00000001`
    that rounds to `1.0`.
  - **An explicit `!meta.alias { target: C }` cannot be applied (§8.3)**, where the text applies the
    explicit spelling of an alias as its target is (`compiler/desugar.ts`'s `checkApplication`).
  - **A parameter's bound naming an alias of a constructor, a value entry or a bare parametric record
    passes (§5.10)**, where the text refuses a bound that names none of a type
    (`compiler/parameterTypes.ts`).
  - **A refinement switching a bound's strictness is refused (§5.7, §5.11).** `!p ^ { exclusive_min: 5 }`
    over `min: 1` merges to both options, and no spelling moves an inclusive floor to an exclusive one.
  - **Resolved output is not ingested (§8.1, §10.1).** A schema is always re-resolved from source,
    so no path reads a resolved `{ type_name => top }` map and verifies it: the family checks, §5.11's
    group rules and each reference-typed slot's name against its kind.

- **The bind readers have no dependent field (§5.11).** A dependent field reads through the tree
  readers in both encodings. The class-binding readers have no notion of a field whose type a
  sibling names, so a bound record with one is not read.
- **A JSON dependent member's order-exception refusal (§6.1.6) is positioned at the cursor**, not at
  the member, because the JSON read context carries no position override. No vector asserts a
  position.

- **An entry holding a namespace value has no JSON read path**: the JSON compiler reports
  `NOT_IMPLEMENTED` for it, as the reference's `ErrorReader` does. A namespace-typed _slot_ reads
  as its map in both encodings.

- **The JSON encoding's ([TSON-JSON]) scope is narrower than the full spec's, and in one respect
  narrower than the reference implementation's own** (`REVISION-36-PLAN.md`'s own "Scope
  decisions"; the reference records most of these as deferrals, not conclusions). Everything below
  except the object-binding gap matches a deferral the reference records too:
  - **§3.4's in-band root binding is not read.** A root led by `$import` is declined as a
    non-verdict `NOT_IMPLEMENTED` at `/$import` (`json/inBandBinding.ts`), as the reference does;
    every call to `readJsonTree`/`validateJson` requires `schema`/`root`, so binding is
    out-of-band only. `$type` tag dispatch _inside_ a document already bound out of band
    (subsumption, record families, choices) is implemented in full; what is missing is starting a
    read with no binding at all.
  - **§8.5's declared positions** (`meta.declared_type`) are read (`json/schema/declared.ts`)
    against the closure of the schema the position belongs to; the encoding has no registry or
    loader and fetches no schema.
  - **A value at an extern position (§8.6)** is read under its own schema (`json/schema/extern.ts`),
    the leading `$type` the enclosing scope's and every other name the foreign schema's; an
    `$import` at the boundary or inside the value is refused. `compileJsonSchema(linked, { foreignSchema })`
    reaches the foreign schemas (`JsonCompileDeps`).
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
    `$foo`, an `$import`/`$type` out of lead position, a `$value` with no leading `$type`, and extra
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

- **Resolved-output ingest is unimplemented.** §8.1 says ingest reads `chain` as stated, keeps
  `@application`, recomputes a kind's `members` and re-runs the family checks over the closure, and
  the change log (§6 item 4) records that nothing running does any of it, on either side of the
  port: resolved output is written, never read back as a schema. A later schema's application is
  therefore not unified with an imported library's declared one for the same reason. The family
  checks and the applied-parent fold run over the merged closure, ready for such a path.

- **`strip` holds the whole document in memory.** `compiler/strip.ts` parses the schema, rewrites
  it and re-lexes its own output, so memory is proportional to the document rather than to its
  nesting depth. A schema document is small and the command is a one-shot, so this is a deliberate
  departure from CLAUDE.md's streaming rule rather than an oversight.

- **A data document's annotations are preserved but never resolved (§6).** §6 says an annotation
  names a type reachable one hop through the governing target — the `!!import` closure for a data
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
  (`createTson({ maxNestingDepth })`), defaulting to §9.1's own 64. Exceeding it is a §8.1
  refusal — a `TsonLimitRefusedError` naming the limit and the configured threshold
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

- **Ten of [TSON-DATA] §9.1's eleven document-side resource limits are not enforced.** §9.1
  states a limits policy of eleven named counters, each MUST-enforced at its default or a
  configured value; this port builds the refusal mechanism and the nesting-depth counter alone on
  the document side (`core/limits.ts`). A deliberate scope decision, not an oversight: the pinned
  Java reference itself implements only `maxDepth` and leaves the other ten, and `CLAUDE.md`'s
  "structural parity is worth more than idiom while the reference moves" argument applies to limit
  _coverage_ too — a limit this port enforced and the reference did not would be a divergence
  nobody asked for. No vector in the shared corpus exercises any of these ten, so nothing here
  is measured red by it, but a document that exhausts one of them (a single 20 MB token, say)
  still reaches an unbounded read rather than a clean refusal. Unenforced, with §9.1's own
  defaults:

  | Limit                  | Applies to                                               | Default    |
  | ---------------------- | -------------------------------------------------------- | ---------- |
  | token length           | one token's decoded text, in code points                 | 1,048,576  |
  | decoded text length    | one value's text after escape processing, in code points | 1,048,576  |
  | numeric literal length | digits in one numeric token, annotated or not            | 4,096      |
  | decoded binary size    | one `!bytes` value's octets                              | 16,777,216 |
  | document size          | the document's bytes                                     | 16,777,216 |
  | elements               | one array or set                                         | 1,048,576  |
  | entries                | one map                                                  | 1,048,576  |
  | fields                 | one record                                               | 65,536     |
  | annotations            | on one value                                             | 64         |
  | total values           | all values in one document, containers and scalars alike | 16,777,216 |

  **All five of [TSON-SCHEMA] §11.5's schema-side limits are enforced**: import closure, schema
  entries, alias chain, supertype chain and wait depth. Each has its own refusal builder in
  `core/limits.ts`. They are enforced in these places, in that order: `config.ts`'s
  `resolveAgainstRegistry` (import closure, which counts a schema an extern reaches, and schema
  entries), `link/aliasChain.ts`'s `walk`, `compiler/definitionResolver.ts`'s
  `checkSupertypeChainLimit`, and `compiler/schemaResolver.ts`'s wait-order lookup. §11.5 makes all
  five a Class 2 MUST on the same terms as the document-side limits. Closing an application is
  bounded by structure, not by a limit: each parametric record of the closure is held at most once on
  a path. Each is configured on the instance through
  `Config.limits` (`withLimits`), with one exception: the alias chain is walked at its §11.5 default,
  `DEFAULT_MAX_ALIAS_CHAIN`, as the reference's `AliasChain` is, so a stated `max_alias_chain` is
  reported but not consulted. `Tson.limitsPolicy` reports all sixteen thresholds, and so do the
  CLI's `tson policy` and every `validate`/`compile` report (`limits_policy`, beside `policy`),
  reachable with no document in hand, as §9.1 asks.

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
- **The five fixture-backed bundled schemas resolve, link, and match their fixtures in written
  form, with one documented difference.** `subtypes` is exact against `meta-resolved.tn`, and every key annotation (§6) now resolves with its
  value: `schema/annotationReader.ts` reads one through the governing meta's own compiled reader
  for the annotation's name, over `compiler/dataValueEvents.ts`'s replay of the written value.
  `@meta.application` and `@meta.completion` are compared against the fixture exactly; `@doc` is compared against the **source
  document** instead, because `*-resolved.tn`'s own header says it carries long `@doc` strings
  abbreviated and that "a conforming resolver preserves them verbatim" — so the fixture cannot be
  the oracle for their text, and the source is a stronger one.
  `packages/tson/test/bundled-schemas-resolve.test.ts` holds the difference as an assertion
  rather than a skip.

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

- **A `record_field`'s own annotations are bound as an ordinary `annotations: [ … ]` member, where
  §3.1 puts them in front of the value.** `bundled-schemas-resolve.test.ts` lifts the member into
  the framing position on both sides so the comparison stays about _which_ annotations a value
  carries. An entry's value annotations are an entry fact (`EntryFacts.annotations`) and a key's
  are a separate carrier (`Schema.keyAnnotations`, `LinkedSchema.keyAnnotations`), neither a field
  of any constructor. `type_ref`'s own case is closed: `schema/bindings.ts`'s
  `typeRefAnnotatedBinding` reads and writes the framing in both directions, so a use-site `@alias`
  round-trips.

  The cause for `record_field` is a genuine type mismatch, not an oversight:
  `bind/binding.ts`'s `RecordBinding.annotationsCarrier` is typed against `annotations/index.ts`'s
  wire `Annotations` (`{ values }`, each value a raw `DataValue`), while `schema/meta` carries
  resolved annotations (`readonly Annotation[]`, each value a _bound_ host value). A
  `RecordBinding` cannot convert between them through that hook: wire to bound needs a reader for
  the annotation's type, and bound to wire needs an atom encoder, neither of which the carrier hook
  is handed.

## Scaffold

- [x] Workspace, tooling, CI
- [x] Frozen contract layer — the types every work package builds against
- [x] Conformance harness — discovers and pairs every vector at the pinned suite commit, under
      RUNNER.md's rules, the identity layer's rule 3e included
- [x] Reference fetch — pinned Java source and the vector suite
- [x] Vendored `spec/` — the three spec parts, the Revision 40 change log and the six bundled
      schemas with their five fixtures, byte for byte
- [x] Unicode tables — `XID_Start` / `XID_Continue` / `Nd`, generated and checked in
- [x] IDNA2008 and Bidi tables — RFC 5892's derived property and `Bidi_Class`, generated into
      `src/unicode/` by `scripts/gen-idna-tables.mjs` and `scripts/gen-bidi-tables.mjs` and held to
      the other tables' recorded Unicode version by `check:unicode`
- [x] UTS #39 tables — `Identifier_Status`, the confusables skeleton map, script data and the
      joining-control properties, generated into `src/unicode/` by `scripts/gen-uts39-tables.mjs`
- [x] I-Regexp general categories — all 36 of RFC 9485's, generated into the `regex/` leaf
- [x] Orchestration — `ORCHESTRATION.md` and the eight wave scripts under `.claude/workflows/`
