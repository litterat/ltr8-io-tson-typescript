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

## Conformance

146 / 146 vectors of the shared, language-agnostic
[TSON conformance suite](https://github.com/litterat/ltr8-io-tson-test-suite).

## Documentation

Full documentation, the itemised status checklist and the known gaps are in the
[repository](https://github.com/litterat/ltr8-io-tson-typescript#readme).

Apache-2.0.
