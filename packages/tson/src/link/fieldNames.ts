/**
 * A record's field names are values of its `name_type` (Part 2 §5.2, §7.7), judged when the schema
 * links: the schema grammar admits any single-line token at a field name (§12.1), so what a field
 * name may be is decided here, never by the parser.
 *
 * This module judges the default: a record that neither states a `name_type` nor composes a
 * record stating one has the series' identifier as its name type, so each of its names is an
 * identifier, refused as a resolver error where it is not (§8.1). A record whose name type is
 * stated, its own or a supertype's, is left to the name-type judgement, which reads that type's
 * profile and form. That supertypes agree on one name type is the resolver's rule (§5.8),
 * judged where the composition is resolved.
 */
import { isIdentifierText } from '../unicode/identifier-profile.js';
import { isTemplateBody, supertypesOf, type Top } from '../schema/meta/typedef.js';

/** Whether `value` is a record stating its own `name_type`. */
function statesNameType(value: Top | undefined): boolean {
  return (
    value !== undefined &&
    !isTemplateBody(value) &&
    value.kind === 'record' &&
    value.nameType !== undefined
  );
}

/** One field name its record's name type does not admit, and the entry declaring it. */
export interface FieldNameViolation {
  readonly entry: string;
  readonly message: string;
}

/** Every local record's field names that its (default) name type refuses, in declaration order. */
export function checkDefaultFieldNames(
  merged: ReadonlyMap<string, Top>,
  localNames: ReadonlySet<string>,
): readonly FieldNameViolation[] {
  const violations: FieldNameViolation[] = [];
  for (const name of localNames) {
    const value = merged.get(name);
    if (value === undefined || isTemplateBody(value) || value.kind !== 'record') continue;
    if (value.nameType !== undefined) continue;
    // A composition takes its supertypes' one name type (§5.8), which the resolver states on the
    // body; one reached through an operand it does not state it from is still the record's.
    if (supertypesOf(value).some((supertype) => statesNameType(merged.get(supertype)))) continue;
    for (const fieldName of value.fields.entries.keys()) {
      if (isIdentifierText(fieldName)) continue;
      violations.push({
        entry: name,
        message:
          `'${name}': field name '${fieldName}' is not an identifier, and a record that states no ` +
          "'name_type' names its fields with the series' identifier (§5.2, §7.7): a name starts " +
          "with an XID_Start character and continues with XID_Continue or '-', in NFC. State a " +
          "'name_type' admitting it, or key the values by a map ('key => value')",
      });
      break;
    }
  }
  return violations;
}
