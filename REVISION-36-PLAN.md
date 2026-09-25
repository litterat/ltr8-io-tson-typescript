# Revision 36 plan

Taking this port from 2026 Revision 35 to Revision 36. `ORCHESTRATION.md` says how a run is driven —
one Opus manager, Sonnet `tson-porter` sub-agents writing every line of implementation, a gate
between stages — and that shape is unchanged. This file says what the stages contain, and why.

Read `CLAUDE.md` first. Its hard constraints bind every agent in every stage. The adjudicated change
list is `spec/tson-rev36-changelog.md`; its §4 digest is the shortest statement of what an
implementer must act on.

## What moves

|                           | Revision 35                                | Revision 36                                           |
| ------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| `JAVA_PIN`                | `6655418d666e26e333e8f3a17f3374c2e603951d` | `0c1512c766a70792b409db3e5f6a717ae68ebd15`            |
| `SUITE_PIN`               | `96f4f7870d23c3bb0b4f0061c6945e8c2e3d2ed6` | `f9fa96f09f5e74dc45b40ceca48fa6dd8115464d`            |
| Conformance subjects      | 277                                        | **328**                                               |
| Spec parts vendored       | Parts 1, 2                                 | Parts 1, 2, **3 (JSON encoding)**, and the change log |
| Bundled schema identities | `tson.io/2026/35/m/*`                      | `tson.io/2026/36/m/*`, all three digests new          |
| Package version           | 0.35.0                                     | 0.36.0                                                |

The reference moved 376 commits (+52k/−15k). About 95 of them are the new `tson-json` module,
roughly 150 touch the modules this port mirrors, and much of the rest is internal restructuring —
a `tson-base` module split, bind-target plumbing, allocation work — with no observable behaviour to
carry. The spec-driven core is smaller than Revision 35's and differently shaped: 35 rebuilt
`type_definition`; 36 rebuilds **`record_field`** and gives `record` two new facts.

## Stage 0 — Pins and vendoring (done, `5220fe4`)

Both pins moved, `spec/` re-vendored, `tson-part3-json.md` and `tson-rev36-changelog.md` added to
it, bundled identities to `/2026/36/`, stdlib regenerated. Class 1 stays green; all 107 Class 2
failures share one cause — `parseFieldDef` meets `extension?:` at meta-kernel line 125 and throws,
so the kernel never bootstraps.

## Stage 1 — The field model, the grammar, and the bootstrap

**One Sonnet package, alone, manager-reviewed before anything fans out.** It is the contract layer
(`schema/meta/`, `ast/schema/`) plus every consumer that must change for the kernel to load and for
`tsc` to pass — which, because `FieldState` is deleted, is most of them. Splitting it would leave
two agents compiling against a half-changed model.

**Model (`schema/meta/`)** — every Revision 36 field at once, since the model is frozen during
fan-out:

- `RecordField` is four facts: `optional`, `voidable`, `role` (`FieldRole = FREE | DEFAULT |
FIXED`), `value?`. `FieldState` is deleted. What omission yields is derived, never stored.
- `RecordBody` gains `extension` (`RecordExtensionType = ABSTRACT | FINAL | OPEN`, default OPEN)
  and `discriminators: string[]`, and `supertypes` becomes `TypeRef[]` (`TypeDefinition.supertypes`
  stays names).
- `TemplateBody` gains `extension?` and `discriminators?` — optional with no default; absence means
  "this template is no type".
- `EnumBody` gains `profile` (`IDENTIFIER | TEXT`, default IDENTIFIER); `enum_set`'s element type is
  `text`, not `identifier`.
- `TextType`, `RegexType`, `UriType`, `EmailType` gain `members?`.

**Grammar (§12.1)** — `field-name ["?"]`; `field-modifier = ("~" / "=") token / "=" "?"` (the
absent sentinel is no longer a modifier value); `group-member … type-ref ["?"]`; and
`[definition-mark ws]` in `schema-map-entry`, read unconditionally, with `abstract => { … }` still an
ordinary declaration. The AST carries the name's `?`, `voidable`, a selector modifier variant, a
voidable group member, and `Declaration.mark`.

**One field-marks table.** It exists twice today — `compiler/fieldModifiers.ts` and a private copy
in `desugar.ts`. Merge them into one (the Java has one, `FieldModifiers.of`), carrying §5.2's four
refusals: a default on an unmarked name; a pin on a voidable type; a modifier on `void` or a `_`
value; `=?` on a marked name or voidable type.

