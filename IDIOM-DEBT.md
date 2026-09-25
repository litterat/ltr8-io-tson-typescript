# Idiom debt

← back to the [README](README.md)

Where this port is shaped by the Java reference rather than by TypeScript, why each one is
deliberately being **held** while the reference is still moving, and what to change when it
settles.

This is not a defect list. Nothing here is a bug, none of it affects conformance, and none of it
is blocking. It is the register of places where mirroring the reference costs idiom, kept so the
cost is a decision rather than an accident — and so the work is already written down on the day
the reference freezes.

**The holding rule.** While `ltr8-io-tson-java` moves, structural parity with it is worth more
than TypeScript idiom: a port that is shaped like its reference can take an upstream change by
reading a diff, and a port that has been re-idiomised has to re-derive every change from the
spec instead. Every item below is therefore listed with a **trigger** — the condition that ends
the hold. Until that condition is met, the item stays as it is _on purpose_, and a reviewer who
finds it should read this file rather than "fix" it.

`STATUS.md` remains the only checklist; nothing here is a task with a checkbox.

## What is already idiomatic

Worth stating first, because it bounds the rest. The port is not a transliteration:

- **21 classes in the whole library, and every one is an `Error` subclass**
  (`core/errors.ts`, `regex/errors.ts`). No service objects, no abstract factories, no
  interface-with-one-implementation. Everything else is functions over plain data.
- **Discriminated unions, not visitors.** `ast/value.ts`, `stream/event.ts`, `tree/nodes.ts` and
  `bind/binding.ts` are all `kind`-tagged unions; there is no `accept()`/`visit()` anywhere in the
  package.
