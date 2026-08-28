/**
 * Reads an async byte source to completion, refusing it the moment more than a configured cap
 * has been delivered — shared by {@link fileSchemaSource}'s own local-file read.
 * {@link httpSchemaSource} keeps its own copy rather than this one: a fetch response's stream
 * needs an explicit `body.cancel()` on overflow to release the connection, which a local file
 * read (cleaned up by the async iterator protocol's own `return()` the moment a `for await` exits
 * early) does not.
 */
import { TsonSchemaFetchError } from '../core/errors.js';

/** Accumulates `chunks` into one `Uint8Array`, throwing {@link TsonSchemaFetchError} with reason `'too-large'` the instant the running total exceeds `maxDocumentBytes` — checked against bytes actually delivered, never a size the source merely claims in advance. */
export async function readCapped(
  reference: string,
  chunks: AsyncIterable<Uint8Array>,
  maxDocumentBytes: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    total += chunk.length;
    if (total > maxDocumentBytes) {
      throw new TsonSchemaFetchError(
        reference,
        'too-large',
        `cannot fetch schema '${reference}': a schema document may be at most ${String(maxDocumentBytes)} bytes`,
      );
    }
    parts.push(chunk);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
