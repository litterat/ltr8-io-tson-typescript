---
name: tson-ts
description: Read, validate, write and bind TSON (`.tn`) documents with `@ltr8/tson`, and run its `tson` command line. Use this skill whenever code imports `@ltr8/tson` or `@ltr8/tson-cli`; whenever names like `readTree`, `validate`, `createTson`, `standardLibrary`, `CompiledSchema`, `SchemaSource`, `LinkedSchema`, `Diagnostic` or `TsonReadError` appear; whenever work happens inside the `ltr8-io-tson-typescript` repository; and whenever someone wants to check, compile or hash `.tn` files from a shell, a script, a Makefile or a CI job — `npx @ltr8/tson-cli validate`, a pre-commit hook, a lint step — whatever language the surrounding project is written in. For authoring TSON *data* documents use the tson-data skill; for *schema* documents use tson-schema. This skill is the TypeScript implementation and its CLI, not the notation.
---

# `@ltr8/tson` — the TypeScript implementation

A TypeScript port of TSON (Typed Schema Object Notation) for **Node 24+ and modern browsers**, with
**zero runtime dependencies**. It implements both spec parts — Class 1 (the text data format) and
Class 2 (the schema layer) — and passes the shared conformance suite in full.

Two packages, released in lockstep:

| Package          | What it is                                                                   |
| ---------------- | ---------------------------------------------------------------------------- |
| `@ltr8/tson`     | the library; subpath entry points, ESM + CJS + `.d.ts`                       |
| `@ltr8/tson-cli` | the `tson` command (`validate`, `compile`, `policy`, `hash`, `init-example`) |

