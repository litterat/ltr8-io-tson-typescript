---
name: tson-ts
description: Read, validate, write and bind TSON (`.tn`) documents with `@ltr8/tson`, and run its `tson` command line. Use this skill whenever code imports `@ltr8/tson` or `@ltr8/tson-cli`; whenever names like `readTree`, `validate`, `createTson`, `standardLibrary`, `CompiledSchema`, `SchemaSource`, `LinkedSchema`, `Diagnostic` or `TsonReadError` appear; whenever work happens inside the `ltr8-io-tson-typescript` repository; and whenever someone wants to check, compile or hash `.tn` files from a shell, a script, a Makefile or a CI job — `npx @ltr8/tson-cli validate`, a pre-commit hook, a lint step — whatever language the surrounding project is written in. For authoring TSON *data* documents use the tson-data skill; for *schema* documents use tson-schema. This skill is the TypeScript implementation and its CLI, not the notation.
---

# `@ltr8/tson` — the TypeScript implementation

A TypeScript port of TSON (Typed Schema Object Notation) for **Node 24+ and modern browsers**, with
**zero runtime dependencies**. It implements all three spec parts — Class 1 (the text data format),
Class 2 (the schema layer), and Part 3 (the JSON encoding, behind its own `./json` subpath) — and
passes the shared conformance suite in full (695/695 subjects).

