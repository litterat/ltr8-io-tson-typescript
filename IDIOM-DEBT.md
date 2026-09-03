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

- **19 classes in the whole library, and every one is an `Error` subclass**
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

## Summary

| #   | Item                                          | Trigger                       | Size                     |
| --- | --------------------------------------------- | ----------------------------- | ------------------------ |
| 1   | `record()` shape inference                    | Additive; can land early      | Medium, one file + tests |
| 2   | Single-method interfaces → function types     | Reference's `reader/` settles | Medium, mechanical       |
| 3   | `ReadContext` accessors + symbol-keyed cursor | `TsonReadContext` settles     | Large, internal only     |
| 4   | `setPrototypeOf` dead code                    | None                          | One line                 |
| 5   | `defined()` helper for optional spreads       | None                          | Small, many files        |
| 6   | `DiagnosticCode` casing                       | None — document, don't rename | One comment              |
| 7   | Java-facing TSDoc                             | Reference's structure settles | Large, 65 files          |
| 8   | `export *` barrel                             | Before first npm publish      | Small, one file          |

Items 4, 6 and 8 are independent of the reference. Items 1, 2, 3 and 7 are the hold — and 7 is
where most of the "this library is its own thing now" actually lives.
