/**
 * The name type a record's *body* states, for a record that is no entry: one written in place at a
 * type slot, or an application closed where it stands ([TSON-SCHEMA] §4.2, §5.2).
 *
 * `LinkedSchema.nameTypes` is keyed by entry name, and a record in place has none, so a reader that
 * asked it would take the kernel's `meta.identifier` for a record that states its own `name_type`.
 * The record's own body answers instead: the name type it states, resolved in the schema's merged
 * namespace as the linker resolved it when it judged the record's field names (`fieldNames.ts`'s
 * `check`), so the reader's rule is the one the declared names were held to. Shared by both
 * encodings' readers, like the rule it feeds (`fieldNameRule.ts`).
 */
import type { RecordBody } from '../schema/meta/bodies.js';
import type { Top } from '../schema/meta/typedef.js';
import type { FieldNameType } from './fieldNames.js';
import { isIdentifierFamily, recordNameType } from './nameType.js';

/**
 * The name type `body` states and linking judged sound, or `undefined` where it states none -- the
 * kernel's default -- or names nothing an identifier family (a schema that links refuses the
 * latter, so a reader never meets it).
 */
export function bodyNameType(
  body: Pick<RecordBody, 'nameType'>,
  entries: ReadonlyMap<string, Top>,
): FieldNameType | undefined {
  if (body.nameType === undefined) return undefined;
  const lookup = (name: string): Top | undefined => entries.get(name);
  const resolved = recordNameType(body, lookup, lookup);
  if (resolved === undefined || !isIdentifierFamily(resolved)) return undefined;
  return { typeName: body.nameType, definition: resolved.definition };
}
