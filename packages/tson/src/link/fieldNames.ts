/**
 * What a record's `name_type` obliges ([TSON-SCHEMA] §5.2), judged when the schema links: that it
 * names an identifier family whose form implies NFC (`nameType.ts`), that every field name the
 * record states -- in `fields`, `discriminators` and its groups -- is a value of it, and that no
 * two of its fields are one value under its equality. The peer of `enumLabels.ts`, on the same
 * terms: a checker over the linked closure that hands back violations and leaves reporting to the
 * linker.
 *
 * **The schema grammar admits any single-line token at a field name** (§12.1), so what a field
 * name may be is decided here and never by the parser: a brace-form `{ "first name": text }` under
 * the default is a resolver error, not a parse error.
 *
 * **Two fields of one spelling never reach here.** `record.fields` is a map keyed by the name, so
 * a name written twice is the map's duplicate key, refused where the record is read or resolved.
 * What is left for this check is two spellings that are one name under the type's equality --
 * `NAME` and `name` under a case-folding type -- which only a resolved name type can decide.
 *
 * **A schema's own references match exactly** (§5.2): a `discriminators` entry and a group's
 * member name a declared field by its declared spelling, which the resolver has already held them
 * to, so here each is only judged a value of the name type.
 */
import { atomParserFor } from '../atom/forType.js';
import { TsonAtomParseError, TsonAtomValidationError } from '../core/errors.js';
import type { IdentifierType, Normalization } from '../schema/meta/atoms-text.js';
import type { RecordBody } from '../schema/meta/bodies.js';
import type { Top } from '../schema/meta/typedef.js';
import { isTemplateBody } from '../schema/meta/typedef.js';
import { isIdentifierText } from '../unicode/identifier-profile.js';
import {
  isIdentifierFamily,
  isKernelIdentifier,
  nameTypeFormRefusal,
  recordNameType,
} from './nameType.js';
import type { EntryLookup } from './referenceChain.js';

/** One field name its record's name type does not admit, and the entry declaring it. */
export interface FieldNameViolation {
  readonly entry: string;
  readonly message: string;
}

/**
 * A record's name type where it is not the kernel's default, as a reader judges a document's field
 * names by it (§5.2, §7.7): the name the record states, and the identifier family it resolves to.
 */
export interface FieldNameType {
  readonly typeName: string;
  readonly definition: IdentifierType;
}

/** What {@link checkFieldNameTypes} found over one schema's records. */
export interface FieldNameTypes {
  /** Every violation, in the records' declaration order -- at most one per record. */
  readonly violations: readonly FieldNameViolation[];
  /** Each record whose name type is stated and judged sound, by name. */
  readonly nameTypes: ReadonlyMap<string, FieldNameType>;
}

function recordOf(value: Top | undefined): RecordBody | undefined {
  return value !== undefined && !isTemplateBody(value) && value.kind === 'record'
    ? value
    : undefined;
}

/**
 * Every local record's field names judged by its name type, and the name types a reader needs for
 * the records that state one (§5.2). `structure` is the governing meta's namespace, absent for the
 * meta-kernel bootstrap.
 */
export function checkFieldNameTypes(
  merged: ReadonlyMap<string, Top>,
  localNames: Iterable<string>,
  structure: EntryLookup | undefined,
): FieldNameTypes {
  const violations: FieldNameViolation[] = [];
  const nameTypes = new Map<string, FieldNameType>();
  const local: EntryLookup = (name) => merged.get(name);
  for (const name of localNames) {
    const body = recordOf(merged.get(name));
    if (body === undefined) continue;
    const outcome = check(name, body, local, structure);
    if (typeof outcome === 'string') {
      violations.push({ entry: name, message: outcome });
    } else if (outcome !== undefined && body.nameType !== undefined) {
      nameTypes.set(name, { typeName: body.nameType, definition: outcome });
    }
  }
  return { violations, nameTypes };
}