**Consumers** — `desugar.recordBinding` (group members are `optional: true`), `wireForm.heldRecord`,
`definitionResolver`'s field functions (refinement is **three orders** — omission, voidable, role —
replacing the five-state matrix; §5.11's "two always present" rule refuses nothing now and its code
goes), `schema/bindings.ts` and `metaReader.ts` (positional form counts unmarked names; injection is
`optional && value`), `bootstrap.ts`, `templates.ts` (a parametric `= P` closes optional and FIXED),
`reader/tree/record.ts` (`_` decided by `voidable`; omission is MISSING / VALUE / NOTHING; a written
`_` at a voidable field stays in the tree), `bind/strictness.ts`, `link/typeInhabitance.ts`
(a field is inhabited if optional or voidable), `link/referenceValidation.ts`. And the
resolved-output writer, to the four-fact form and source-order sets (#4).

Marks and `=?` are **parsed and lowered** here (`extension`, `discriminators` populated) but their
rules are Stage 2's.

**Gate:** kernel, meta and core bootstrap; `bundled-schemas-resolve.test.ts` green against the Rev 36
`*-resolved.tn`; Class 2 measurable; the #23 vectors green — `each-field-mark-answers-one-question`,
`a-field-that-admits-only-absence`, `record-with-optional-field`, `a-default-on-a-key-that-is-always-written`,
`a-pin-on-a-voidable-type`, `a-pin-to-absence`, `default-on-a-record-typed-field`,
`a-void-field-the-document-must-write`, `a-marker-left-out`, `a-required-voidable-key-left-out`,
`an-optional-key-written-as-absent`, `a-defaulted-key-cleared-with-absent`,
`a-required-key-written-as-absent`. Nothing in Class 1 regresses.

## Stage 2 — Families, templates, enums

Three packages. 2A and 2B both rewrite `definitionResolver.ts` and run in sequence; 2C runs after.

### WP2A — Record extension and the discriminated family (§5.2, §7.2; #10, #11)

- Resolver: a mark on a non-record is an error; `=?` implies ABSTRACT; `final` beside a selector is
  refused; nothing composes or refines onto a FINAL record, subtraction stays admissible.
- Linker, new `link/recordExtension.ts` (Java `RecordExtension.check`): each selector's type
  resolves to an atom-family instance or enum; unmarked, non-voidable, no group member (reachable
  by refinement included), no value; every subtype transitively pins every selector FIXED; pins
  pairwise distinct **as values** under the field type's equality (`= 255` and `= 0xFF` collide), as
  tuples where several; re-judged whenever any family member is local.
- Inhabitance: an ABSTRACT base with no local subtype is not a productivity error; a document
  reaching one gets a read-time error naming the missing import, not "one of ()".
- Reading: an ABSTRACT position with no discriminators requires the tag and refuses a tag naming
  the base; a member-dispatched position reads the selector — **which in text may arrive after the
  fields it selects**, so the reader looks ahead within one record — and an optional tag must agree.
  Tree and bind readers both.

Vectors: the eleven link and ten validate family vectors, `how-a-record-may-be-realised`, the four
definition-mark schema vectors, fixture `validate-family.tn`.

### WP2B — Templates and applications (§5.8, §5.10, §8.2, §8.3; #12, #13, #15, #16)

- `record.supertypes` is `[type_ref]`: a parameterised parent substitutes and closes with the held
  body, so `ok<text>` IS-A `result<text>`.
- A record-bodied template is a family base: `extension` ABSTRACT and derived, `discriminators`
  those surviving parameter erasure; nameable bare at a type position; a template itself is not
  credited as a subtype of its base (`link/subtypes.ts`), only its instantiations.
- A declaration whose body is a fully-bound application **is** the entry — no minted twin, no
  `!reference` hop; a use-site application resolves to the owning declaration; sugar still mints.
- A record instantiation composes and refines (the "finished" list drops it).
- Applying `!template` directly in a source declaration is a resolver error.

Vectors: `a-subtype-template-closes-to-an-is-a-edge`, `a-declared-application-is-the-entry`,
`an-instantiation-composes-like-a-record`, the two `applying-template-directly*`, the three
abstract-template and three alias validate vectors, fixture `validate-alias.tn`.

### WP2C — Enum profile, text members, class stability (§5.4, §5.7, §7.4; #17, #21, #22)

- Enum profile: IDENTIFIER members match §7.7's grammar (checked, since `enum_set` no longer types
  them) and see name hygiene; TEXT admits any text, is string-class, sees none; IDENTIFIER narrows
  TEXT, not the reverse.
- `text_type.members`, and **settable once** as a facet kind for `members` and `pattern`; every
  member satisfies the facets beside it, pattern included; enforced at read.
- `disjoint`'s no-class list gains an approximate atom still admitting NaN or infinity, and a map
  whose key type is not an atom-family instance or enum.