Source, issues and releases: **https://github.com/litterat/ltr8-io-tson-typescript** (Apache-2.0).
The reference implementation this is ported from is
[ltr8-io-tson-java](https://github.com/litterat/ltr8-io-tson-java), and the shared conformance
vectors both are tested against are
[ltr8-io-tson-test-suite](https://github.com/litterat/ltr8-io-tson-test-suite).

**Versioning is `0.<spec revision>.<patch>`.** `0.34.x` implements the **2026 Revision 34** spec
series. A new revision moves the minor, and the spec is a working draft with no compatibility
guarantee between revisions — so a schema `!!id` pinned at `https://tson.io/2026/34/m/core.tn` is
revision-specific and must match the library's own revision. The CLI depends on the library at an
exact pin, never a range.

> Not yet published to npm at the time of writing — check
> [npmjs.com/package/@ltr8/tson](https://www.npmjs.com/package/@ltr8/tson) before writing an
> `npm install` line. Inside this repository the packages resolve as npm workspaces. From outside,
> until they are released, install from source: clone
> `https://github.com/litterat/ltr8-io-tson-typescript`, `npm ci`, `npm run build`, then depend on
> the workspace directory (`npm i ./path/to/packages/tson`) or `npm link` it. The packaging is
> release-ready — `publint` and `arethetypeswrong` run in CI on every commit.

## Workflow

1. **Decide what you actually need.** Reading one document with no schema is one import and one
   call. Reach for a schema registry only when there is more than one schema, or an `!!import`
   chain to resolve.
2. **Pick the entry point** from the table below — the package is _flat and tree-shakable first_,
   and choosing the narrow subpath is how a browser bundle stays small.
3. **Feed raw bytes**, not a decoded string. Every read takes `Uint8Array` (sync) or an
   `AsyncIterable<Uint8Array>` (async, returning a `Promise`). A `TextDecoder` round trip destroys
   the malformed-UTF-8 cases the format is specified to reject.
4. **Choose fail-fast or collecting.** `readTree` throws at the first problem; `validate` returns
   `{ value, diagnostics }` and never throws for a bad document. Use `validate` for anything that
   reports to a person.
5. **Check the diagnostics table** before inventing your own error strings — `code` is a closed
   union and is the thing to switch on.

## Pick the entry point

| Import from           | Gives you                                                                                                                                | Pulls in the schema compiler?                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `@ltr8/tson`          | `parse`, `readTree`, `validate`, `write`, tree nodes + accessors, errors, diagnostics, `createTson`, `linkSchema`, `bootstrapMetaKernel` | only if you call the compiler-backed parts; `parse` alone never does |
| `@ltr8/tson/tree`     | the `Value` node model and `get`/`at`/`as*` alone                                                                                        | no                                                                   |
| `@ltr8/tson/schema`   | the resolved-schema value model (`TypeDefinition` and its bodies)                                                                        | no                                                                   |
| `@ltr8/tson/write`    | every writer directly (`writeDocument`, `writeTree`, `writeBinding`, `Emitter`)                                                          | no                                                                   |
| `@ltr8/tson/bind`     | binding descriptors and combinators                                                                                                      | no                                                                   |
| `@ltr8/tson/identity` | `sha256Hex`, `withSha256Pin`, `declaredSha256`, `verifyContentHash`, `canonicalizeIdentity`                                              | no                                                                   |
| `@ltr8/tson/regex`    | the standalone RFC 9485 I-Regexp engine                                                                                                  | no                                                                   |
| `@ltr8/tson/stdlib`   | `standardLibrary()` / `registerStandardLibrary()` and the three bundled schemas as source text (~45 KB)                                  | yes                                                                  |
| `@ltr8/tson/source`   | `httpSchemaSource`, `fileSchemaSource` — **Node-only**, never reachable from the default entry                                           | no                                                                   |

`@ltr8/tson/source` is deliberately unreachable from `@ltr8/tson`, so a browser build never pulls in
`node:fs` or `node:http`. A browser that needs schemas supplies its own `SchemaSource` (below).

## The four functions

```ts
import { parse, readTree, validate, write, get, at, asString, asInt } from '@ltr8/tson';

const bytes = new TextEncoder().encode(`{
  order_id: 1042
  customer: { name: "Ada Lovelace" }
  placed: !date 2026-07-01
  total: 149.95
}`);

// parse — Class 1 syntax only (§2, §7.4). The parse-preserving AST; no schema consulted or
// needed. Importing this does not pull in the schema compiler.
parse(bytes).document.root.coreValue.kind; // 'record'

// readTree — the built-in type vocabulary resolved into a queryable Value tree (§5). Fail-fast.
const tree = readTree(bytes);
asString(at(tree, '/customer/name')); // 'Ada Lovelace'
asInt(get(tree, 'order_id')); // 1042

// validate — the same read, collecting. Never throws for a bad document.
validate(bytes).diagnostics; // []

// write — canonical form back to text. There is no separate "pretty" mode.
write(tree);
// '{ order_id: 1042 customer: { name: "Ada Lovelace" } placed: !date "2026-07-01" total: 149.95 }'
```

`write(value, { id, schema })` adds the `!!id`/`!!schema` header directives; with neither it writes
a plain headerless document.

### Navigating the tree

`Value` is a discriminated union on `kind`: `'record' | 'map' | 'array' | 'tuple' | 'atom' |
'absent' | 'missing'`. **Every accessor is total** — nothing throws.

| Call                                                    | Answers                                                              |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| `get(node, 'name')` / `get(node, 0)`                    | one field/entry by name, or one element by index                     |
| `at(node, '/customer/name')`                            | RFC 6901 JSON Pointer; `''` is the node itself                       |
| `as(node, guard)`, `asString`, `asBoolean`, `asDecimal` | **cast** — "did the read produce this host type?" `undefined` if not |
| `asInt`, `asLong`, `asDouble`                           | **convert** — "what number does this represent?" exactness-checked   |

A failed step yields `missingNode`: `{ kind: 'missing', path: '/customer/email' }`. The path is the
pointer _up to and including the step that failed_, and every further `get`/`at` returns that same
node — the first failure is the informative one. `'missing'` (nothing there) is not `'absent'`
(the document wrote `_` or `null` there).

Casting and converting differ: an `int32` atom holds a `number` and does not satisfy a `bigint`
guard, while `asInt` on a `234.56E2` decimal succeeds because its value is integral.

## Reading under a schema

Without a schema, a custom `!type` annotation is an error — `readTree`/`validate` resolve only the
built-in vocabulary (`!uuid`, `!date`, …). Pass `{ schema, root }` to govern the read:

```ts
import { validate } from '@ltr8/tson';
import { standardLibrary } from '@ltr8/tson/stdlib';

const SCHEMA = `!!id:"https://example.com/order.tn"
!!meta:"https://tson.io/2026/34/m/meta.tn"
!!import:"https://tson.io/2026/34/m/core.tn"
{
  order => {
    order_id: int32
    customer: customer
    placed:   date
    total:    number
  }
  customer => {
    name: text
  }
}
`;

const tson = standardLibrary(); // meta-kernel, meta.tn, core.tn already registered
const linked = tson.resolveSchema(SCHEMA); // registers it under its own !!id
const schema = tson.compile(linked);

const result = validate(bytes, { schema, root: 'order' });
result.diagnostics; // []
```

Three stages, and it is worth knowing which is which: **resolve** (schema text → `LinkedSchema`,
against what the registry already holds), **link** (references checked, name hygiene applied), and
**compile** (`LinkedSchema` → `CompiledSchema`, whose readers are built lazily per entry). `root` is
the entry name the _root value_ reads against, and it is not inferred from the document's own
`!!schema` directive.

`standardLibrary()` is not a singleton — a registry is mutable state, and two callers sharing one
would see each other's registrations. Build a fresh one per unit of work; re-resolving the same
schema text into the same instance is a caller error, not an idempotent no-op.

`createTson(config)` is the same thing without the bundled schemas. Use it directly only when
supplying a standard library from elsewhere (a newer revision, a private mirror), which needs
`bootstrapMetaKernel` because meta-kernel's `!!meta` names itself (§1.5) and cannot resolve the
ordinary way.

## Fetching schemas

**Resolution is synchronous; fetching is not, and that split is the whole design.**
`resolveSchema` resolves only against what is already registered and never fetches — even with a
`schemaSource` configured. `preload` fetches, resolves, links and registers, **in order**, so that
by the time a dependent schema resolves, everything it names is already in place.

```ts
import { createTson } from '@ltr8/tson';
import { httpSchemaSource } from '@ltr8/tson/source';

const tson = createTson({ schemaSource: httpSchemaSource({ allowHosts: ['tson.io'] }) });
await tson.preload(['https://tson.io/2026/34/m/meta.tn', 'https://tson.io/2026/34/m/core.tn']);
```

`preload` verifies a `?sha256=` pin whenever one is declared, and cross-checks that the fetched
document's own `!!id` is the identity that was asked for.

**A schema reference is attacker-controlled** — a data document names its own schema, so on a server
that string came out of a request body. Both shipped sources are deny-by-default and every knob is
load-bearing:

| Source             | Configure                                                                                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `httpSchemaSource` | `allowHosts` (nothing is fetched without it), `mapHosts`, `maxDocumentBytes`, `timeoutMs`, `maxCachedSchemas`, `requireContentHashPin`. No redirects are followed.                                                |
| `fileSchemaSource` | `mapHosts` (host → directory; nothing is read until a host is mapped), `maxDocumentBytes`, `maxCachedSchemas`, `requireContentHashPin`. Containment is checked after `realpath`, and only regular files are read. |

A `SchemaSource` is structural — `{ fetch(reference: string): Promise<Uint8Array> }` — so a test
double, an in-memory map, or a browser build shipping its schemas as static assets all satisfy it
without importing `@ltr8/tson/source` at all.

## Streaming

`parse`, `readTree`, `validate` and `classifyDocument` are overloaded: a complete `Uint8Array`
returns synchronously, and an async source (a web `ReadableStream`, or any
`AsyncIterable<Uint8Array>`) returns a `Promise` resolving as bytes arrive.

```ts
const tree = await readTree(Readable.toWeb(createReadStream('order.tn')));
```

Memory stays proportional to nesting depth either way — nothing materialises a whole document to
read part of it. The whole read stack is written once in a suspendable, sync-shaped style and driven
by two drivers, so there is no second async-only code path to fall out of sync.

## Classifying, hashing, identity

Whether a file is data or schema is a property of its header, not its extension (§2.2), and deciding
costs at most two directives of lookahead:

```ts
import { classifyDocument } from '@ltr8/tson';

classifyDocument(dataBytes); // { kind: 'data' }
classifyDocument(schemaBytes); // { kind: 'schema', id: 'https://…', meta: 'https://…' }
```

It really does stop at the header: a gigabyte document costs the same as a two-line one, and a
document whose body will not parse still classifies.

```ts
import { sha256Hex, withSha256Pin, canonicalizeIdentity } from '@ltr8/tson/identity';

const hex = await sha256Hex(schemaBytes); // SHA-256 over every byte past the !!id line
withSha256Pin('https://example.com/order.tn', hex);
// 'https://example.com/order.tn?sha256=12cc8e…'
canonicalizeIdentity('https://example.com/order.tn?sha256=12cc8e…');
// 'example.com/order.tn' — scheme and query stripped, nothing else
```

`declaredSha256` reads a pin back out, `verifyContentHash` checks bytes against one. Never invent or
truncate a hash.

## Errors and diagnostics

Two shapes, one per read mode.

**Fail-fast (`readTree`, `parse`).** `parse` throws the narrow error directly — `TsonLexError`,
`TsonParseError`. `readTree` routes everything through one `TsonReadError` and attaches the original
as `.cause`:

```ts
try {
  readTree(bytes);
} catch (e) {
  e instanceof TsonReadError; // true, for a lex error too
  (e as TsonReadError).cause; // TsonLexError / TsonParseError, when there was one
}
```

The one exception is **name hygiene**, which throws `TsonNameHygieneRefusedError` — deliberately not
a `TsonReadError`, because §8.2's refusal is a _fifth outcome_ apart from §8.1's four error
categories and must be unmistakable for one of them.

**Collecting (`validate`).** `{ value, diagnostics }`, and an empty `diagnostics` means the document
conforms — including for a document that will not lex, which arrives as a `VALIDATION_ERROR` with
the root value as a `missingNode` rather than as a throw. A `Diagnostic` carries `code`, `message`,
`path` (RFC 6901 into the data), `schemaId`/`schemaPointer`, `expected`/`actual`, and
`dataPosition`/`schemaPosition`:

```json
{
  "code": "ATOM_CONSTRAINT_VIOLATION",
  "message": "'x' is not a valid integer -- only integer and based-integer forms are accepted (§5.6)",
  "path": "/order_id",
  "schemaId": "example.com/order.tn",
  "schemaPointer": "/order/order_id",
  "expected": "an integer or based-integer form",
  "actual": "x",
  "dataPosition": { "line": 1, "column": 13, "offset": 12 }
}
```

`DiagnosticCode` is a **closed union** — switch on it exhaustively rather than matching message
text. `NOT_IMPLEMENTED` is the one code that is a verdict on the library, not the document; treat it
as a bug report, not as invalid input. Full code list and error-class hierarchy:
`references/diagnostics.md`.

## Resource limits and name policy

`maxNestingDepth` (default **512**, §9.1) bounds nesting, per call or once per instance. The
recursion is real — one host call frame per level — so lowering it is free and raising it is bounded
by the host stack. A document past the limit is refused with a typed error and a position, never a
host `RangeError`.

```ts
parse(bytes, { maxNestingDepth: 64 });
readTree(bytes, { schema, root: 'order', maxNestingDepth: 64 });
createTson({ maxNestingDepth: 64 }); // every schema it resolves and document it reads
```

§8.2's three name-hygiene mechanisms are on by default (skeleton distinctness, `Identifier_Status`,
Highly Restrictive over the whole name). Relaxation is a **code decision stated at the call site** —
never an environment variable, because a security policy read from the environment is ambient
authority. State it once on the instance, via `Config.identifierPolicy`:

```ts
const tson = createTson({
  identifierPolicy: {
    skeletonDistinctness: true,
    identifierStatus: true,
    restrictionLevel: 'ASCII_ONLY', // ASCII_ONLY | SINGLE_SCRIPT | HIGHLY_RESTRICTIVE | …
    restrictionUnit: 'WHOLE_NAME', // or 'PER_SEGMENT' — §8.2's first relaxation to reach for
    permittedScripts: [], // combinations admitted in addition to the level -- build with `permitting`
  },
});
```

Script combinations are `ScriptId` numbers, not names — `scriptNamed('Latin')` resolves the UCD
`Script` property's long-form name to one, so `permittedScripts: [[scriptNamed('Latin')!,
scriptNamed('Cyrillic')!]]` admits that combination in addition to whatever the level already
allows. `NamePolicy`/`TokenPolicy` themselves are not exported by name — build a plain object
satisfying `Config.identifierPolicy`/`Config.tokenPolicy`'s shape rather than importing the type.

`Config.tokenPolicy` is the same shape's counterpart over _values_ rather than declared names —
only the restricted-script mechanism applies there, since a value has no identifier profile to
violate and no scope to be distinct within; it defaults to `UNRESTRICTED`, so an ordinary read
scans no values at all. `tson.processorPolicy` reports both policies together with the UCD version
they were computed against, the same record `tson policy` prints from the command line.

Name hygiene decides **policy, not validity**: it can never make a document invalid, and its verdict
can change under a routine Unicode data refresh, which is why it is reported apart from the four
error categories.

## CLI

```bash
npx @ltr8/tson-cli init-example .                                            # person.tn + person-data.tn
npx @ltr8/tson-cli validate person-data.tn --schema person.tn --root person
npx @ltr8/tson-cli validate --format json data/*.tn                          # Class 1 only, no schema
npx @ltr8/tson-cli compile person.tn
npx @ltr8/tson-cli policy                                                    # the §8.2 policy this run would apply
npx @ltr8/tson-cli hash person.tn                                            # canonical content hash (§2.2.1)
```

`tson --help` lists the five commands; `tson <command> --help` prints that command's own page,
including the shared policy-flag block below for `validate`/`compile`/`policy`.

|                          |                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commands                 | `validate`, `compile`, `policy`, `hash`, `init-example`                                                                                                 |
| `--schema <file-or-url>` | validate only; a local path or an `https://` URL. **Never** a data file's own `!!schema` — honouring that would fetch whatever untrusted content named. |
| `--root <name>`          | required whenever `--schema` is given; not auto-detected                                                                                                |
| `--format`               | `text` (default), `json`, `tson`, on every command                                                                                                      |
| `-`                      | reads one data document from stdin (validate, at most once)                                                                                             |
| Exit codes               | see below, ranked `70 > 78 > 69 > 75 > 1` by who must act first                                                                                         |

`validate`/`compile`/`hash` register the bundled `meta-kernel`/`meta.tn`/`core.tn`, so they work
offline with no `SchemaSource`. Data files are streamed, never buffered whole. Any argument
beginning with `-` that is not a known flag is a usage error, never a file name.

| Exit | Meaning                                                                                     |
| ---- | ------------------------------------------------------------------------------------------- |
| `0`  | checked, and nothing to report                                                              |
| `1`  | checked and rejected — includes a §8.2 name-hygiene refusal, since the sender holds the fix |
| `2`  | usage error                                                                                 |
| `69` | a schema permanently unavailable — refused by policy, absent, or too large                  |
| `75` | a schema temporarily unavailable — unreachable, or it did not answer in time                |
| `78` | a type the schema needs has no registered binding                                           |
| `70` | a gap in this library, or an internal fault — never a statement about the document          |

### Policy flags

`--identifier-policy <level>`, `--identifier-per-segment`, `--identifier-scripts <A+B>`,
`--token-policy <level>`, `--token-scripts <A+B>` are shared by `validate`, `compile` and `policy`.
`<level>` is a UTS #39 §5.2 restriction level (`ascii-only` … `unrestricted`, or the
`ASCII_ONLY`-style spelling `tson policy` prints, accepted back); `<A+B>` names UCD `Script`
property long-form names joined by `+` (`Latin+Cyrillic` — never the ISO 15924 alias `Latn`).
`tson policy [<policy options>]` prints the policy a run under those flags would apply, with no
document in hand — a generator can conform before writing rather than after being refused, and its
own JSON/tson `policy` record is exactly what a `validate`/`compile` run of the same flags carries
as its `policy` field.

### Machine-readable output

`--format json` is the shape to parse in CI. **Its field names are `snake_case`, unlike the
library's own `camelCase` `Diagnostic`** — `schema_id`, `schema_pointer`, `data_position`,
`schema_position` — and every optional field is omitted rather than emitted as `null`. The run and
each file report an `outcome` of `"VALID"`, `"INVALID"` or `"NOT_CHECKED"` — never a plain `valid`
boolean, so a file whose schema could not be obtained is distinguishable from one that failed:

```json
{
  "outcome": "INVALID",
  "policy": {
    "identifier_policy": { "level": "HIGHLY_RESTRICTIVE", "per_segment": false, "permitting": [] },
    "token_policy": { "level": "UNRESTRICTED", "per_segment": false, "permitting": [] },
    "unicode_data_version": "16.0"
  },
  "files": [
    {
      "file": "order.tn",
      "outcome": "INVALID",
      "diagnostics": [
        {
          "code": "ATOM_CONSTRAINT_VIOLATION",
          "message": "'x' is not a valid integer …",
          "path": "/order_id",
          "schema_id": "example.com/order.tn",
          "schema_pointer": "/order/order_id",
          "expected": "an integer or based-integer form",
          "actual": "x",
          "data_position": { "line": 1, "column": 13, "offset": 12 }
        }
      ]
    }
  ]
}
```

Every `validate`/`compile` run carries `policy` — the same record `tson policy` prints on its own
— so a report always states what it was judged under. A file whose schema could not be obtained
carries `"outcome": "NOT_CHECKED"` and a `SCHEMA_*` diagnostic with no `path`/`schema_pointer`
(nothing was read to place one); a `NOT_IMPLEMENTED` or `BIND_MISMATCH` diagnostic likewise makes
its file `NOT_CHECKED` rather than `INVALID`. `--format tson` is the same record written through
the library's own writer; `--format text` is one line per diagnostic, `CODE at /path
(line:column): message`, or `CODE at the document root: message` when `path` is `""`.

## Object binding

Reading straight into your own classes uses `@ltr8/tson/bind`: a `Binding` is a **value you author**
with combinators, never derived by reflection, and it is independent of any schema. See
`references/bindings.md` for the full combinator set, the strictness checks, and the two known API
gaps (there is no exported `atom()` combinator, and the streaming `bindReader` cannot be reached
from the published package). The supported route today is decode-from-AST:

```ts
import { parse } from '@ltr8/tson';
import { record, field, optional, fromDataValue } from '@ltr8/tson/bind';
import { writeBinding } from '@ltr8/tson/write';

const { document } = parse(bytes);
const person = fromDataValue(personBinding, document.root, decodeAtom);
writeBinding(personBinding, person); // '{ name: "Ada" age: 36 }'
```

## Browser and bundling

- No `DOM` lib and no Node built-ins in anything that must run in a browser; the library encodes and
  decodes UTF-8 itself rather than using `TextEncoder`/`TextDecoder` internally.
- The whole pipeline — lexer, parser, schema compiler, validator, and the three bundled schemas —
  is about **84 KB gzipped**. `examples/web-demo` runs all of it client-side.
- ESM output shares chunks across subpath entries. **CJS output does not** (esbuild's code splitting
  is ESM-only), so a CJS consumer mixing `@ltr8/tson` and `@ltr8/tson/stdlib` gets one copy of a
  shared module _per entry_. Nothing currently depends on module identity across that boundary, but
  a new module-level `Map`/`WeakMap`/`instanceof` check would break CJS silently.

## Pitfalls

| You wrote                                                                                   | Problem                                                                                           | Do this instead                                                    |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `readTree(text)` with a `string`                                                            | every read takes bytes                                                                            | `new TextEncoder().encode(text)`, or a stream                      |
| `TextDecoder` → re-encode before reading                                                    | destroys the malformed-UTF-8 cases the format rejects                                             | feed the raw bytes through untouched                               |
| `catch (e) { if (e instanceof TsonLexError) }` around `readTree`                            | `readTree` wraps everything in `TsonReadError`                                                    | check `e.cause`, or use `parse` for the narrow error               |
| Expecting `validate` to throw on a syntax error                                             | it collects; an empty `diagnostics` is the only "valid"                                           | check `result.diagnostics.length`                                  |
| Matching diagnostic `message` text                                                          | messages are not API                                                                              | switch on `code`                                                   |
| `readTree(bytes)` with a custom `!type`                                                     | schemaless reads resolve built-ins only                                                           | pass `{ schema, root }`                                            |
| `tson.resolveSchema(a); tson.resolveSchema(a)`                                              | registering twice under one identity is a caller error                                            | resolve once, or build a fresh instance                            |
| `resolveSchema` expecting it to fetch an `!!import`                                         | resolution never fetches, by design                                                               | `await tson.preload([...])` first, in dependency order             |
| `createTson()` then a schema-governed read                                                  | a fresh instance's registry is **empty**                                                          | `standardLibrary()`, or register the kernel yourself               |
| `httpSchemaSource({})`                                                                      | no `allowHosts` means nothing is permitted                                                        | name the hosts explicitly                                          |
| Trusting a data file's own `!!schema` to pick a schema                                      | that reference is attacker-controlled                                                             | name the schema at the call site                                   |
| Treating `'missing'` and `'absent'` as the same                                             | `absent` was written (`_`/`null`); `missing` is a failed lookup                                   | discriminate on `kind`                                             |
| `as`/`asString` where a conversion was meant                                                | casts do not convert                                                                              | `asInt`/`asLong`/`asDouble`                                        |
| `CONFUSABLE_NAMES`/`RESTRICTED_CHARACTER`/`RESTRICTED_SCRIPT` treated as "invalid document" | each is policy, a fifth outcome (`isVerdict` is still `true` for it, just not a validity verdict) | report it separately; relax `identifierPolicy` in code if intended |
| Relaxing name policy from an env var                                                        | ambient authority, invisible at the call site                                                     | pass `identifierPolicy`/`tokenPolicy` explicitly                   |
| A hand-written or truncated `?sha256=`                                                      | pins are verified                                                                                 | `sha256Hex` + `withSha256Pin`                                      |
| Importing `@ltr8/tson/source` in browser code                                               | Node-only (`node:fs`, `fetch`, `node:path`)                                                       | supply your own structural `SchemaSource`                          |
| `import { standardLibrary } from '@ltr8/tson'`                                              | it is its own subpath, on purpose                                                                 | `'@ltr8/tson/stdlib'`                                              |
| `!!id` pinned to a different spec revision than the library                                 | revisions are not compatible                                                                      | match the library's `0.<revision>.x`                               |

## Reference files

- `references/api.md` — the complete export inventory, subpath by subpath, with signatures.
- `references/bindings.md` — the binding layer: combinators, encode/decode, strictness, known gaps.
- `references/diagnostics.md` — every `DiagnosticCode`, the error-class hierarchy, CLI exit codes.

## Working on the implementation itself

`CLAUDE.md` at the repository root is the orientation for changing this code — the hard constraints
(zero runtime dependencies, no host regex in the number grammar, code-point-addressed lexing,
streaming), the `Task<T>` suspension model, the import zones that replace JPMS, and the
`npm ci`-only install rule. `STATUS.md` is the only checklist; `references/` here documents the API
as it stands, not how to extend it.

## Specification

- Part 1 — Text Data Format: https://tson.io/raw/2026/34/tson-part1-data.md
- Part 2 — Type System and Schema: https://tson.io/raw/2026/34/tson-part2-schema.md

Both are working revisions and change without compatibility guarantees until the spec freezes at
version 1. Re-fetch and check the revision number at the top rather than trusting a cached copy.
