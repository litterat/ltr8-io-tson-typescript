/**
 * Reading an entry's facts (Part 2 §8.1's `EntryFacts`) where a `link/` check reports against it:
 * the facts sit beside the schema map, never on an entry's value, so every check that names a
 * position takes them as a table.
 */
import type { EntryFacts } from '../schema/meta/typedef.js';

/** The facts a linked schema records, by entry name. */
export type FactsTable = ReadonlyMap<string, EntryFacts>;

/** `name`'s source position for a diagnostic, spread into one where its facts record it. */
export function schemaPositionOf(
  facts: FactsTable | undefined,
  name: string,
): { readonly schemaPosition?: NonNullable<EntryFacts['position']> } {
  const position = facts?.get(name)?.position;
  return position === undefined ? {} : { schemaPosition: position };
}
