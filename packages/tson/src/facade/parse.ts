/**
 * `parse` -- Class 1 syntactic parsing (§2, §7.4): the whole `ast/value.ts` {@link Document} tree,
 * with no schema consulted and none needed. The front door's thinnest layer, over
 * `compiler/dataParser.ts`'s own `parseDocument` -- itself schema-free (it depends on nothing past
 * `ast/`, `stream/`, `core/` and `io/`), which is what lets this module's own import graph stay
 * clear of the schema compiler entirely: **anyone who imports `parse` does not pay for it**, the
 * property `CLAUDE.md`'s work-package brief states outright. A caller wanting the compiler-backed,
 * queryable value tree instead reaches for `readTree`/`validate`.
 */
import type { ByteInput, Task } from '../io/bytes.js';
import { parseDocument, type ParsedDocument } from '../compiler/dataParser.js';
import {
  type AsyncByteSource,
  type ByteSource,
  runOverAsyncSource,
  runOverBytes,
} from './byteSource.js';

export type { ParsedDocument } from '../compiler/dataParser.js';

function parseTask(input: ByteInput): Task<ParsedDocument> {
  return parseDocument(input);
}

/**
 * Parses `source` into a {@link ParsedDocument} -- `document` is the parse-preserving AST (§2,
 * §7.4), `positions` is every {@link CoreValue}'s own start position, keyed by reference identity.
 *
 * Synchronous for a complete `Uint8Array`; a streaming `source` (a web `ReadableStream` or any
 * other `AsyncIterable<Uint8Array>`) returns a `Promise` instead, resolving as bytes arrive
 * rather than after buffering the whole document (`CLAUDE.md`: "memory is proportional to
 * nesting depth").
 */
export function parse(source: Uint8Array): ParsedDocument;
export function parse(source: AsyncByteSource): Promise<ParsedDocument>;
export function parse(source: ByteSource): ParsedDocument | Promise<ParsedDocument> {
  if (source instanceof Uint8Array) {
    return runOverBytes(source, parseTask);
  }
  return runOverAsyncSource(source, parseTask);
}
