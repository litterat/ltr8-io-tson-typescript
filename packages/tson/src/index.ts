/**
 * `@ltr8/tson` — a TypeScript implementation of TSON (Typed Schema Object Notation).
 *
 * This is the default entry: the four flat, tree-shakable front-door functions ({@link parse},
 * {@link readTree}, {@link validate}, {@link write}), `createTson(config)` as a config-bound
 * convenience over a schema registry built on them (`config.ts`'s own top note), and enough of
 * the compiler/linking pipeline (`bootstrapMetaKernel`/`linkSchema`/`compile`) to build the
 * {@link CompiledSchema} those functions and that registry both consume.
 *
 * **Anyone who imports {@link parse} does not pay for the schema compiler.**
 * `facade/parse.ts`'s own top note: its import graph terminates in `ast/`, `stream/`, `core/`
 * and `io/`, never `compiler/`. {@link readTree}/{@link validate}/`createTson` are compiler-backed
 * by design (a schema-governed read is what they are for) and do not carry that guarantee.
 *
 * Narrower subpaths exist for a consumer who wants less still: `@ltr8/tson/tree` (the document
 * tree alone), `@ltr8/tson/bind` (binding descriptors), `@ltr8/tson/schema` (the resolved-schema
 * value model), `@ltr8/tson/write` (every writer directly) and `@ltr8/tson/regex` (the I-Regexp
 * engine, standalone). `@ltr8/tson/source` is the one subpath this entry never reaches on its
 * own: the two hardened, Node-only `SchemaSource` implementations (`source/index.ts`'s own top
 * note on why a browser build must opt in explicitly).
 */
export * from './core/position.js';
export * from './core/errors.js';
export * from './core/diagnostic.js';
export * from './io/bytes.js';
export * from './lexer/token.js';
export * from './stream/event.js';
export * from './ast/value.js';
export * from './annotations/index.js';
export * from './atom/contract.js';
export * from './reader/index.js';
export * from './value/types.js';
export * from './write/index.js';

// ── The document tree (`readTree`/`validate`'s own value model) ────────────────────────────────
//
// Not a blanket `export *`: `tree/nodes.ts` and `ast/value.ts` (above) both declare a `MapEntry`
// -- two different shapes for the two different value models this package produces -- so tree's
// own is re-exported under `TreeMapEntry` instead of colliding.
export type {
  Value,
  RecordNode,
  MapNode,
  ArrayNode,
  TupleNode,
  AtomNode,
  AbsentNode,
  MissingNode,
  AtomValue,
  TsonDocument,
  MapEntry as TreeMapEntry,
} from './tree/nodes.js';
export {
  ABSENT,
  tsonDocument,
  recordNode,
  mapNode,
  arrayNode,
  tupleNode,
  atomNode,
  absentNode,
  missingNode,
} from './tree/nodes.js';
export * from './tree/accessors.js';

// ── The flat front door ─────────────────────────────────────────────────────────────────────
export * from './facade/classify.js';
export * from './facade/parse.js';
export * from './facade/tree.js';
export * from './facade/write.js';

// ── `createTson`, and enough of the resolve/link/compile pipeline to feed it ───────────────────
export * from './config.js';
export { bootstrapMetaKernel } from './schema/bootstrap.js';
export type { Schema } from './compiler/schemaResolver.js';
export { linkSchema } from './link/link.js';
export type { LinkedSchema, LinkDeps } from './link/link.js';