Vectors: `an-enum-declares-which-kind-of-enumeration-it-is`, `an-enum-member-that-is-not-a-name`,
`a-text-type-carries-a-member-set`, `a-member-outside-the-facets-beside-it`, the `schema/refused`
bucket.

**Gate:** 328/328.

## Stage 3 — Behaviour the change log does not state

The reference carries behaviour between the pins that no change-log item names. Two packages over
disjoint files.

### WP3A — Diagnostics and value identity

- **`!boolean`** in the schemaless vocabulary (Part 1 §5.5).
- **`ATOM_FORM_INVALID`**, a new code: a token the atom grammar rejects is a _resolver_ error; a
  parsed value out of range stays `ATOM_CONSTRAINT_VIOLATION`. The split rides on the existing
  `TsonAtomParseError` / `TsonAtomValidationError`. Add it to the conformance category sets.
- **`UNKNOWN_TYPE_REF` means the name denotes nothing.** A resolving name that is not admissible —
  subsumption, a choice variant, a union member — and a missing required tag are `TYPE_MISMATCH`.
- **Value identity**: scale is a spelling (`1`, `1.0` one `number` for set members, map keys, FIXED);
  `time` and `datetime` compare as instants.
- **Not judged** (Part 1 §8.1, Part 2 §10.1): an unobtainable schema is reported as _unavailable_,
  distinct from the four categories and from a refusal, located at the reference. A pin mismatch
  stays a resolver error.

### WP3B — Reads and registration

- **All-or-nothing reads**: in tree mode as in bind mode, a document that reported anything yields
  no value; a tree placeholder for a refused value goes, so an absent node always means a written
  `_`.
- **A schema registered in-process is pin-checked** like a fetched one.
- A name §8.2 refused draws no `UNRECOGNIZED_FIELD` beside its refusal.

**Gate:** 328/328, unit green.

## Stage 4 — Part 3, the JSON encoding

New in this revision, and new to this port. The reference implements it as a stack of its own —
lexer, event stream, tree, schema-directed readers — with no dependency on its text compiler, and
records that separation as a deferral rather than a conclusion. Port it the same way, as
`src/json/` behind a `./json` subpath, and register the parallel stack in `IDIOM-DEBT.md`.

**Constraints carry over unchanged**: the JSON lexer decodes UTF-8 itself and is code-point
addressed, reading is `Task<T>` under `runSync`/`runAsync`, memory is proportional to depth — which
Part 3 makes possible by requiring reserved members and selectors to **lead** an object, so every
selector test reads a bounded prefix fixed by the schema. No `JSON.parse` (§10.2).

An ESLint zone for `src/json/**` forbids `lexer`, `stream`, `reader`, `compiler`, `tree`, `write`
and `facade` — the TypeScript form of the reference's "no dependency on tson-compiler". It may use
`core`, `io`, `unicode`, `atom`, `base`, `value`, `schema`, `link`, `annotations`, `bind`. The
reference-chain walk it needs lives in `compiler/referenceChain.ts`; move it to `link/` rather than
widening the zone.

- **WP4A — lexer, stream, tree, schemaless read, tree writer.** RFC 8259 under §3.1's profile: one
  leading BOM discarded, lone surrogates an error, duplicate names after NFC, numbers kept as
  lexemes. Tests split input at every byte offset and assert `runAsync` equals `runSync`.
