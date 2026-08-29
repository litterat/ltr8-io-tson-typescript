# @ltr8/tson

A TypeScript implementation of **TSON** (Typed Schema Object Notation) — a streaming parser, schema
compiler and validator for a typed, human-readable data format.

**Zero runtime dependencies.** Node 24+ and modern browsers.

```bash
npm install @ltr8/tson
```

```ts
import { parse, readTree, validate, write } from '@ltr8/tson';

const value = readTree(bytes); // schemaless: base syntax and the built-in type vocabulary
const result = validate(bytes, { schema: compiled, root: 'order' }); // schema-governed
```

Every read accepts a complete `Uint8Array` (returning synchronously) or a `ReadableStream` /
`AsyncIterable<Uint8Array>` (returning a `Promise`, resolving as bytes arrive). Memory stays
proportional to nesting depth either way — nothing materialises a whole document to read part of it.

## Versioning

`0.<spec revision>.<patch>` — the minor tracks the TSON spec revision this implements, so
`0.34.x` is built against the 2026 Revision 34 series. `@ltr8/tson` and `@ltr8/tson-cli` are
released in lockstep at the same version.

## Entry points

Take only what you need; importing `parse` does not pull in the schema compiler.

| Import                | Holds                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@ltr8/tson`          | `parse`, `readTree`, `validate`, `write`, and `createTson`                                                  |
| `@ltr8/tson/tree`     | the document tree model alone                                                                               |
| `@ltr8/tson/bind`     | binding descriptors and combinators                                                                         |
| `@ltr8/tson/schema`   | the resolved-schema value model                                                                             |
| `@ltr8/tson/write`    | the writers                                                                                                 |
| `@ltr8/tson/regex`    | the RFC 9485 I-Regexp engine, standalone and ReDoS-safe                                                     |
| `@ltr8/tson/identity` | content hashing and canonical identity                                                                      |
| `@ltr8/tson/stdlib`   | the bundled `meta-kernel` / `meta` / `core` schemas, embedded                                               |
| `@ltr8/tson/source`   | schema fetching over HTTPS and from disk — **Node only**, and deliberately unreachable from a browser build |

## What a browser bundle costs

`sideEffects: false` plus one entry point per separable slice, so a bundler keeps only what you
reach. Measured with esbuild against the published tarball — minified, then gzipped:

| You import                                                         | minified | gzipped   |
| ------------------------------------------------------------------ | -------- | --------- |
| `classifyDocument` — is this data or schema?                       | 69 KB    | **22 KB** |
| `parse` — the parse tree, no schema                                | 80 KB    | **25 KB** |
| `readTree` / `validate`, schemaless (base syntax + built-in types) | 89 KB    | **28 KB** |
| `parseRegex` from `@ltr8/tson/regex`, standalone                   | 24 KB    | **11 KB** |
| `standardLibrary()` — compile a schema and validate against it     | 268 KB   | **80 KB** |
| everything, every entry point                                      | 530 KB   | 160 KB    |

Two things dominate a schema-governed bundle and are worth knowing before you try to trim it. The
compiler is about a third of it, and is what schema-governed validation _is_. The built-in atom
parsers are another ~14%: they are reached through a registry keyed by type name, so a bundler
cannot tell that your schema only uses three of the thirty-three, and none of them can be shaken out.

If you only need **syntax and structure diagnostics** — malformed documents, unknown built-in
types — the schemaless row is the whole cost, and you never load the compiler at all.

`@ltr8/tson/stdlib` adds ~14 KB gzipped for the three bundled schemas as embedded text. Dropping it
means fetching them at runtime instead, which is a `SchemaSource` and a network round trip rather
than a saving.

`@ltr8/tson/source` is deliberately unreachable from a browser build: its `exports` entry offers only
the `node` condition, so a bundler cannot resolve it even by accident.

## Conformance

179 / 179 vectors of the shared, language-agnostic
[TSON conformance suite](https://github.com/litterat/ltr8-io-tson-test-suite).

## Documentation

Full documentation, the itemised status checklist and the known gaps are in the
[repository](https://github.com/litterat/ltr8-io-tson-typescript#readme).

Apache-2.0.
