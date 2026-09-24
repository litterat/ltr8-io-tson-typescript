/**
 * `@ltr8/tson/json` — the JSON encoding ([TSON-JSON], `spec/tson-part3-json.md`). This subpath
 * currently carries the encoding-independent bottom of the stack: the lexer, the event stream,
 * the `JsonValue` tree, a schemaless read of one, and the tree writer — everything schema-directed
 * reading (§5–§8) is layered on top of. See `IDIOM-DEBT.md` for why this subpath is a parallel
 * stack rather than a mode of the TSON text one.
 *
 * **A schemaless read returns {@link JsonValue}, never `tree/nodes.ts`'s `Value`.** Three
 * converging reasons, not just a style pick:
 *
 * 1. The reference implementation's own `SchemalessTreeReader`/`Json.parse` return `JsonValue`
 *    (`design/json-lexer-stream-tree.md`), and its design note is explicit that a schema-directed
 *    tree read *also* returns `JsonValue`, never a `TsonValue` — "that is not a limitation worked
 *    around; it is what the two modes are for" (`design/json-encoding.md`).
 * 2. **The `src/json/**` ESLint zone settles it structurally.** `eslint.config.js`'s zone for this
 *    directory forbids importing `tree/` at all (alongside `lexer`, `stream`, `reader`,
 *    `compiler`, `write`, `facade` — the TSON *text* stack's own modules), so `tree/nodes.ts`'s
 *    `Value`/`RecordNode`/`MapNode` types are not even reachable from here. A schemaless read that
 *    tried to produce one would have to duplicate that whole node model inside `json/`, which is
 *    exactly the coupling the zone exists to prevent.
 * 3. **[TSON-JSON] §3.4 says plainly that this encoding has no schemaless reading to give back**:
 *    "there is no vocabulary-only reading, since a value read by no type is a schemaless value and
 *    this encoding has none." Every rule from §4.1 onward reads a JSON value *at a typed position*,
 *    so there is no first-class notion in Part 3 of a schema-free document decoding to anything at
 *    all, record-or-map included.
 *
 * **That third point is itself a spec tension worth stating rather than resolving silently.**
 * [TSON-DATA] §6 (Part 1, the notation's own account of its JSON relationship) describes a "JSON
 * reader" whose record-vs-map mapping applies in two cases in one breath: "under a schema the
 * reader validates on the same terms as this notation's Class 2 processing... schemaless, it reads
 * on base type resolution's terms (§4)" — text that plainly contemplates a schema-free JSON read
 * producing a record-or-map value. Part 3 §3.4, quoted above, says the opposite for *this*
 * encoding: no schema-free reading exists here at all. This port follows Part 3 as the governing
 * document for `@ltr8/tson/json` (the work this package was built against), so a schemaless read
 * here is exactly the `JsonValue` tree RFC 8259 alone determines, with none of §6's record/map
 * resolution applied — but Part 1 §6 and Part 3 §3.4 disagree about whether a schema-free JSON
 * reading is a thing this series defines at all, and that disagreement is reported here rather
 * than picked between silently.
 *
 * So this package's `parseJson`/`parseJsonAsync` are the whole of "schemaless read" this subpath
 * offers: a `JsonValue` tree, its shape fixed by RFC 8259 alone, with [TSON-JSON] §3.1's own
 * document-level rules applied (UTF-8, one leading BOM, duplicate-member detection, trailing
 * content refused).
 */
export type { JsonToken, JsonTokenType, JsonLexer } from './lexer.js';
export { createJsonLexer, currentJsonToken } from './lexer.js';

export type {
  JsonEvent,
  JsonEventSource,
  JsonObjectStart,
  JsonMemberName,
  JsonObjectEnd,
  JsonArrayStart,
  JsonArrayEnd,
  JsonStringEvent,
  JsonNumberEvent,
  JsonBooleanEvent,
  JsonNullEvent,
  JsonEndOfDocument,
} from './stream.js';
export { createJsonStream } from './stream.js';

export type {
  JsonValue,
  JsonObject,
  JsonArray,
  JsonString,
  JsonNumber,
  JsonBoolean,
  JsonNull,
} from './tree.js';
export {
  jsonObject,
  jsonArray,
  jsonString,
  jsonNumber,
  jsonNumberOfBigInt,
  jsonBoolean,
  jsonNull,
  JSON_NULL,
  EMPTY_JSON_OBJECT,
  EMPTY_JSON_ARRAY,
  equalJsonValue,
  get,
  at,
  tryGet,
  tryAt,
  tryValue,
  asString,
  asBoolean,
  asMap,
  asList,
  asBigInt,
  asInt,
  asDouble,
  toBigDecimal,
  parseJsonNumberLiteral,
  TsonJsonValueError,
} from './tree.js';