- **WP4B — schema-directed tree read, without dispatch.** Compile once from a `LinkedSchema`;
  atoms by §5 (string content to the atom's parser; enums match on content, not JSON kind);
  records closed, NFC names, the three field slots, injection, FIXED by value, groups, hygiene
  before closure; arrays, sets, tuples; object-form and pairs-form maps by key type (§6.4);
  all-or-nothing.
- **WP4C — the annotation object and dispatch.** `$schema`/`$type`/`$value`, closed set, lead rule,
  wrapper versus inline; tag dispatch at OPEN and ABSTRACT positions; member dispatch at a sealed
  one; the choice kind table (§8) with `disjoint` the only rule; the map escape; template family
  bases. The reference's `CrossEncodingParityTest` is the Class 3 equivalence check — port it
  against this port's own text `validate`.
- **WP4D — front door and CLI.** `parseJson`, `readJsonTree` / `validateJson({ schema, root })`, sync
  and async; `.json` classified by extension in `tson validate`, bound by `--schema`/`--root`;
  stdin as JSON when bound; the reference's usage errors.

The corpus has no JSON vectors and no way yet to state a two-encoding fact; the reference's tests
are inline text blocks and port as table-driven cases.

**Gate:** the full unit suite including the JSON tests; 328/328 unchanged; the browser bundle
builds with the new subpath.

## Stage 5 — Sweep

`/2026/35/` → `/2026/36/` across 17 test files, `README.md`, `config.ts`, `skills/tson-ts/`,
`examples/web-demo/` (whose scenarios still spell `a: T?`); version both packages 0.36.0; refresh
`STATUS.md` (328 subjects, the JSON encoding, the known gaps below), `CLAUDE.md` (the `enum_set`
quotation, the JSON subpath and zone), `IDIOM-DEBT.md`, `ORCHESTRATION.md` and
`.claude/agents/tson-porter.md`.

**Gate:** the full CI list in `CLAUDE.md`, in order, green.

## Scope decisions

**Part 3 is in scope.** Revision 35 left the JSON reader out because neither implementation had
one. The reference now does, and `CLAUDE.md`'s parity argument runs the other way: a surface the
reference offers and this port lacks is the divergence. Scope matches the reference's, not the
spec's: the reference does not implement §3.4's in-band root binding, §8.5 scoped positions (a
`NOT_IMPLEMENTED` reader), the §3.5 `TSON-Schema` / `TSON-Accept-Schema` header fields, a
schema-directed encoder, or limits beyond depth. Those are recorded gaps here too.

**Member dispatch looks ahead within one record.** `a-discriminator-may-arrive-after-the-fields-it-selects`
is a valid vector: in text, a selector may follow the fields it selects, so a reader at a
member-dispatched position must see the whole record before it knows its type. Memory there is
proportional to one record's size, not to depth. Part 3 avoids this by making selectors lead; the
text notation does not. This is spec feedback, not a port choice — see below.

**Token policy on every read path.** The reference checks the token and identifier policies on every
value, field name, type-ref and annotation name in the stream, on all read paths; this port checks
them on the schemaless tree path only. That predates both pins and is not a Revision 36 change —
record it as a gap rather than widening this run.

## Stage 4, as executed

Stage 4 ran as four workflows rather than two. Porting only part of the reference's JSON tests let
real divergences survive two reviews, so 4c and 4d ported the rest of `tson-json/src/test/` case for
case (Java-host binding excepted). That found and fixed bugs in both stacks, and closed the review
findings.

## To report upstream

- **Member dispatch against streaming.** §5.2 lets a text-encoded selector arrive after the fields
  it selects, so a streaming reader buffers one record at every member-dispatched position. Part 3
  §6.1.5 requires the selector to lead for exactly this reason. The two encodings disagree about
  whether reading a family is bounded; worth asking whether text should take the same rule.
- The corpus's `REVISION` file still reads `33`.
- The `!set_type` / `!array` §8.1 gap `CLAUDE.md` records survives this revision; `enum_set` is now
  `!set_type { element_type: text }` and writes, as before, as `!array`.
- **Parametric modifiers (§5.7, §8.1, kernel `record_field` @doc).** §5.7 and §1.6 write `~ P` on an
  unmarked name, and the reference refuses it; this port follows the spec. The kernel doc says a
  held parametric field is "a required FREE field with the parameter in `value`", which contradicts
  §8.1's "`value` present exactly when `role` is not FREE"; this port holds the eventual role.
- **Pin distinctness "transitively" (§5.2).** A grandchild inherits its parent's pin, which §5.7
  forbids it to change, so distinctness over the transitive `subtypes` would flag every grandchild.
  Read over direct members, since "a family discriminates one level".
- **A sealed or ABSTRACT record as a choice variant (§5.4, §7.2).** §7.2 gives choices variant
  membership rather than subsumption, so a tag naming a family member is not a variant, and the
  variant itself has no direct instances. Read literally, such a variant admits no value. This port
  reads the variant through its own family.
- **No resolver-category code for a reserved-member violation ([TSON-JSON] §3.2, §3.3, §9.4).** An
  unknown `$foo`, a misplaced `$type` and extras in a wrapper are resolver errors, but the diagnostic
  vocabulary has no code that means that. This port uses `UNKNOWN_TYPE_REF`.
- **Where the reference diverges from Part 3**, each followed here as Part 3 reads:
  - duplicate member names are compared after NFC (§3.1);
  - a JSON number at an enum position matches by its lexeme (§5.2);
  - a wrapper `$type` naming a sealed base takes the same refusal as the inline form;
  - `$schema` without `$type` at an OPEN-with-subtypes position is refused by the concrete reader.
- **`UNKNOWN_TYPE_REF` versus `TYPE_MISMATCH` (§7.2).** The reference's schema-directed dispatchers
  report `TYPE_MISMATCH` even for a tag naming nothing. This port keeps `UNKNOWN_TYPE_REF` for a name
  that denotes nothing, as its own commit message for that change states.