- **No escape hatches.** Zero `any`, zero non-null assertions, zero `@ts-ignore`/`@ts-expect-error`,
  four `eslint-disable` comments in ~24k lines of code — under `strictTypeChecked`,
  `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
- **`bind/binding.ts` is modern TypeScript on its own terms.** A phantom `unique symbol` output
  type, `Infer<B>`, and `const` type parameters on `tuple`/`variant`. That file owes the Java
  nothing but its vocabulary.
- **`Task<T>` is unusual but not foreign.** A `Generator<typeof NEED_INPUT, T, void>` driven by
  `runSync`/`runAsync` (`io/bytes.ts`) is a recognised TypeScript pattern, not a Java one — it is
  how effect-ts and redux-saga spell the same thing.

## 1. `record()` does not infer its host type from a shape

**The only item here a _consumer_ of the library feels.** Authoring a record binding today:

```ts
record<Point>({
  fields: [field<Point, 'x'>(0, 'x', 'x', INT), optional<Point, 'y'>(1, 'y', 'y', INT)],
  construct: ([x, y]) =>
    y === undefined ? { x: x as number } : { x: x as number, y: y as number },
});
```

The field name is written three times, the construction `index` is maintained by hand,
`construct` receives `readonly unknown[]` and casts back out, and both type parameters must be
spelled at every call site because TypeScript has no partial type-argument inference — `field<Point>`
does not compile.

The `index` exists because Java's `DataClassRecord` feeds a `MethodHandle` constructor
positionally. Nothing in TypeScript needs it.

The machinery to remove it is already in the same file. `Shape` and `InferShape`
(`bind/binding.ts:480`, `:483`) let `variant()` (`bind/combinators.ts:120`) infer a whole host
union from a shape literal; `record()` (`bind/combinators.ts:39`) does not use them. The
idiomatic form a TypeScript author expects is:

```ts
const point = record({ x: INT, y: optional(INT) }); // RecordBinding<{ x: number; y?: number }>
```

**Shape of the change.** Add a shape-taking overload of `record()` over `Shape`/`InferShape`,
deriving `index` from key order and synthesising `construct` from the shape. Keep the existing
positional form underneath, unchanged, for a host that is not a plain object — a class instance, a
value with a private constructor, a record whose wire names differ from its property names.
`field`/`optional` stay as the escape hatch, not the default.

**Trigger.** `DataClassRecord`'s slot model stops changing upstream. This is additive — a new
overload, no removal — so it is the one item that could land before the reference settles if the
binding API's ergonomics start costing real users.

## 2. Ten single-method interfaces are Java functional interfaces

`TypeReader.read` (`reader/contracts.ts:41`), `DiagnosticsReceiver.report`
(`core/diagnostic.ts:218`), `SchemaSource.fetch` (`config.ts:87`),
`ValueReaderFactory.create` (`reader/contracts.ts:192`),
`ValueReaderFactoryRegistry.resolve` (`:205`), `ScalarParser.read` (`atom/forType.ts:62`),
`ReadableByteStreamLike.getReader` (`io/streams.ts:42`),
`ParameterKindsFailureReporter.report` (`compiler/parameterKinds.ts:286`),
`MaterialisationFailureReporter.reportFailedApplication` (`compiler/templates.ts:152`),
`MintedNames.claim` (`compiler/mintedNames.ts:28`).

In TypeScript each of these is a function type:

```ts
type DiagnosticsReceiver = (diagnostic: Diagnostic) => void;
```

As interfaces, every caller constructs `{ report(d) { … } }` where a lambda would do, and none of
them compose with partial application.

**Two of the ten should not change even later.** `DiagnosticsReceiver` is extended by
`DiagnosticsCollector`, which adds a `diagnostics` array — as a function type that becomes a
callable-with-a-property, which is worse than what it replaces. `ReadableByteStreamLike` is a
structural stand-in for a real `ReadableStream` and has to keep that shape. The other eight are
function types wearing an interface.

**Trigger.** The reference's `reader/` package interfaces stop moving. Converting them is a
mechanical, source-compatible-at-the-call-site change for `TypeReader`/`ScalarParser` (a
call-site writes `reader.read(ctx)` today and `reader(ctx)` after), which makes it a poor thing to
do while upstream diffs still have to be read against it.

## 3. `ReadContext` uses zero-arg methods where TypeScript uses properties

`reader/contracts.ts:79-132`: `position()`, `schemaLocation()`, `path()`, `reported()`. These are
pure accessors — Java's `getPath()` with the `get` filed off. TypeScript spells them
`readonly path: string`, or a getter.

Alongside them sit six scoping methods on one interface — `field`, `index`, `schemaField`,
`inRecord`, `underDeclaration`, `withPosition` — which reads as a Java fluent builder. A
TypeScript design of the same contract is more likely one `scope(step)` over an immutable context
record, with the six current methods as thin helpers.

**The consequence worth noting** is in `reader/context.ts`. Because `ReadContext` is an interface
with no class behind it, per-read private state has to be smuggled through
`Symbol.for('io.ltr8.tson.readContext.cursor')` plus a cast (`:118`, `:343`, `:377`). The reason
given there — a bundler that gives two subpath entries their own copy of the module gives each its
own module-level state — is correct, and rules out a module-local symbol and a `WeakMap` alike.
But it does not rule out the answer TypeScript actually has for private per-instance state: a
class with a `#cursor` field. The package's near-total absence of classes — the right
default, and the first thing listed under "What is already idiomatic" — is what forces the symbol
dance here, and this is the one place where that default costs more than it saves.

**Trigger.** `TsonReadContext` stops moving upstream. This is the largest of the changes — every
reader in `reader/` and `compiler/` calls these — and the least urgent, since it is entirely
internal to the read stack and invisible to a consumer.

## 4. `Object.setPrototypeOf` in the error base is dead code

`core/errors.ts:18`:

```ts
// Restores the prototype chain when compiled down-level, so `instanceof` holds.
Object.setPrototypeOf(this, new.target.prototype);
```

`tsconfig.base.json` sets `"target": "ES2023"` and `packages/tson/package.json` declares
`"engines": { "node": ">=24" }`. Nothing in this repository is compiled down-level, so the line
restores a chain that was never broken. It is inherited habit from `target: ES5` codebases, not
from the Java.

