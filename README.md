# @ltr8/tson

A TypeScript implementation of **TSON** (Typed Schema Object Notation), for Node 24+ and modern
browsers, with **zero runtime dependencies**.

> **Status: both spec parts implemented; 146/146 shared conformance vectors passing.** See
> [STATUS.md](STATUS.md) for the full checklist. Not yet published to npm — `publint`,
> `arethetypeswrong`, and a browser-bundle smoke test have not run yet (Wave 7).

## What TSON is

TSON is a schema system with its own notation, not a data format with a schema bolted on. At its
centre is a type system of immutable, hash-pinned schemas whose definitions are themselves data,
resolving down a verified chain — document → schema → meta-schema → kernel — so that one hash
authenticates a document together with its entire contract.

The text format is a Unicode-first superset of JSON. Commas and quotes are optional where
unambiguous, identifiers may be in any script, and there are three structural forms distinguished by
their contents rather than their brackets:

```tson
!!id:"https://example.com/orders/1042.tn"
!!schema:"https://example.com/order.tn"
@doc:"Order record exported 2026-07-03"
!order {
  order_id:  1042
  reference: !uuid 9f1c8e2a-4b7d-4e6f-9a3b-2c5d8e7f1a09
  customer: {
    name:  "Ada Lovelace"
    tier:  @deprecated GOLD
  }
  placed:  !date 2026-07-01
  flags:   0b0110
  items: [
    { sku: A-100 qty: 2 price: 49.95 discount: .5 }
    { sku: B-205 qty: 1 price: 100.00 discount: _ }
  ]
  discounts: { WELCOME10 => "10%" loyalty => _ }
}
```

- **Records** `{ name: value }` — fields, separated by `:`
- **Maps** `{ key => value }` — arbitrary keys, separated by `=>`
- **Arrays** `[ a b c ]` — whitespace or commas
- **`_`** — the absent sentinel, distinct from `null`, and it occupies an array slot
- **`@name`** — annotations, ordered and repeatable, preserved verbatim
- **`!name`** — type annotations
- **`!!name:"…"`** — directives: `id`, `schema`, `meta`, `import`, and only those

Valid JSON is valid TSON apart from two character-level exceptions in string content.

Two conformance classes: **Class 1** implements the data format alone and needs nothing from Part 2;
**Class 2** implements the schema layer too. This port targets both, and both are implemented.

## API

The public surface is **flat and tree-shakable first**: four functions cover parsing, reading,
validating and writing, with no registry to set up. `createTson` is a config-bound convenience on
top of them for a caller managing more than one schema — reach for it only when you need it.

### `parse`, `readTree`, `validate`, `write`

```ts
import { parse, readTree, validate, write, get, at, asString } from '@ltr8/tson';

const text = `{
  order_id: 1042
  customer: { name: "Ada Lovelace" }
  placed: !date 2026-07-01
  total: 149.95
}`;
const bytes = new TextEncoder().encode(text);

// parse: Class 1 syntactic parsing only (§2, §7.4) — the parse-preserving AST, no schema
// consulted or needed. The thinnest layer; importing it does not pull in the schema compiler.
const parsed = parse(bytes);
parsed.document.root.coreValue.kind; // 'record'

// readTree: the built-in type vocabulary resolved into a queryable Value tree (§5).
// Throws (TsonLexError / TsonParseError / TsonReadError) on a malformed or unresolvable document.
const tree = readTree(bytes);
asString(at(tree, '/customer/name')); // 'Ada Lovelace'
asString(get(get(tree, 'customer'), 'name')); // 'Ada Lovelace'

// validate: like readTree, but collects into a ValidationResult { value, diagnostics } instead
// of throwing on a *validation* failure. A document that will not lex or parse at all still
// throws straight through — see "What is and isn't implemented" below.
const result = validate(bytes);
result.diagnostics; // []

// write: streaming emit back to TSON text.
write(tree); // '{ order_id: 1042 customer: { name: "Ada Lovelace" } placed: !date "2026-07-01" total: 149.95 }'
```

Every one of `parse`/`readTree`/`validate` also accepts an async source — a web `ReadableStream` or
any other `AsyncIterable<Uint8Array>` — and returns a `Promise` instead, resolving as bytes arrive
rather than after buffering the whole document. Memory stays proportional to nesting depth either
way; nothing here materialises a whole document to read part of it.

With no schema given, a custom `!type` annotation (like `!order` in the example above) is an error —
`readTree`/`validate` only resolve the built-in vocabulary (`!uuid`, `!date`, and so on) without a
schema in scope. Give one via `{ schema, root }`:

```ts
const result = validate(bytes, { schema: compiledSchema, root: 'order' });
```

### `createTson` — a schema registry

`createTson(config)` adds what the flat functions cannot be on their own: a registry that resolves
and links a schema against every other schema an instance already knows about, and — given a
`SchemaSource` — fetches the ones it doesn't. A fresh instance starts empty; `@ltr8/tson/stdlib`
hands back one with `meta-kernel`/`meta.tn`/`core.tn` already registered, embedded as source text
so nothing is fetched or read from disk:

```ts
import { standardLibrary } from '@ltr8/tson/stdlib';

const tson = standardLibrary();
const catalog = tson.resolveSchema(catalogSchemaText); // its !!meta/!!import already registered
const value = tson.readTree(documentBytes, { schema: tson.compile(catalog), root: 'reading' });
```

