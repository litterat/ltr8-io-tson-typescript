# @ltr8/tson

A TypeScript implementation of **TSON** (Typed Schema Object Notation), for Node 24+ and modern
browsers, with **zero runtime dependencies**.

> **Status: all three spec parts implemented, including the Part 3 JSON encoding; 328/328 shared
> conformance subjects passing at the pinned suite commit, Class 1 and Class 2.** See
> [STATUS.md](STATUS.md) for the full checklist. Not yet published to npm, though the packaging is
> ready: `publint` and `arethetypeswrong` run in CI on every commit, and a browser-bundle smoke test
> builds every browser-facing entry point and runs it with no Node globals in scope.

## Agent skill

**[`skills/tson-ts/`](skills/tson-ts/SKILL.md) is a written-for-agents guide to using this
library** — entry points, the schema/registry workflow, diagnostics, the CLI, and the pitfalls, with
references covering the full export inventory, the binding layer and every diagnostic code. It
complements the notation-level `tson-data` and `tson-schema` skills at
[tson.io](https://tson.io) — those cover the format, this one covers the API.

Claude Code loads it automatically in a clone of this repository, through the
`.claude/skills/tson-ts` symlink; elsewhere, copy or symlink `skills/tson-ts/` into
`~/.claude/skills/`.

`CLAUDE.md` is the orientation for working _on_ the implementation, not with it.

## Versioning

`0.<spec revision>.<patch>` — the minor version tracks the TSON spec revision this implementation is
built against, so `0.37.x` implements the **2026 Revision 37** series. A new spec revision moves the
minor; fixes within one move the patch. The major stays `0` until the spec freezes at version 1,
which is also when documents change extension from `.tn` to `.tn1` (§7.1) and every content-addressed
identity is re-pinned.

**Breaking at 0.37.0:** the void sentinel's public names follow the reference's. `AbsentNode`,
`absentNode`, `ABSENT`, the `'absent'` node and value kind, `Emitter.absentValue()` and the
`ABSENT_MAP_KEY` diagnostic code are now `VoidNode`, `voidNode`, `VOID`, `'void'`,
`Emitter.voidValue()` and `VOID_MAP_KEY`.

Both packages are released in lockstep at the same version, and `@ltr8/tson-cli` depends on
`@ltr8/tson` at an exact pin rather than a range: the two are built and tested together, and the CLI
uses subpath entry points whose surface a caret range does not promise.

## What TSON is

TSON is a schema system with its own notation, not a data format with a schema bolted on. At its
centre is a type system of immutable, hash-pinned schemas whose definitions are themselves data,
resolving down a verified chain — document → schema → meta-schema → kernel — so that one hash
authenticates a document together with its entire contract.

The text format is Unicode-first and JSON-_like_, and deliberately not a JSON superset ([TSON-DATA]
§4.1, §6): the notation carries no `null` keyword, treats field names as identifiers, and has no
surrogate-pair escapes, so a JSON document is read through the separate [TSON-JSON] encoding
([`./json`](#json-encoding)) rather than as TSON text. Commas and quotes are optional where
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
- **`_`** — the void sentinel, distinct from `null`, and it occupies an array slot
- **`@name`** — annotations, ordered and repeatable, preserved verbatim
- **`!name`** — type annotations
- **`!!name:"…"`** — directives: `id`, `schema`, `meta`, `import`, and only those

A JSON document is **not** a TSON document ([TSON-DATA] §6). What the two share — `"`-delimited
strings, `[ ]` arrays, `{ name: value }` records, the `\n \r \t \\ \"` escapes — is shared because
each was a good idea on its own. What differs is load-bearing: TSON has no `null` keyword (§4.4),
field names are identifiers (§2.5), and there are no surrogate-pair escapes (§7.2.2). JSON is read
through [TSON-JSON] instead — a second, schema-directed encoding of the same model, mapping `null`
to the void sentinel and a non-identifier-keyed object to a map — behind this package's own [`./json`
subpath](#json-encoding).

Two conformance classes in the shared corpus: **Class 1** implements the data format alone and needs
nothing from Part 2; **Class 2** implements the schema layer too. This port targets both, and both
are implemented, plus the Part 3 JSON encoding the corpus does not yet vector.

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
// Throws TsonReadError on a malformed or unresolvable document, with the narrower
// TsonLexError / TsonParseError on its `cause` when there was one.
const tree = readTree(bytes);
asString(at(tree, '/customer/name')); // 'Ada Lovelace'
asString(get(get(tree, 'customer'), 'name')); // 'Ada Lovelace'

// validate: like readTree, but collects into a ValidationResult { value?, diagnostics } instead
// of throwing. An empty `diagnostics` is the only "valid", and the only case `value` is present
// at all: a read is all-or-nothing, so a document that will not lex or parse (reported as a
// VALIDATION_ERROR) leaves `value` omitted, same as any other reported problem does.
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
await tson.preload(['https://tson.io/2026/37/m/meta.tn', 'https://tson.io/2026/37/m/core.tn']);
```

Schema resolution (`resolveSchema`) is synchronous and resolves only against what is already
registered; fetching (`preload`) is async and must run first, in dependency order, for exactly that
reason — a schema fetch is real I/O and cannot honestly be synchronous in JS the way it can in Java.

`httpSchemaSource` (deny-by-default host allow-list, no redirects, a streamed size cap, a timeout)
and `fileSchemaSource` (containment checked after `realpath`) live behind the separate, Node-only
`@ltr8/tson/source` subpath — never imported by the package's default entry, so a browser bundle
never pulls in Node's `fs`/`http`.

### JSON encoding

[TSON-JSON] (`spec/tson-part3-json.md`) is a second encoding of the same model, for when the
document on the wire has to be plain JSON — a schema-directed reader, not a superset relationship:
a JSON document names no schema of its own, so reading one always takes a compiled schema and a
root type, the way `readTree`/`validate`'s own `{ schema, root }` does. It lives behind its own
`./json` subpath so that nothing in the TSON text stack — lexer, parser, compiler — is pulled in by
a consumer that only ever reads JSON, and vice versa:

```ts
import { standardLibrary } from '@ltr8/tson/stdlib';
import { compileJsonSchema, readJsonTree, validateJson } from '@ltr8/tson/json';

const tson = standardLibrary();
const linked = tson.resolveSchema(orderSchemaText); // the same LinkedSchema readTree/validate use
const schema = compileJsonSchema(linked);

// readJsonTree: throws TsonReadError on the first problem, same posture as readTree.
const tree = readJsonTree(
  '{"order_id": 1042, "customer": {"name": "Ada Lovelace"}, "total": 149.95}',
  { schema, root: 'order' },
);

// validateJson: collects every problem (base-syntax failures included) instead of throwing --
// the same shape as validate's own ValidationResult, as ValidateJsonResult. Only a §10.1
// nesting-limit refusal still throws (a policy refusal, not a verdict on the document).
const result = validateJson(jsonBytes, { schema, root: 'order' });
result.diagnostics; // []
```

Both take an async, chunked source too (`readJsonTreeAsync`/`validateJsonAsync`), driven by the
identical `Task<T>` suspension the text stack uses, so memory stays proportional to nesting depth
either way. A schemaless read exists only at the JSON-grammar level — `parseJson`/`parseJsonAsync`
return a plain `JsonValue` tree with no type applied — because [TSON-JSON] §3.4 gives this encoding
no vocabulary-only reading the way TSON text's base type resolution does.

What this subpath does not do, today: read a document's own in-band `$schema`/`$type` binding with
no schema supplied out of band, speak the
§3.5 `TSON-Schema`/`TSON-Accept-Schema` HTTP header fields, or encode a schema-governed value back
to JSON. See [STATUS.md](STATUS.md)'s Part 3 section for the full list.

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

### Browser demo

`examples/web-demo` is a validation-diagnostics page that runs the whole pipeline client-side — the
schema is resolved, linked and compiled in the browser, the document is validated against it, and
every fault is reported in one pass with a code, a path, an expected/found pair and a position.

```bash
npm run demo:web                 # writes examples/web-demo/dist (index.html + demo.js + demo.css)
npx serve examples/web-demo/dist # ES modules need http://, not file://
```

155 KB gzipped, all of it: lexer, parser, schema compiler, validator, and the three bundled schemas.

### CLI

```bash
npx @ltr8/tson-cli init-example .        # writes person.tn + person-data.tn
npx @ltr8/tson-cli validate person-data.tn --schema person.tn --root person
npx @ltr8/tson-cli compile person.tn
npx @ltr8/tson-cli policy                # the [TSON-DATA] §8.2 policy this run would apply
npx @ltr8/tson-cli hash person.tn        # prints the canonical content hash (§2.2.1)

# .json (case-insensitive) is a JSON encoding of TSON data (TSON-JSON §3.1) and is bound the
# same way: --schema/--root, required for a .json input. Standard input is TSON text by
# default, whatever binding is given -- --input tson|json forces either encoding for every
# input this run reads, '-' included, overriding the by-extension default.
npx @ltr8/tson-cli validate person-data.json --schema person.tn --root person
cat person-data.tn | npx @ltr8/tson-cli validate --schema person.tn --root person -
cat person-data.json | npx @ltr8/tson-cli validate --schema person.tn --root person --input json -
```

Six commands: `validate`, `compile`, `policy`, `hash`, `strip`, `init-example`. `validate`/`compile`/`hash`
register `@ltr8/tson/stdlib`'s embedded `meta-kernel`/`meta.tn`/`core.tn`, so they work offline with
no `SchemaSource` configured. `--format json`/`--format tson` report an `outcome` of `VALID`,
`INVALID` or `NOT_CHECKED` — a document whose schema could not be obtained is `NOT_CHECKED`, not
`INVALID`, since nothing here read it.

Exit codes, ranked `70 > 78 > 69 > 75 > 1` by who must act first: `0` checked and nothing to
report, `1` checked and rejected (including a §8.2 name-hygiene refusal), `2` usage error, `69` a
schema permanently unavailable (refused by policy, absent, or too large), `75` a schema
temporarily unavailable (unreachable, or it timed out), `78` a type the schema needs with no
registered binding, `70` a library gap or an internal fault.

### Resource limits

§9.1 asks an implementation to bound nesting depth, and every recursive layer here costs a host
call frame per level. `maxNestingDepth` (default 64, §9.1's own) is that bound, per call or once
per instance:

```ts
parse(bytes, { maxNestingDepth: 128 });
readTree(bytes, { schema, root: 'order', maxNestingDepth: 128 });
createTson({ maxNestingDepth: 128 }); // applies to every schema it resolves and document it reads
```

A document past the limit is refused with a typed error and a position, never a host
`RangeError`. Lowering it is free; raising it is bounded by the host's own stack, since the
recursion is real — see [STATUS.md](STATUS.md).

## What is and isn't implemented

Parts 1 and 2, plus Part 2's shared conformance suite, are implemented in full — see
[STATUS.md](STATUS.md) for the itemised checklist, including the small number of documented
deferrals (e.g. `enum_set` round-tripping as a plain `array`, `@doc` key annotations dropped from
resolved schema output) and known gaps. Part 3, the JSON encoding, covers a schema-directed tree
read and its CLI/package surface — narrower than the reference implementation's own scope, which
also has an `objectReader` binding a JSON document straight into a host object; this port has no
JSON counterpart of `@ltr8/tson/bind`'s `readBind` at all. Also not implemented: an in-band-only
binding, the §3.5 HTTP header fields, or a schema-directed encoder — see
[STATUS.md](STATUS.md)'s own Part 3 section for the full, recorded list of gaps.

## Specification

- Part 1 — Text Data Format: https://tson.io/raw/2026/37/tson-part1-data.md
- Part 2 — Type System and Schema: https://tson.io/raw/2026/37/tson-part2-schema.md
- Part 3 — JSON Encoding: https://tson.io/raw/2026/37/tson-part3-json.md

The spec is a working revision and changes without compatibility guarantees until it freezes as
version 1.

## Development

```bash
./scripts/fetch-references.sh   # pinned Java reference + the shared conformance suite
npm ci                          # ci, never install -- see CLAUDE.md's "Build and test"
npm run typecheck
npm run lint
npm run format:check
npm test                        # unit
npm run test:conformance        # 328 shared subjects, at the pinned suite commit
npm run build                   # tsup, ESM + CJS + dts, both packages
```

`.references/` is gitignored and required for the conformance project, which skips with a message
rather than failing when it is absent.

See [CLAUDE.md](CLAUDE.md) for the design constraints and conventions,
[PORT-PLAN.md](PORT-PLAN.md) for how the port is organised, and
[ORCHESTRATION.md](ORCHESTRATION.md) for how it was executed.

[PORT-PLAN-REVISED.md](PORT-PLAN-REVISED.md) is the plan rewritten after the port shipped: what the
original got right, the eight things it got wrong, and the same material generalised for porting TSON
to another language. Read it before starting one.

[IDIOM-DEBT.md](IDIOM-DEBT.md) is where this port is shaped by the Java reference rather than by
TypeScript, and why each of those is deliberately held while the reference is still moving. Read it
before "fixing" anything it lists.

## Related

- [ltr8-io-tson-java](https://github.com/litterat/ltr8-io-tson-java) — the reference implementation
- [ltr8-io-tson-test-suite](https://github.com/litterat/ltr8-io-tson-test-suite) — the shared,
  language-agnostic conformance vectors

## License

Apache-2.0