**Trigger.** None — this one is independent of the reference and can go whenever. It is listed
here rather than fixed only because deleting it is worth doing alongside a real edit to
`core/errors.ts` rather than as a commit of its own.

## 5. 82 conditional spreads for optional properties

`...(x === undefined ? {} : { k: x })` appears 82 times, 48 of them in exactly that shape;
`facade/tree.ts:79-90` has four consecutively. It is the honest cost of
`exactOptionalPropertyTypes` — which is the right setting, and stays — but it is a cost paid
inline 82 times instead of once.

The idiomatic form is a single helper that drops `undefined`-valued keys:

```ts
schemalessTreeReader(
  defined({
    preserveUnknownTypeRefs: options?.preserveUnknownTypeRefs,
    maxNestingDepth: options?.maxNestingDepth,
    identifierPolicy: options?.identifierPolicy,
    tokenPolicy: options?.tokenPolicy,
  }),
);
```

typed so the result's optional keys stay optional rather than becoming `T | undefined`.

**Trigger.** None — also independent of the reference. Held only because it touches many files at
once, which is a bad shape for a diff to be read against upstream while upstream is moving.

## 6. `DiagnosticCode` is `SCREAMING_SNAKE_CASE` next to kebab-case discriminants

`core/diagnostic.ts:11` declares `'FIELD_REQUIRED' | 'TYPE_MISMATCH' | …`, while every `kind`
discriminant in the same package is kebab-case (`'document-start'`, `'empty-brace'`, `'record'`).
Read cold, it looks like a Java `enum` that kept its casing.

**This one does not change, ever.** The codes are a cross-implementation contract — they appear
verbatim in the reference's `STRUCTURED-OUTPUT.md` and in the CLI's own JSON output, so a
consumer parsing either implementation's diagnostics sees the same strings. What is missing is
not a rename but a sentence in `core/diagnostic.ts` saying so; without it the casing reads as an
oversight rather than as the wire contract it is.

**Trigger.** None. Add the note; keep the casing.

## 7. TSDoc explains the code by differencing it against Java

The largest item by volume, and the one a new TypeScript reader hits first.

376 references to the Java across 65 source files. `reader/context.ts:52` — "the port of the
Java's own `PathStep`". `tree/nodes.ts` — "Mirrors `TsonRecord`", and a paragraph on what the
Java's Javadoc calls "anti-Jackson" naming. `bind/binding.ts` — "deletes `DefaultRecordBinder`'s
1158 LOC of `MethodHandle`-producing reflection".

Comments are ~35% of non-blank lines, with several TSDoc blocks running past 50 lines. Density
alone is defensible for a spec implementation — the `§` citations earn their place. What does not
is that a substantial share of it explains this code by naming `DataClassRecord`,
`ConstructionGuard`, `Memoized` and `AnnotationCapture`: types a TypeScript reader has never
seen, in a repository where `.references/` is gitignored and absent from a bare clone.

It is also the one item that already contradicts a rule this repository states for itself.
`CLAUDE.md`, Conventions: _"TSDoc documents current contract only, no change history. Never
dates, 'renamed from X', 'ported from Y', 'used to do Z'."_

**The fix is not deletion.** Nearly every one of these comments is carrying a real invariant; it
is just stating it as a difference. Restate it as the invariant:

```diff
- The port of the Java's own `PathStep`.
+ A linked step, not a string concatenated at every descent: the path is
+ built once, at report time, and a read that reports nothing pays nothing.
```

Same information, no Java required to decode it.

**Trigger.** The reference's own structure settles. While it moves, a comment naming the Java
type a function mirrors is how the next upstream diff gets applied correctly, and that is worth
more than a clean read for a newcomer. When it freezes, this becomes a mechanical pass over 65
files — and the `§` spec citations, which are the half that stays, are already separable from the
`Java`/`Javadoc`/`io.ltr8` mentions, which are the half that goes.