/** The violation, or the name type `body` was judged under (`undefined` where none resolves to judge by). */
function check(
  name: string,
  body: RecordBody,
  local: EntryLookup,
  structure: EntryLookup | undefined,
): string | IdentifierType | undefined {
  const resolved = recordNameType(body, local, structure);
  const stated = body.nameType;
  if (resolved === undefined && stated === undefined) {
    // The default where no kernel is in scope to resolve it: the identifier grammar it stands for.
    for (const field of body.fields.entries.keys()) {
      if (!isIdentifierText(field)) return notAnIdentifier(name, field);
    }
    return undefined;
  }
  if (resolved === undefined) {
    return `'${name}': its name_type '${stated ?? ''}' names nothing in scope (§5.2)`;
  }
  if (!isIdentifierFamily(resolved)) {
    return (
      `'${name}': its name_type '${stated ?? ''}' is not an identifier family -- a record's ` +
      'field names are names drawn from an atom-family instance whose constructor IS-A ' +
      "identifier_type (§5.2, §7.4); a key that is no name belongs in a map ('key => value')"
    );
  }
  const form = nameTypeFormRefusal(resolved.definition);
  if (form !== undefined) {
    return `'${name}': its name_type '${stated ?? ''}' cannot judge names -- ${form} (§5.2)`;
  }
  const parser = atomParserFor(resolved.name, resolved.definition);
  if (parser === undefined) return resolved.definition;
  // Under the default a refusal speaks of identifiers as any name's would; only an author's own
  // name type is named, since its rules are the ones the author has to look up.
  const identifier = isKernelIdentifier(resolved, structure);
  const ofType = identifier ? 'an identifier' : `a value of its name_type '${stated ?? ''}'`;
  const read = (fieldName: string): { value: string } | { refusal: string } => {
    try {
      const value = parser.read({ text: fieldName, form: 'single-line' });
      return { value: typeof value === 'string' ? value : fieldName };
    } catch (error) {
      if (!(error instanceof TsonAtomParseError || error instanceof TsonAtomValidationError)) {
        throw error;
      }
      return identifier && stated === undefined
        ? { refusal: notAnIdentifier(name, fieldName) }
        : { refusal: `'${name}': field name '${fieldName}' is not ${ofType}: ${error.message}` };
    }
  };
  const seen = new Map<string, string>();
  for (const fieldName of body.fields.entries.keys()) {
    const outcome = read(fieldName);
    if ('refusal' in outcome) return outcome.refusal;
    const earlier = seen.get(outcome.value);
    if (earlier !== undefined) {
      return (
        `'${name}': fields '${earlier}' and '${fieldName}' are one ` +
        (identifier ? 'field name' : `value of its name_type '${stated ?? ''}'`) +
        ' -- a record states each of its fields once under its name type (§5.2, §5.5)'
      );
    }
    seen.set(outcome.value, fieldName);
  }
  const referenced = new Set<string>(body.discriminators ?? []);
  for (const group of body.groups) {
    for (const option of group.members) for (const member of option) referenced.add(member);
    for (const member of group.optionalMembers ?? []) referenced.add(member);
  }
  for (const reference of referenced) {
    const outcome = read(reference);
    if ('refusal' in outcome) return outcome.refusal;
  }
  return resolved.definition;
}

function notAnIdentifier(name: string, fieldName: string): string {
  return (
    `'${name}': field name '${fieldName}' is not an identifier, and a record that states no ` +
    "'name_type' names its fields with the series' identifier (§5.2, §7.7): a name starts " +
    "with an XID_Start character and continues with XID_Continue or '-', in NFC. State a " +
    "'name_type' admitting it, or key the values by a map ('key => value')"
  );
}

/** The form a record's field names are matched in: its name type's `normalization` (§5.2, §7.7), NFC by default. */
export function fieldNameForm(nameType: FieldNameType | undefined): Normalization {
  return nameType === undefined ? 'NFC' : nameType.definition.normalization;
}