It is a separate subpath so that importing `parse` or `readTree` does not drag in 45 KB of schema
text a Class 1 read never looks at. To register a standard library from somewhere else — a newer
revision, a private mirror — do what that subpath does, fetching through your own `SchemaSource`:

```ts
import { createTson, bootstrapMetaKernel, linkSchema } from '@ltr8/tson';
import { httpSchemaSource } from '@ltr8/tson/source';

const tson = createTson({ schemaSource: httpSchemaSource({ allowHosts: ['tson.io'] }) });
tson.register(linkSchema(bootstrapMetaKernel(metaKernelBytes)));
await tson.preload(['https://tson.io/2026/33/m/meta.tn', 'https://tson.io/2026/33/m/core.tn']);
```

Schema resolution (`resolveSchema`) is synchronous and resolves only against what is already
registered; fetching (`preload`) is async and must run first, in dependency order, for exactly that
reason — a schema fetch is real I/O and cannot honestly be synchronous in JS the way it can in Java.

`httpSchemaSource` (deny-by-default host allow-list, no redirects, a streamed size cap, a timeout)
and `fileSchemaSource` (containment checked after `realpath`) live behind the separate, Node-only
`@ltr8/tson/source` subpath — never imported by the package's default entry, so a browser bundle
never pulls in Node's `fs`/`http`.

### Classifying a document

Whether a file is data or schema is a property of its header, not its extension (§2.2), and §7.1
is explicit that deciding costs at most two directives of lookahead and no value parsing —
"streams, previews, and content sniffers can classify a document from its opening bytes":

```ts
import { classifyDocument } from '@ltr8/tson';

classifyDocument(bytes); // { kind: 'schema', id: '…', meta: '…' } | { kind: 'data', id?: '…' }
```

It really does stop at the header: classifying a gigabyte document costs the same as classifying a
two-line one, a document whose body will not parse still classifies, and over a stream only the
chunks the header needs are pulled from the source.

### Content hashing and identity

[TSON-DATA] §2.2.1's two mechanisms have their own subpath, `@ltr8/tson/identity`, because neither
needs the rest of the library — a document's content hash is computed over raw bytes and a canonical
identity over a URI string, so nothing here reaches the compiler, the lexer or the event stream:

```ts
import { sha256Hex, withSha256Pin, canonicalizeIdentity } from '@ltr8/tson/identity';

const hex = await sha256Hex(schemaBytes); // SHA-256 over every byte past the !!id line
const pinned = withSha256Pin('https://example.com/order.tn', hex);
canonicalizeIdentity(pinned); // 'example.com/order.tn' — scheme and query stripped, nothing else
```

`declaredSha256` reads a pin back out and `verifyContentHash` checks content against one; the
registry uses the same pair internally when `preload` fetches a pinned reference.

### CLI

```bash
npx @ltr8/tson-cli init-example .        # writes person.tn + person-data.tn
npx @ltr8/tson-cli validate person-data.tn --schema person.tn --root person
npx @ltr8/tson-cli compile person.tn
npx @ltr8/tson-cli hash person.tn        # prints the canonical content hash (§2.2.1)
```

`validate`/`compile`/`hash` register `@ltr8/tson/stdlib`'s embedded
`meta-kernel`/`meta.tn`/`core.tn`, so they work offline with no `SchemaSource` configured. Exit codes: `0` valid, `1`
invalid input, `2` usage error, `70` library gap or internal fault.

### Resource limits

§9.1 asks an implementation to bound nesting depth, and every recursive layer here costs a host
call frame per level. `maxNestingDepth` (default 512) is that bound, per call or once per instance:

```ts
parse(bytes, { maxNestingDepth: 64 });
readTree(bytes, { schema, root: 'order', maxNestingDepth: 64 });
createTson({ maxNestingDepth: 64 }); // applies to every schema it resolves and document it reads
```

A document past the limit is refused with a typed error and a position, never a host
`RangeError`. Lowering it is free; raising it is bounded by the host's own stack, since the
recursion is real — see [STATUS.md](STATUS.md).

## What is and isn't implemented

Both spec parts are implemented and the shared conformance suite passes in full — see
[STATUS.md](STATUS.md) for the itemised checklist, including the small number of documented
deferrals (e.g. `token_set` round-tripping as a plain `array`, `@doc` key annotations dropped from
resolved schema output) and known gaps. In particular:

## Specification

- Part 1 — Text Data Format: https://tson.io/raw/2026/33/tson-part1-data.md
- Part 2 — Type System and Schema: https://tson.io/raw/2026/33/tson-part2-schema.md

The spec is a working revision and changes without compatibility guarantees until it freezes as
version 1.

## Development

```bash
./scripts/fetch-references.sh   # pinned Java reference + the shared conformance suite
npm install
npm run typecheck
npm run lint
npm run format:check
npm test                        # unit — 1816 tests
npm run test:conformance        # 146 shared vectors
npm run build                   # tsup, ESM + CJS + dts, both packages
```

`.references/` is gitignored and required for the conformance project, which skips with a message
rather than failing when it is absent.

See [CLAUDE.md](CLAUDE.md) for the design constraints and conventions,
[PORT-PLAN.md](PORT-PLAN.md) for how the port is organised, and
[ORCHESTRATION.md](ORCHESTRATION.md) for how it was executed.

## Related

- [ltr8-io-tson-java](https://github.com/litterat/ltr8-io-tson-java) — the reference implementation
- [ltr8-io-tson-test-suite](https://github.com/litterat/ltr8-io-tson-test-suite) — the shared,
  language-agnostic conformance vectors

## License

Apache-2.0
