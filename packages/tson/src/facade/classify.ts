/**
 * `classifyDocument` -- data document or schema document, from a document's opening bytes.
 *
 * [TSON-DATA] §2.2 makes this a property of the document itself, not of the file extension: "a
 * parser consumes the `!!id` directive if present and every `!!import` directive that follows; it
 * then reads the root value's leading annotations and its type annotation. If that type
 * annotation is `!schema`, the document is a schema document ... Classification reads the header,
 * the root's leading annotations and its tag, and never the root's value." §7.1 names the
 * consumers that need exactly that -- "streams, previews, and content sniffers can classify a
 * document from its opening bytes".
 *
 * **This is that function, and it really does stop.** It reads the header, the root's leading
 * annotations (whose values it parses, to find where they end) and the root's tag, and then
 * returns; it never enters the root's core value, so classifying a gigabyte document costs the
 * same as classifying a two-line one, and a document whose *body* is malformed still classifies --
 * a schema map's own sugar is no data grammar and is never read. That is the whole reason for it
 * to exist separately from `parse`, which would have to read the value to find out something the
 * root's tag already said.
 *
 * **The header itself is judged in full**, because a sniffer that guesses is worse than one that
 * refuses: the header is one grammar for every document (§2.2, §3.3), read by the event stream
 * every other reader sits on. `!!` must be adjacent to its directive name (§7.5), the `:` must
 * follow the name immediately, the argument must be a single-line quoted token naming an
 * IRI-reference, a retired `!!meta`/`!!schema` is refused naming `!!import`, and so on. A
 * malformed header raises `TsonLexError`/`TsonParseError` exactly as parsing would.
 */
import { TsonInternalError } from '../core/errors.js';
import type { ByteInput, Task } from '../io/bytes.js';
import { createDataStream } from '../stream/dataStream.js';
import { isSchemaTag } from '../stream/event.js';
import {
  runOverAsyncSource,
  runOverBytes,
  type AsyncByteSource,
  type ByteSource,
} from './byteSource.js';

/** Which of §2.2's two document kinds a root declares. */
export type DocumentKind = 'data' | 'schema';

/** What {@link classifyDocument} could tell from a document's header and its root's tag alone. */
export interface DocumentClassification {
  readonly kind: DocumentKind;
  /**
   * The `!!id` directive's argument, when the header carries one. Uninterpreted: not canonicalised
   * (`@ltr8/tson/identity`'s `canonicalizeIdentity` does that).
   */
  readonly id?: string;
  /** The `!!import` directives' arguments, in header order; empty when there are none. Uninterpreted. */
  readonly imports: readonly string[];
}

function* classifyTask(input: ByteInput): Task<DocumentClassification> {
  const source = createDataStream(input);
  const start = yield* source.next();
  if (start.kind !== 'document-start') {
    throw new TsonInternalError(`expected document-start, got '${start.kind}'`);
  }
  const tag = yield* source.rootTag();
  return {
    kind: isSchemaTag(tag) ? 'schema' : 'data',
    ...(start.id === undefined ? {} : { id: start.id }),
    imports: start.imports,
  };
}

/**
 * Classifies `source` as a data or schema document from its header and its root's tag alone
 * (§2.2), never reading the root's value.
 *
 * Synchronous for a complete `Uint8Array`; a streaming `source` (a web `ReadableStream` or any
 * other `AsyncIterable<Uint8Array>`) returns a `Promise` instead, and consumes only the chunks the
 * header and the root's tag need -- which is what lets a caller classify an incoming stream before
 * deciding what to do with the rest of it.
 *
 * @throws TsonLexError | TsonParseError if the header or the root's annotations are malformed. A
 *   malformed *body* is not an error here: it is never read.
 */
export function classifyDocument(source: Uint8Array): DocumentClassification;
export function classifyDocument(source: AsyncByteSource): Promise<DocumentClassification>;
export function classifyDocument(
  source: ByteSource,
): DocumentClassification | Promise<DocumentClassification> {
  return source instanceof Uint8Array
    ? runOverBytes(source, classifyTask)
    : runOverAsyncSource(source, classifyTask);
}
