/**
 * How schema vocabulary is spelled as data -- the one place that knows what a reference and a type written in
 * place look like in a binding record, and the vocabulary's member names a binding record writes.
 *
 * **Why one module.** A binding record is written by two phases -- `desugar.ts` rewriting a sugar form into
 * the construction it denotes, and `constructionRewrite.ts` spelling an applied constructor's arguments -- and
 * read by the resolver. A second opinion about what a reference looks like in a slot is what makes one of them
 * wrong.
 *
 * **Nothing here is canonical output.** What is written here is what an author would have written -- an
 * unquoted token where a canonical writer would quote, and nothing at all where the constructor's own default
 * says it.
 */
import type {
  Annotation,
  CoreValue,
  DataValue,
  RecordField,
  RecordValue,
  TokenValue,
} from '../ast/value.js';
import type { TokenForm } from '../lexer/token.js';
import type { FieldGroup } from '../schema/meta/bodies.js';
import { metaName } from '../schema/meta/kernel.js';
import type { TypeRef } from '../schema/meta/typedef.js';
import { referenceToWire } from '../schema/referenceAtoms.js';
import { isIdentifierText } from '../unicode/identifier-profile.js';

// ── The vocabulary's own member names ────────────────────────────────────────────────────────

/** `meta.record_field.value`: §8.1's literal channel. */
export const VALUE = 'value';

/** `meta.record`: the constructor a parametric record applies. */
export const RECORD = metaName('record');

/** `meta.apply`: the construction an application is (§5.10). */
export const APPLY = metaName('apply');

export const FIELDS = 'fields';
export const GROUPS = 'groups';
export const MEMBERS = 'members';
export const TYPE = 'type';
export const OPTIONAL_MEMBERS = 'optional_members';
export const CHAIN = 'chain';
export const PARAMETERS = 'parameters';
export const NAME = 'name';
export const HEAD = 'head';
export const ARGUMENTS = 'arguments';
/** `record.name_type` -- written exactly where the record states one. */
export const NAME_TYPE = 'name_type';
export const OPTIONAL = 'optional';
export const VOIDABLE = 'voidable';
export const ROLE = 'role';
export const EXTENSION = 'extension';
export const DISCRIMINATORS = 'discriminators';
/** `meta.type_inline.of`: the construction a type written in place holds, tagged with its constructor. */
export const OF = 'of';

// ── Building blocks ──────────────────────────────────────────────────────────────────────────

/** A raw token in the wire's own unquoted-by-default spelling — quoted only where the caller says so. */
export function tokenValue(text: string, form: TokenForm = 'unquoted'): TokenValue {
  return { kind: 'token', text, form };
}

/**
 * A bare value in a field or element position — no annotations and no type-ref of its own — or, given
 * annotations, the same value carrying the annotations written on the construct it stands for.
 */
export function scoped(value: CoreValue, annotations: readonly Annotation[] = []): DataValue {
  return { annotations, coreValue: value };
}

export function nameField(name: string, text: string): RecordField {
  return { name, value: scoped(tokenValue(text)) };
}

/** The same value carrying a rewritten core value — annotations and type-ref kept as written. */
export function rescope(original: DataValue, rewritten: CoreValue): DataValue {
  return { ...original, coreValue: rewritten };
}

/**
 * A declared field name as a `field_map` key writes it: unquoted where it is an identifier, and single-line
 * quoted otherwise (`"@id"`, `"first name"`), or the text would not parse back (§12.1: a declared field name
 * is any single-line token).
 */
export function declaredName(name: string): DataValue {
  return {
    annotations: [],
    coreValue: tokenValue(name, isIdentifierText(name) ? 'unquoted' : 'single-line'),
  };
}

/** A list of names as the array of quoted text a binding record writes. */
function namesValue(names: readonly string[]): CoreValue {
  return {
    kind: 'array',
    elements: names.map((name) => scoped(tokenValue(name, 'single-line'))),
  };
}

/**
 * A `field_group` as a binding record writes it (§5.11): `optional_members` only where it names a member, and
 * `optional` only where it is set.
 */
export function groupValue(group: FieldGroup, annotations: readonly Annotation[] = []): DataValue {
  const members: RecordField[] = [
    {
      name: MEMBERS,
      value: scoped({
        kind: 'array',
        elements: group.members.map((option) => scoped(namesValue(option))),
      }),
    },
  ];
  if (group.optionalMembers !== undefined && group.optionalMembers.length > 0) {
    members.push({ name: OPTIONAL_MEMBERS, value: scoped(namesValue(group.optionalMembers)) });
  }
  if (group.optional) {
    members.push(nameField(OPTIONAL, 'true'));
  }
  return scoped({ kind: 'record', fields: members }, annotations);
}

/** A reference in the wire spelling: its name, one token. */
export function refValue(ref: TypeRef): CoreValue {
  return referenceToWire(ref);
}

/** One field of a wire `RecordValue`, by name — `undefined` when absent. */
export function field(record: RecordValue, name: string): CoreValue | undefined {
  return record.fields.find((f) => f.name === name)?.value.coreValue;
}

/** One field of a wire `RecordValue` as the data value written, by name — `undefined` when absent. */
export function member(record: RecordValue, name: string): DataValue | undefined {
  return record.fields.find((f) => f.name === name)?.value;
}