## 8. `src/index.ts` re-exports 19 modules with `export *`

The public surface of `@ltr8/tson` is currently whatever its leaf modules happen to export. The
`MapEntry` collision between `ast/value.ts` and `tree/nodes.ts` — resolved by hand-aliasing the
tree's own to `TreeMapEntry` — is what that costs: the clash was discovered rather than
prevented, and the next one will be too.

**Shape of the change.** Named re-export lists, so adding an export to a leaf module is a
deliberate act at the barrel rather than an automatic one. The subpath entries (`/tree`, `/bind`,
`/schema`, `/write`, `/regex`) already scope the surface usefully; this is about the default entry
only.

**Trigger.** Before the first npm publish, since after it every accidental export is a
compatibility obligation. This is the one item with a deadline that is not the reference's.

## 9. `src/json/` is a parallel stack, deliberately duplicating the read-plan shape

`json/lexer.ts`, `json/stream.ts` and `json/readContext.ts` are close structural mirrors of
`lexer/lexer.ts`, `stream/dataStream.ts` and `reader/context.ts` — a code-point-addressed
`Task`-suspending scanner, a frame-stack event source, a linked-`PathStep` read context reporting
through a `DiagnosticsReceiver` — spelled a second time for RFC 8259's grammar instead of shared.
This is the port's own version of the reference's own held decision
(`.references/ltr8-io-tson-java/design/json-encoding.md`, "A stack of its own, and the seam is
deferred rather than chosen"): `tson-json` builds no dependency on `tson-compiler`, for two
reasons that hold here identically —

- **A brace does not say what it is.** [TSON-DATA] text tells a record from a map syntactically;
  JSON's `{"a": 1}` is one syntax for both, and [TSON-JSON] §4.1 makes the _position_ decide,
  never inspection of the value. A pull-only event source has no channel for the position to say
  so, and giving it one would put the JSON encoding's problem inside the TSON reader stack.
- **`null` is two things.** In a plain `JsonValue` tree it is a real value (`json/tree.ts`'s
  `JsonNull`); under a schema it is the absent sentinel and nothing else (§7). Settling that in a
  shared event vocabulary would answer a schema's question one layer too early.

Both arguments are about the _event_ layer specifically, and — per the reference's own note — do
not reach a schema-directed reader built above a linked schema, where the position _is_ the
reader. **WP4B is that later work package, and it has now landed** (`json/schema/**`): a
compiled-per-entry reader table (`json/schema/compile.ts`'s `compileJsonSchema`) and one reader
per constructor (`json/schema/atoms.ts`, `record.ts`, `array.ts`, `tuple.ts`, `map.ts`) mirroring
`compiler/compile.ts`, `atom/forType.ts` and `reader/tree/*` respectively — the predicted second
copy, confirmed rather than avoided, for the identical two reasons this item already gave (the
JSON reader stack still owns no dependency on `compiler/`, `reader/`, `tree/` or `write/`, per the
unchanged `src/json/**` ESLint zone). `json/readContext.ts` grew the exact capability this item
predicted it would: `inRecord`/`underDeclaration`/`schemaField`/`schemaLocation`, ported line for
line from `reader/context.ts`'s own identically-named methods (`SchemaAnchor`, `PathStep.schemaToo`
included), because a schema-directed JSON reader needs the same "accumulate a `SchemaLocation`
alongside the data path" capability the TSON reader already has, and `src/json/**` cannot import
that implementation. Two further, smaller duplications the same trigger will absorb: `json/schema/
eventSkip.ts` mirrors the shape of the skip-on-refusal helper every `reader/tree/*` file writes
inline (`EventSkip` in the Java module made it a named type there; this port's text side never
did, so there is no single TSON-side sibling to point at, only the pattern), and `json/schema/
nameHygiene.ts` calls the _shared_ `unicode/policy.ts#nameHygieneRefusal` with a one-name scope
rather than duplicating its logic — the one place in this item's list where reuse, not
duplication, was possible, because that function already lived below both `reader/` and `json/`
in the import graph.

**What is _not_ duplicated, on purpose.** The `src/json/**` ESLint zone (`eslint.config.js`)
forbids importing `lexer/`, `stream/`, `reader/`, `compiler/`, `tree/`, `write/` or `facade/` at
all — so a schemaless JSON read returns `json/tree.ts`'s own `JsonValue`, never `tree/nodes.ts`'s
`Value`, settling this work package's own open question about what a schemaless read should hand
back (`json/index.ts`'s own top note has the full reasoning). `core/`, `io/` and `unicode/` are
shared without a second copy: `json/lexer.ts` decodes UTF-8 through `io/utf8.ts`'s
`decodeCodePoint`, `json/stream.ts`'s nesting bound is `core/limits.ts`'s own
`LimitsPolicy`/`nestingLimitRefusal` (so raising the bound raises it for both encodings at once,
matching [TSON-JSON] §10.1's own requirement), and every JSON-side failure this work package
raises is `core/errors.ts`'s existing `TsonLexError`/`TsonParseError`/`TsonLimitRefusedError`
rather than a second error hierarchy — a simplification beyond what the Java carries (its own
`ParseException` is one class covering both eventual [TSON-JSON] §9.4 categories; this port's two
existing TSON-text error classes already carry that split, so JSON reuses them instead of
inventing a `JsonParseException`). WP4B added one more shared piece rather than a duplicate: the value-identity comparison
`record.ts`'s FIXED check and `array.ts`/`map.ts`'s duplicate checks all need (§5.5 — two
spellings of one value, `1`/`1.0`, comparing equal) used to live only in `reader/tree/equality.ts`,
unreachable from `src/json/**`. It moved to `value/equality.ts` — a directory the zone already
permits — with `reader/tree/equality.ts` reduced to a thin `Value`-typed wrapper (`valuesEqual`)
re-exporting the rest, so both encodings compare by the _same_ function
(`design/json-schema-directed-reading.md`'s own `ValueIdentity` note: "the peer of
`tson-compiler`'s `ValueIdentity`, and one whose two copies must agree") rather than agreeing by
coincidence.

**WP4C finished that consolidation rather than adding a second copy beside it.** `json/schema/
valueIdentity.ts` used to carry its own reduction of a decoded host value to one comparable string
key (`identityOfHost`) — TypeScript's `Map`/`Set` have no `Object.equals`/`hashCode` pair to key
duplicate-detection on the way the Java reference's own `ValueIdentity` does, so a _keying_
function was still needed and `value/equality.ts`'s own `deepEqual` does not provide one (it
compares two values pairwise, never reduces one to a string). Rather than let that keying function
go on living only in `json/schema/valueIdentity.ts`, it moved to `value/equality.ts` itself as
`identityKey` — the natural home the item above already established for this exact fact ("the
peer of `tson-compiler`'s `ValueIdentity`") — and every one of its dedicated per-tier reductions
moved with it (`gcdBigInt`-reduced lowest terms for `rational`, `decimalIdentityKey` over each
component for `complex`, the generic `JSON.stringify` fallback for the network families that are
already canonical in their own parsed fields). `json/schema/valueIdentity.ts`'s own
`identityOfHost` is now a two-line re-export of `identityKey`, and the module keeps only what
genuinely has no counterpart outside `src/json/**`: `identityOfNode`, the same reduction applied to
a `JsonValue` tree rather than a decoded host value (§6.4's pairs-form compound key), which cannot
move to `value/equality.ts` because a `JsonValue` is this encoding's own tree shape and `value/`
has no dependency on either encoding's tree model. Pin comparison, set duplicates and map-key
identity in both `json/schema/**` and (via `deepEqual`, extended in the repair pass below to share
every one of `identityKey`'s own normalisations — scale is a spelling, `time`/`datetime` compare
as instants, text folds to NFC, a `rational` reduces to lowest terms, every NaN is one value) the
text encoding now go through one definition of what a value space's equality is, not two that
happened to agree.

**The repair pass's own reading, stated plainly.** [TSON-DATA] §7.2.1 says a decoded string value
keeps its exact spelling ("two string values ... remain distinct strings"), which is true of what
`deepEqual`/`identityKey` hand back but was, until this pass, also taken as the rule for what two
spellings compare _as_ — `deepEqual` compared strings by `===` and left `rational` uncompared by
value at all, so a set of `text` or `rational`, or a FIXED check on either, could accept in one
encoding what the other refused on the identical document (probed directly: `set<text>` holding a
precomposed and a decomposed spelling of one grapheme, and `set<rational>` holding `1/2` and
`2/4`). The reference implementation's own `ValueIdentity` (`tson-compiler` and `tson-json` alike)
resolves this by NFC-folding every string and reducing every rational for comparison regardless of
family, with `meta.tn`'s own `rational_type` doc stating the reduction outright ("2/4 equals
1/2"). This port now follows the reference on both counts and adds the matching IEEE 754-2019 NaN
rule (every NaN one value), because the alternative — narrowing §7.2.1's own reading instead —
would leave `deepEqual` and `identityKey` disagreeing with each other, which is the one outcome
this item's whole consolidation exists to rule out. Reported upstream as worth a sentence in
[TSON-DATA] §7.2.1 distinguishing "what a decoder returns" from "what two returned values compare
equal as", since the two questions currently share one paragraph.

**WP4C also landed the dispatch layer this item's own trigger asked to be measured against**:
`json/schema/dispatchTag.ts`, `dispatchMember.ts` and `dispatchChoice.ts` are the JSON encoding's
own `DispatchTagReader`/`DispatchMemberReader`/`DispatchChoiceReader`, each restating a rule
`compiler/subsumption.ts` (record-family tag/member dispatch) or `compiler/choiceReader.ts`
(choice discrimination) already carries for TSON text — a fourth and fifth deliberate duplication
this item's own list did not yet name, for the identical reason every other one on it holds: the
`src/json/**` zone forbids importing `compiler/` at all. Unlike the earlier entries, this pair
reuses real machinery rather than restating it from scratch wherever the model already exposes the
fact as data: `link/recordExtension.ts`'s `directMembers` (not a second walk of a family's direct
members), `link/disjointness.ts`'s `discriminationClassOf`/`choiceDisjoint` (not a second
class-stability derivation — Revision 36 already folded that question into the one class function
both stacks share, unlike the Java reference's own JSON-side `DiscriminationClass.stable`, which
duplicates a predicate the model itself now answers once), and `json/schema/record.ts`'s own
`fieldValueOf`/`resolveFieldBody`/`fieldValueParser` (a discriminator's pin, decoded once, the same
way a FIXED field's pin already was). §7.2's alias-flattened admissible-name set (`selfNames`/
`admitting`) is not a sixth duplication: the repair pass moved it out of `compiler/subsumption.ts`'s
own module-private copy and into `link/referenceChain.ts`, beside `terminal` (the walk it is built
on), so both `compiler/subsumption.ts` and every dispatcher here import the one function rather
than each holding a copy — the reuse this item's own trigger describes, reached a step early
because `link/` was already the walk's home and nothing stopped the text side from importing it
too.

**`json/readContext.ts` grew the second capability this item predicted it would.** WP4B gave it
`inRecord`/`underDeclaration`/`schemaField`/`schemaLocation`; WP4C's dispatchers need to _peek_ an
object's leading members and then hand the whole, untouched object to whichever reader they select
— `reader/context.ts`'s own `lookingAhead`/rewind mechanism, ported line for line as
`json/readContext.ts`'s own `lookingAhead` (a `rewound` queue and a `recording` buffer on the
shared `Cursor`, exactly mirroring the text encoding's `PathStep`-adjacent fields), because
`src/json/**` cannot import the implementation it duplicates. The two `ReadContext`-shaped types
are now closer in shape than the trigger below already argued they were.

**One more narrowing this pair shares, deliberately.** `json/schema/dispatchChoice.ts`'s `$type`
at a choice position matches a written variant name exactly — no §7.2 alias flattening, no subtype
admission for a record variant. A literal reading of §8.1 admits both ("a record whose `$type`
names a proper subtype of a variant validates as that subtype"), but `compiler/choiceReader.ts`
does the identical exact-name match for the text encoding (confirmed by reading it), so this is
the dispatch pair's own cross-encoding parity holding, not a JSON-only shortcut: widening only the
JSON side would create a new divergence in the act of fixing an old one. Left narrower than the
literal spec text on both sides, recorded here rather than only in a code comment because it is a
design decision for the pair, not an implementation detail of either half.

**Trigger.** The reference's own: a shared `tson-encoding` module extracting "everything above
the event level" once a second working stack exists to find the seam from
(`.references/ltr8-io-tson-java/BACKLOG.md`, "Module structure" — "The encoding-neutral reader
parts move into a module both stacks share… With two working stacks the seam is visible… today it
exists twice, guarded by `CrossEncodingParityTest` rather than by being one thing"). Concretely
for this port, now that WP4C's dispatchers exist beside this package's own `compiler/`-backed
`subsumption.ts`/`choiceReader.ts`: the two `ReadContext`-shaped types (`reader/context.ts`'s
`ReadContext` and this item's `json/readContext.ts`) are the first candidate to unify, since both
now carry the identical `lookingAhead`/rewind capability on top of the identical
`SchemaAnchor`/`PathStep` shape and differ only in how they pull an event; `json/schema/record.ts`
and `reader/tree/record.ts` are the second, and `json/schema/dispatchTag.ts`/`dispatchMember.ts`
and `compiler/subsumption.ts` are a third pair now provably close enough to name — both walk "the
leading members/fields, decide, delegate", both derive the same `own`/alias set, and both report
the identical `VALIDATION_ERROR`/`TYPE_MISMATCH`/`UNKNOWN_TYPE_REF` split
(`json-dispatch.test.ts`'s own cross-encoding parity block is what checks that split has not
drifted, standing in for the Java reference's `CrossEncodingParityTest` this port did not have
until WP4C). `CrossEncodingParityTest`'s own guard is now real rather than a promise for a future
work package: it is this port's ongoing defence against the two stacks drifting apart silently,
not the trigger for unifying them — that trigger is still the shared module above, now with three
named candidate pairs waiting for it rather than one.

## Summary

| #   | Item                                          | Trigger                               | Size                      |
| --- | --------------------------------------------- | ------------------------------------- | ------------------------- |
| 1   | `record()` shape inference                    | Additive; can land early              | Medium, one file + tests  |
| 2   | Single-method interfaces → function types     | Reference's `reader/` settles         | Medium, mechanical        |
| 3   | `ReadContext` accessors + symbol-keyed cursor | `TsonReadContext` settles             | Large, internal only      |
| 4   | `setPrototypeOf` dead code                    | None                                  | One line                  |
| 5   | `defined()` helper for optional spreads       | None                                  | Small, many files         |
| 6   | `DiagnosticCode` casing                       | None — document, don't rename         | One comment               |
| 7   | Java-facing TSDoc                             | Reference's structure settles         | Large, 65 files           |
| 8   | `export *` barrel                             | Before first npm publish              | Small, one file           |
| 9   | `json/` mirrors the TSON-text read-plan shape | A shared `tson-encoding`-style module | Large, whole `json/` tree |

Items 4, 6 and 8 are independent of the reference. Items 1, 2, 3, 7 and 9 are the hold — and 7 is
where most of the "this library is its own thing now" actually lives.
