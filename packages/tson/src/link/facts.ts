/**
 * Reading an entry's facts (Part 2 §8.1's `EntryFacts`) where a `link/` check reports against it:
 * the facts sit beside the schema map, never on an entry's value, so every check that names a
 * position takes them as a table.
 */
import type { EntryFacts, Top } from '../schema/meta/typedef.js';
import { isTemplateBody } from '../schema/meta/typedef.js';

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

/**
 * What a diagnostic calls the entry `name`: the author's own name wherever they declared one, and
 * otherwise the form they wrote -- `kind<record>`, `ref<order>` -- since an inline kind or reference
 * lifts to an entry named for its content (§8.2), a name that appears nowhere in the author's file
 * and is not normative. An entry with no source position is one the resolver minted.
 */
export function spellingOf(
  name: string,
  value: Top | undefined,
  facts: FactsTable | undefined,
): string {
  if (value === undefined || isTemplateBody(value) || facts?.get(name)?.position !== undefined) {
    return name;
  }
  if (value.kind === 'kind_type') return `kind<${value.of}>`;
  if (value.kind === 'ref_type') return `ref<${value.of}>`;
  return name;
}
