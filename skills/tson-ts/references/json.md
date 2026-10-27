# The JSON encoding (`@ltr8/tson/json`)

Part 3, [TSON-JSON]: schema-directed reading of plain JSON into the same value model TSON text decodes to.

`@ltr8/tson/json` implements [TSON-JSON] (Part 3): schema-directed reading of
plain JSON into the same value model TSON text decodes to. It is a separate stack — its own lexer,
event stream and `JsonValue` tree, no dependency on `@ltr8/tson`'s own lexer/parser/compiler — so
importing it never pulls in the text encoding and vice versa. A JSON document names no schema of
its own (there is no `!!schema` equivalent), so every schema-directed read takes `{ schema, root }`
the same way `readTree`/`validate` do:

```ts
import { standardLibrary } from '@ltr8/tson/stdlib';
import { compileJsonSchema, readJsonTree, validateJson } from '@ltr8/tson/json';

const tson = standardLibrary();
const linked = tson.resolveSchema(SCHEMA); // the identical LinkedSchema tson.compile() would take
const schema = compileJsonSchema(linked);

const tree = readJsonTree('{"order_id": 1042, "customer": {"name": "Ada Lovelace"}}', {
  schema,
  root: 'order',
}); // throws TsonReadError on the first problem, same posture as readTree

const result = validateJson(jsonBytes, { schema, root: 'order' }); // collects, base-syntax failures included
result.diagnostics; // []
```

`validateJson`/`validateJsonAsync` throw only for a §10.1 nesting-limit refusal (`TsonLimitRefusedError`,
a policy refusal rather than a verdict on the document); everything else -- malformed JSON, a bad
token, §3.1's trailing-content check, a schema violation -- comes back through `diagnostics`.

`readJsonTreeAsync`/`validateJsonAsync` take an `AsyncIterable<Uint8Array>` and return a `Promise`,
same as the text stack's async overloads, and the same `maxNestingDepth` option applies. A
schemaless read (`parseJson`/`parseJsonAsync`) exists only at the JSON-grammar level — a plain
`JsonValue` tree, RFC 8259 alone, no type applied — because [TSON-JSON] §3.4 gives this encoding no
vocabulary-only reading the way TSON text's base type resolution does; do not reach for it expecting
`readTree`'s Class-1 behaviour.

Not implemented: reading a document's own in-band `$schema`/`$type` with no out-of-band binding
supplied, the §3.5 `TSON-Schema` HTTP header
fields, and a schema-directed JSON encoder — `[STATUS.md](../../STATUS.md)`'s Part 3 section has
the full list. There is also no JSON counterpart of `readBind`/object binding: this subpath reads
into a `JsonValue` tree only.