Two packages, released in lockstep: `@ltr8/tson` (the library; subpath entry points, ESM + CJS +
`.d.ts`) and `@ltr8/tson-cli` (the `tson` command). Source and issues:
**https://github.com/litterat/ltr8-io-tson-typescript** (Apache-2.0); the reference it is ported
from is [ltr8-io-tson-java](https://github.com/litterat/ltr8-io-tson-java), and both are tested
against [ltr8-io-tson-test-suite](https://github.com/litterat/ltr8-io-tson-test-suite).

**Versioning is `0.<spec revision>.<patch>`.** `0.38.x` implements the **2026 Revision 38** spec
series. A new revision moves the minor, and the spec is a working draft with no compatibility
guarantee between revisions — so a schema `!!id` pinned at `https://tson.io/2026/38/m/core.tn` is
revision-specific and must match the library's own revision. The CLI depends on the library at an
exact pin, never a range.

> Not yet published to npm at the time of writing — check
> [npmjs.com/package/@ltr8/tson](https://www.npmjs.com/package/@ltr8/tson) before writing an
> `npm install` line. Inside this repository the packages resolve as npm workspaces; from outside,
> clone the repository, `npm ci`, `npm run build`, and depend on `packages/tson` by path.

## Workflow

1. **Decide what you need.** Reading one document with no schema is one import and one call; reach
   for a schema registry only when there is more than one schema, or an `!!import` chain.
2. **Pick the narrowest entry point** below, which is how a browser bundle stays small.
3. **Feed raw bytes**, not a decoded string: `Uint8Array` (sync) or `AsyncIterable<Uint8Array>`
   (async, returning a `Promise`). A `TextDecoder` round trip destroys the malformed-UTF-8 cases the
   format is specified to reject.
4. **Choose fail-fast or collecting.** `readTree` throws at the first problem; `validate` returns
   `{ value, diagnostics }` and never throws for a bad document.
5. **Switch on `Diagnostic.code`**, a closed union, rather than inventing error strings.

## Pick the entry point

- `@ltr8/tson` — `parse`, `readTree`, `validate`, `write`, tree nodes and accessors, errors,
  diagnostics, `createTson`, `linkSchema`, `bootstrapMetaKernel`. `parse` alone never pulls in the
  schema compiler.
- `@ltr8/tson/tree` — the `Value` node model and `get`/`at`/`as*` alone.
- `@ltr8/tson/schema` — the resolved-schema value model: `Top` (an entry is its value), `Type` and
  its bodies, `TypeChain`, `Namespace`. No compiler.
- `@ltr8/tson/write` — every writer directly (`writeDocument`, `writeTree`, `writeBinding`,
  `Emitter`).
- `@ltr8/tson/bind` — binding descriptors and combinators.
- `@ltr8/tson/identity` — `sha256Hex`, `withSha256Pin`, `declaredSha256`, `verifyContentHash`,
  `canonicalizeIdentity`.
- `@ltr8/tson/regex` — the standalone RFC 9485 I-Regexp engine.
- `@ltr8/tson/stdlib` — `standardLibrary()` / `registerStandardLibrary()` and the five bundled
  schemas as source text (`meta-kernel`, `meta`, `core`, `net`, `policy`). Pulls in the compiler.
- `@ltr8/tson/json` — Part 3, the JSON encoding (below).
- `@ltr8/tson/source` — `httpSchemaSource`, `fileSchemaSource`. **Node-only**, never reachable from
  the default entry, so a browser build never pulls in `node:fs` or `node:http`; a browser supplies
  its own `SchemaSource`.

## The four functions

```ts
import { parse, readTree, validate, write, get, at, asString, asInt } from '@ltr8/tson';

const bytes = new TextEncoder().encode(`{
  order_id: 1042
  customer: { name: "Ada Lovelace" }
  placed: !date 2026-07-01
  total: 149.95
}`);

// parse — Class 1 syntax only (§2, §7.4): the parse-preserving AST, no schema, no compiler.
parse(bytes).document.root.coreValue.kind; // 'record'

// readTree — the built-in vocabulary resolved into a queryable Value tree (§5). Fail-fast.
const tree = readTree(bytes);
asString(at(tree, '/customer/name')); // 'Ada Lovelace'
asInt(get(tree, 'order_id')); // 1042

// validate — the same read, collecting.
validate(bytes).diagnostics; // []

// write — canonical form back to text. There is no separate "pretty" mode.
write(tree);
// '{ order_id: 1042 customer: { name: "Ada Lovelace" } placed: !date "2026-07-01" total: 149.95 }'
```

`write(value, { id, schema })` adds the `!!id`/`!!schema` header directives; with neither it writes
a plain headerless document.

### Navigating the tree

`Value` is a discriminated union on `kind`: `'record' | 'map' | 'array' | 'tuple' | 'atom' |
'void' | 'missing'`. **Every accessor is total** — nothing throws.

- `get(node, 'name')` / `get(node, 0)`: one field or entry by name, or one element by index.
- `at(node, '/customer/name')`: an RFC 6901 JSON Pointer; `''` is the node itself.
- `as(node, guard)`, `asString`, `asBoolean`, `asDecimal`: **cast**, `undefined` if the read did not
  produce that host type.
- `asInt`, `asLong`, `asDouble`: **convert**, exactness-checked.

A failed step yields `missingNode`: `{ kind: 'missing', path: '/customer/email' }`. The path is the
pointer _up to and including the step that failed_, and every further `get`/`at` returns that same
node — the first failure is the informative one. `'missing'` (nothing there) is not `'void'`
(the document wrote `_` there -- the format's one spelling of absence, §4.4: `null` is an
ordinary word that resolves to the string `"null"`).

## Reading under a schema

Without a schema, a custom `!type` annotation is an error — `readTree`/`validate` resolve only the
built-in vocabulary (`!uuid`, `!date`, …). Pass `{ schema, root }` to govern the read:

```ts
import { validate } from '@ltr8/tson';
import { standardLibrary } from '@ltr8/tson/stdlib';

const SCHEMA = `!!id:"https://example.com/order.tn"
!!meta:"https://tson.io/2026/38/m/meta.tn"
!!import:"https://tson.io/2026/38/m/core.tn"
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

const tson = standardLibrary(); // the five bundled schemas already registered
const linked = tson.resolveSchema(SCHEMA); // registers it under its own !!id
const schema = tson.compile(linked);

const result = validate(bytes, { schema, root: 'order' });
result.diagnostics; // []
```

Three stages: **resolve** (schema text → `LinkedSchema`,
against what the registry already holds), **link** (references checked, name hygiene applied), and
**compile** (`LinkedSchema` → `CompiledSchema`, whose readers are built lazily per entry). `root` is
the entry name the _root value_ reads against, and it is not inferred from the document's own
`!!schema` directive.

A schema using `ipv4`, `ipv6`, `cidr4`, `cidr6`, `mac`, `hostname`, `host` or `media_type` imports
`https://tson.io/2026/38/m/net.tn` as well; they are not in `core.tn`.

`standardLibrary()` is not a singleton — a registry is mutable state, and two callers sharing one
would see each other's registrations. Build a fresh one per unit of work; re-resolving the same
schema text into the same instance is a caller error, not an idempotent no-op.

`createTson(config)` is the same thing without the bundled schemas. Use it directly only when
supplying a standard library from elsewhere (a newer revision, a private mirror), which needs
`bootstrapMetaKernel` because meta-kernel's `!!meta` names itself (§1.5) and cannot resolve the
ordinary way.

## JSON encoding

`@ltr8/tson/json` implements [TSON-JSON] (Part 3): schema-directed reading of plain JSON into the
same value model TSON text decodes to, as a separate stack with its own lexer, event stream and
`JsonValue` tree. A JSON document names no schema of its own, so every read takes `{ schema, root }`.

```ts
import { standardLibrary } from '@ltr8/tson/stdlib';
import { compileJsonSchema, readJsonTree, validateJson } from '@ltr8/tson/json';

const linked = standardLibrary().resolveSchema(SCHEMA); // the LinkedSchema tson.compile() takes
const schema = compileJsonSchema(linked);
const tree = readJsonTree('{"order_id": 1042}', { schema, root: 'order' }); // throws on the first problem
validateJson(jsonBytes, { schema, root: 'order' }).diagnostics; // collects
```

`references/json.md` has the async forms, the schemaless `parseJson`, and what is not implemented.

## Fetching schemas

**Resolution is synchronous; fetching is not, and that split is the whole design.**
`resolveSchema` resolves only against what is already registered and never fetches. `preload`
fetches, resolves, links and registers **in order**, so everything a schema names is in place by the
time it resolves.

```ts
import { createTson } from '@ltr8/tson';
import { httpSchemaSource } from '@ltr8/tson/source';

const tson = createTson({ schemaSource: httpSchemaSource({ allowHosts: ['tson.io'] }) });
await tson.preload(['https://tson.io/2026/38/m/meta.tn', 'https://tson.io/2026/38/m/core.tn']);
```

`preload` verifies a `?sha256=` pin whenever one is declared, and checks that the fetched
document's own `!!id` is the identity asked for.

**A schema reference is attacker-controlled** — a data document names its own schema, so on a server
that string came out of a request body. Both sources are deny-by-default: `httpSchemaSource` needs
`allowHosts` (nothing is fetched without it) and follows no redirects; `fileSchemaSource` needs a
`mapHosts` entry (host to directory) and checks containment after `realpath`. Both take
`maxDocumentBytes`, `maxCachedSchemas` and `requireContentHashPin`; the HTTP one also `mapHosts` and
`timeoutMs`.

A `SchemaSource` is structural — `{ fetch(reference: string): Promise<Uint8Array> }` — so a test
double, an in-memory map, or a browser build shipping its schemas as static assets satisfies it
without importing `@ltr8/tson/source`.

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
canonicalizeIdentity(withSha256Pin('https://example.com/order.tn', hex)); // 'example.com/order.tn'
```

A canonical identity is the host's canonical text plus the path, with no scheme or query: the host
is a `host` value (§2.2.1), so a reference may spell it as a U-label or A-label, in either case, or
as any spelling of an IPv6 address, and compares equal. `declaredSha256` reads a pin back out,
`verifyContentHash` checks bytes against one. Never invent or truncate a hash.

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
a `TsonReadError`, because §8.2's refusal is an outcome apart from §8.1's four error categories
and must be unmistakable for one of them.

**Collecting (`validate`).** `{ value?, diagnostics }`, and an empty `diagnostics` means the document
conforms and `value` is present — a read is all-or-nothing, so any diagnostic at all, including for
a document that will not lex (a `VALIDATION_ERROR`), leaves `value` omitted rather than filled with
a placeholder. A `Diagnostic` carries `code`, `message`, `path` (RFC 6901 into the data),
`schemaId`/`schemaPointer`, `expected`/`actual`, and `dataPosition`/`schemaPosition`.

`DiagnosticCode` is a **closed union** — switch on it exhaustively rather than matching message
text. `NOT_IMPLEMENTED` is the one code that is a verdict on the library, not the document; treat it
as a bug report, not as invalid input. Full code list and error-class hierarchy:
`references/diagnostics.md`.

## Resource limits and name policy

`maxNestingDepth` (default **64**, §9.1's own) bounds nesting, per call or once per instance
(`createTson({ maxNestingDepth })`); a document past it is refused with a typed error and a
position, never a host `RangeError`.

§8.2's three name-hygiene mechanisms are on by default. A refusal (`CONFUSABLE_NAMES`,
`RESTRICTED_CHARACTER`, `RESTRICTED_SCRIPT`) is an outcome apart from the four error categories:
`isVerdict` is `false` for its code and `isNameRefusal` is `true`, and `tson validate` reports the
file `NOT_CHECKED` and still exits 1. Name hygiene decides policy, not validity. Relaxation is a
**code decision stated at the call site** (`Config.identifierPolicy`, `Config.tokenPolicy`), never
an environment variable. `references/policy.md` has the policy shapes and helpers.

## CLI

```bash
npx @ltr8/tson-cli init-example .                                            # person.tn + person-data.tn
npx @ltr8/tson-cli validate person-data.tn --schema person.tn --root person
npx @ltr8/tson-cli validate person-data.json --schema person.tn --root person # .json, [TSON-JSON]
npx @ltr8/tson-cli compile person.tn
npx @ltr8/tson-cli policy                                                    # the §8.2 policy a run would apply
npx @ltr8/tson-cli hash person.tn                                            # canonical content hash (§2.2.1)
npx @ltr8/tson-cli strip person.tn                                           # the schema's reading form
```

Six commands: `validate`, `compile`, `policy`, `hash`, `strip`, `init-example`. `--schema` is a
local path or `https://` URL and is **never** a data file's own `!!schema`; it requires `--root`.
`validate`/`compile`/`hash` register the five bundled schemas, so they work offline.

Exit codes, ranked `70 > 78 > 69 > 75 > 1` by who must act first: `0` checked and nothing to
report, `1` checked and rejected (a §8.2 refusal included), `2` usage error, `69` a schema
permanently unavailable, `75` one temporarily so, `78` a type with no registered binding, `70` a
library gap or internal fault. `--format json` reports an `outcome` of `VALID`, `INVALID` or
`NOT_CHECKED` in `snake_case` fields. `references/cli.md` has every flag and the report shape.

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
- The whole pipeline — lexer, parser, schema compiler, validator, and the five bundled schemas —
  is about **220 KB gzipped**. `examples/web-demo` runs all of it client-side.
- ESM output shares chunks across subpath entries. **CJS output does not** (esbuild's code splitting
  is ESM-only), so a CJS consumer mixing `@ltr8/tson` and `@ltr8/tson/stdlib` gets one copy of a
  shared module _per entry_. Nothing currently depends on module identity across that boundary, but
  a new module-level `Map`/`WeakMap`/`instanceof` check would break CJS silently.

## Pitfalls

- `readTree(text)` with a `string`: every read takes bytes. Never `TextDecoder` and re-encode.
- `catch (e) { if (e instanceof TsonLexError) }` around `readTree`: it wraps in `TsonReadError`;
  check `e.cause`, or use `parse`.
- Expecting `validate` to throw: it collects, and an empty `diagnostics` is the only "valid".
- Matching diagnostic `message` text: switch on `code`.
- A custom `!type` with no `{ schema, root }`: schemaless reads resolve built-ins only.
- `createTson()` then a governed read: a fresh registry is **empty**; use `standardLibrary()`.
- `resolveSchema` twice on one identity, or expecting it to fetch an `!!import`: build a fresh
  instance, and `await tson.preload([...])` first.
- Treating `'missing'` and `'void'` alike: `void` was written (`_`); `missing` is a failed lookup.
- Treating a name refusal as an "invalid document": report it separately.
- Importing `@ltr8/tson/source` in browser code, or `standardLibrary` from `@ltr8/tson`.
- A schema using `ipv4`, `mac`, `cidr4` or `hostname` that imports only `core.tn`: import `net.tn`.
- `!!id` pinned to a different revision than the library: match `0.<revision>.x`.

`references/pitfalls.md` is the full table.

## Reference files

- `references/api.md` — the complete export inventory, subpath by subpath, with signatures.
- `references/bindings.md` — the binding layer: combinators, encode/decode, strictness, known gaps.
- `references/diagnostics.md` — every `DiagnosticCode`, the error-class hierarchy, CLI exit codes.
- `references/cli.md` — every command and flag, the policy flags, the machine-readable report.
- `references/json.md` — the JSON encoding: async forms, schemaless `parseJson`, what is missing.
- `references/policy.md` — resource limits and the §8.2 name policy, with its helpers.
- `references/pitfalls.md` — the full pitfalls table.

## Working on the implementation itself

`CLAUDE.md` at the repository root is the orientation for changing this code: the hard constraints,
the `Task<T>` suspension model, the import zones, and the `npm ci`-only install rule. `STATUS.md`
is the only checklist; `references/` here documents the API as it stands.

## Specification

- Part 1 — Text Data Format: https://tson.io/raw/2026/38/tson-part1-data.md
- Part 2 — Type System and Schema: https://tson.io/raw/2026/38/tson-part2-schema.md
- Part 3 — JSON Encoding: https://tson.io/raw/2026/38/tson-part3-json.md (`@ltr8/tson/json`)

All are working revisions and change without compatibility guarantees until the spec freezes at
version 1. Re-fetch and check the revision number at the top rather than trusting a cached copy.