export { quoteJsonString, jsonValueToText, jsonValueToDisplayString } from './write.js';

export type { JsonReadContext } from './readContext.js';
export { createJsonReadContext } from './readContext.js';

export { readJsonValue, readJsonValueFromRoot, readJsonDocument } from './schemalessTree.js';

// ---------------------------------------------------------------------------------------------
// The front door: parseJson / parseJsonAsync / parseJsonCollecting
// ---------------------------------------------------------------------------------------------

import { collector, throwing, type Diagnostic } from '../core/diagnostic.js';
import { TsonReadError } from '../core/errors.js';
import type { NestingLimitOptions } from '../core/limits.js';
import { fromBytes, fromString, runOver, runSync, type ByteInput, type Task } from '../io/bytes.js';
import { createJsonStream } from './stream.js';
import { readJsonDocument } from './schemalessTree.js';
import type { JsonValue } from './tree.js';

function inputOf(source: Uint8Array | string): ByteInput {
  return typeof source === 'string' ? fromString(source) : fromBytes(source);
}

/**
 * Parses `source` (UTF-8 bytes, or a string this function encodes as UTF-8 at this one boundary —
 * `json/lexer.ts`'s own top note on why every other layer takes bytes only) into a
 * {@link JsonValue}, throwing at the first problem: {@link TsonLexError}/{@link TsonParseError}
 * for a document `json/lexer.ts`/`json/stream.ts` refuse outright, {@link TsonLimitRefusedError}
 * for [TSON-JSON] §10.1's nesting bound, and {@link TsonReadError} for a §3.1 duplicate member —
 * the JSON encoding's counterpart to this package's own `readTree`, and to the reference's
 * `Json.parse`.
 */
export function parseJson(source: Uint8Array | string, options?: NestingLimitOptions): JsonValue {
  const events = createJsonStream(inputOf(source), options);
  const receiver = throwing((d: Diagnostic) => new TsonReadError(d));
  return runSync(readJsonDocument(events, receiver));
}

/**
 * {@link parseJson}, driven by an async byte source instead of a complete buffer — the same
 * `Task<JsonValue>` the sync path runs, suspended on {@link NEED_INPUT} and resumed as chunks
 * arrive (`io/bytes.ts`'s `runOver`), so memory stays proportional to nesting depth exactly as it
 * does for TSON text. See `test/json-streaming.test.ts` for the property this exists to prove:
 * `runAsync` over any split of one document's bytes equals `runSync` over the whole.
 */
export async function parseJsonAsync(
  source: AsyncIterable<Uint8Array>,
  options?: NestingLimitOptions,
): Promise<JsonValue> {
  const receiver = throwing((d: Diagnostic) => new TsonReadError(d));
  return runOver(source, (input: ByteInput): Task<JsonValue> =>
    readJsonDocument(createJsonStream(input, options), receiver),
  );
}

/** {@link parseJson}/{@link parseJsonAsync}'s collecting result: a value only when nothing was reported (a read is all-or-nothing, matching `facade/tree.ts`'s own `validate`). */
export interface JsonParseResult {
  readonly value?: JsonValue;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * {@link parseJson}, collecting every §3.1 duplicate-member problem in one pass rather than
 * stopping at the first — a base-syntax failure (malformed UTF-8, a bad token, a grammar
 * violation) or a resource-limit refusal still throws, since everything past either point is
 * unreachable by construction and there is nothing further to collect (the same posture
 * `facade/tree.ts`'s own `validate` takes for the TSON text encoding).
 */
export function parseJsonCollecting(
  source: Uint8Array | string,
  options?: NestingLimitOptions,
): JsonParseResult {
  const events = createJsonStream(inputOf(source), options);
  const problems = collector();
  const value = runSync(readJsonDocument(events, problems));
  return problems.diagnostics.length === 0
    ? { value, diagnostics: problems.diagnostics }
    : { diagnostics: problems.diagnostics };
}

// ---------------------------------------------------------------------------------------------
// The schema-directed layer (WP4B, [TSON-JSON] §4–§8): compiling a `LinkedSchema` to a reader per
// entry, and reading a JSON document against one into a `JsonValue` tree. See `json/schema/compile.ts`'s
// own top note for exactly which positions this package reads (and which — dispatch: an ABSTRACT
// or member-dispatched record, an untagged choice, a scoped position, the annotation object itself
// — are WP4C's, reported as `NOT_IMPLEMENTED` rather than silently skipped).
// ---------------------------------------------------------------------------------------------

export type { JsonCompiledSchema, JsonTypeReader } from './schema/compile.js';
export { compileJsonSchema } from './schema/compile.js';

export type { ReadJsonOptions, ValidateJsonResult } from './facade.js';
export { readJsonTree, readJsonTreeAsync, validateJson, validateJsonAsync } from './facade.js';
