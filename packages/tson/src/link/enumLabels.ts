/**
 * What an enum's `type` obliges ([TSON-SCHEMA] §7.4): that it names a text family, that each member
 * is a value of it, and that no two members are one value under its equality -- and, because the
 * answer lives in a namespace the body cannot see, where `type` resolves at all.
 *
 * **Why the linker and not the body.** `EnumBody` holds `type` as a name, and what the name denotes
 * -- which family, which parser, which equality -- lives in a namespace the body cannot see: the
 * schema's own, where an author-written `type` resolves, or the governing meta's, where a value the
 * constructor pinned (`enum`'s `type: identifier`) was written. The linked closure is the first
 * place both are present.
 *
 * **Where `type` resolves.** A value `type` takes from a constructor resolves where that
 * constructor is declared: `!enum [A B]` names the kernel's `identifier` whatever the schema
 * declares or imports. An author-written `type` resolves in the schema's own namespace, so a
 * schema may enumerate labels of a naming vocabulary it declares itself -- and a schema's own
 * `identifier` does not retype `!enum`.
 *
 * **A text family is an atom-family instance whose constructor IS-A `text_type`**: `text_type`
 * itself and the families that compose it (`identifier_type`, `regex_type`, `uri_type`,
 * `iri_type`, `email_type`). An enum's members are texts under a naming vocabulary's equality; a
 * value set on any other family is that family's own `members` facet.
 */
import { atomParserFor } from '../atom/forType.js';
import { TsonAtomParseError, TsonAtomValidationError } from '../core/errors.js';
import { isHeldBody } from '../compiler/heldBody.js';
import type { Normalization } from '../schema/meta/atoms-text.js';
import type { EnumBody } from '../schema/meta/bodies.js';
import type { Top, TypeDefinition } from '../schema/meta/typedef.js';
import { isTemplateBody } from '../schema/meta/typedef.js';
import { identifierProfileOf, type IdentifierProfile } from '../unicode/identifier-profile.js';
import { nfcFloor } from '../unicode/normalization.js';
import { isDataBody } from './bodyKind.js';
import { terminal } from './referenceChain.js';

/** Looks an entry up by name; `undefined` for a name that resolves nowhere. */
export type EntryGetter = (name: string) => TypeDefinition | undefined;

/** An enum's label type: its definition, and the namespace the definition's own names resolve in. */
export interface EnumLabel {
  /** The terminal entry's name. */
  readonly name: string;
  readonly definition: TypeDefinition;
  readonly lookup: EntryGetter;
}

function enumBodyOf(definition: TypeDefinition): EnumBody | undefined {
  const body = definition.body;
  return 'kind' in body && !isDataBody(body) && body.kind === 'enum' ? body : undefined;
}

/**
 * `enumeration`'s label type, given the schema's own namespace and the governing meta's (`structure`,
 * absent for the meta-kernel bootstrap). `undefined` for a body that is not an enum and for a `type`
 * that resolves in neither.
 */
export function enumLabelType(
  enumeration: TypeDefinition,
  local: EntryGetter,
  structure: EntryGetter | undefined,
): EnumLabel | undefined {
  const body = enumBodyOf(enumeration);
  if (body === undefined) return undefined;
  const both: EntryGetter = (name) => local(name) ?? structure?.(name);
  if (
    structure !== undefined &&
    pinned(enumeration, body, both) &&
    structure(body.type) !== undefined
  ) {
    const name = terminal(body.type, structure);
    const definition = structure(name);
    return definition === undefined ? undefined : { name, definition, lookup: structure };
  }
  if (local(body.type) !== undefined) {
    const name = terminal(body.type, local);
    const definition = local(name);
    return definition === undefined ? undefined : { name, definition, lookup: both };
  }
  return undefined;
}

/**
 * Whether `body.type` is the value `enumeration`'s constructor pins -- found through its `source`,
 * through a template's held body to the constructor it applies (an entry instantiating `names =>
 * <M> !enum [a b M]` records the template as its source and not `enum`), and through an enum entry
 * it refines to the constructor that entry applied.
 */
function pinned(enumeration: TypeDefinition, body: EnumBody, lookup: EntryGetter): boolean {
  let head = enumeration.source?.name;
  const seen = new Set<string>();
  while (head !== undefined && !seen.has(head)) {
    seen.add(head);
    const constructor = lookup(head);
    if (constructor === undefined) return false;
    const held: Top = constructor.body;
    if (isTemplateBody(held)) {
      head = isHeldBody(held) ? held.application.typeRef : undefined;
      continue;
    }
    if (!('kind' in held) || isDataBody(held)) return false;
    if (held.kind === 'enum') {
      head = constructor.source?.name;
      continue;
    }
    return (
      held.kind === 'record' &&
      held.fields.some(
        (field) =>
          field.name === 'type' && field.role === 'FIXED' && field.value?.text === body.type,
      )
    );
  }
  return false;
}

/** The families whose constructor IS-A `text_type` (§5.5, §9). */
const TEXT_FAMILIES: ReadonlySet<string> = new Set([
  'text_type',
  'identifier_type',
  'regex_type',
  'uri_type',
  'iri_type',
  'email_type',
]);

/** The kind of the atom body `definition` holds, or `undefined` for a held template, a Data body or a non-atom. */
function bodyKindOf(definition: TypeDefinition): string | undefined {
  const body = definition.body;
  return 'kind' in body && !isDataBody(body) ? body.kind : undefined;
}

/**
 * Whether `enumeration`'s members are names: its `type` is an identifier family. A type that
 * resolves to nothing is taken to have names, the stricter reading -- the unresolved name is
 * reported on its own -- so every per-name rule still applies.
 */
export function membersAreNames(
  enumeration: TypeDefinition,
  local: EntryGetter,
  structure: EntryGetter | undefined,
): boolean {
  if (enumBodyOf(enumeration) === undefined) return false;
  const label = enumLabelType(enumeration, local, structure);
  return label === undefined ? true : bodyKindOf(label.definition) === 'identifier_type';
}

/**
 * The form `enumeration` matches its members in: its label type's `normalization` ([TSON-SCHEMA]
 * §5.5), followed into the governing meta where the enum's constructor pinned the type. `NONE` for
 * a body that is not an enum, a type that resolves to nothing, or one that is not a text family --
 * each refused or reported on its own.
 */
export function enumLabelForm(
  enumeration: TypeDefinition,
  local: EntryGetter,
  structure: EntryGetter | undefined,
): Normalization {
  const label = enumLabelType(enumeration, local, structure);
  if (label === undefined) return 'NONE';
  const body = label.definition.body;
  if (!('kind' in body) || isDataBody(body)) return 'NONE';
  switch (body.kind) {
    case 'text_type':
    case 'identifier_type':
    case 'regex_type':
    case 'uri_type':
    case 'iri_type':
    case 'email_type':
      return body.normalization;
    default:
      return 'NONE';
  }
}

/** The profile an enum's members are judged under, and the form they are put into first. */
export interface EnumLabelProfile {
  readonly profile: IdentifierProfile;
  readonly form: Normalization;
}

/**
 * The identifier profile `enumeration`'s members are judged under, with the form they are put into:
 * its label type's own (§7.4 -- each member "is a value of" `type`, so a profile's own additions
 * are exempt for a member as they are for a value at a position typed by it). `undefined` unless
 * the label type is an identifier family.
 */
export function enumLabelProfile(
  enumeration: TypeDefinition,
  local: EntryGetter,
  structure: EntryGetter | undefined,
): EnumLabelProfile | undefined {
  const label = enumLabelType(enumeration, local, structure);
  const body = label?.definition.body;
  if (body === undefined || !('kind' in body) || isDataBody(body)) return undefined;
  if (body.kind !== 'identifier_type') return undefined;
  return { profile: identifierProfileOf(body), form: body.normalization };
}

/** One problem, and the entry it is reported against -- always one this schema declares. */
export interface EnumLabelViolation {
  readonly entry: string;
  readonly message: string;
}

/**
 * Every enum among `localNames` whose `type` is not a text family, whose members are not all values
 * of it, or two of whose members are one value under its equality -- the first problem of each
 * enum, in `localNames`' order.
 */
export function checkEnumLabels(
  merged: ReadonlyMap<string, TypeDefinition>,
  localNames: Iterable<string>,
  structure: EntryGetter | undefined,
): EnumLabelViolation[] {
  const violations: EnumLabelViolation[] = [];
  const local: EntryGetter = (name) => merged.get(name);
  for (const name of localNames) {
    const definition = merged.get(name);
    const body = definition === undefined ? undefined : enumBodyOf(definition);
    if (definition === undefined || body === undefined) continue;
    const message = checkEnum(name, definition, body, local, structure);
    if (message !== undefined) violations.push({ entry: name, message });
  }
  return violations;
}

function checkEnum(
  name: string,
  definition: TypeDefinition,
  body: EnumBody,
  local: EntryGetter,
  structure: EntryGetter | undefined,
): string | undefined {
  const label = enumLabelType(definition, local, structure);
  if (label === undefined) {
    return `'${name}': its type '${body.type}' names nothing in scope (§7.4)`;
  }
  const kind = bodyKindOf(label.definition);
  if (kind === undefined || !TEXT_FAMILIES.has(kind)) {
    return (
      `'${name}': its type '${body.type}' is not a text family -- an enum's labels are drawn ` +
      'from an atom-family instance whose constructor IS-A text_type (§7.4). A value set on ' +
      "another family is that family's own 'members' facet: '!integer ^ { members: [80 443] }', " +
      'not an enum'
    );
  }
  const labelBody = label.definition.body;
  if (!('kind' in labelBody) || isDataBody(labelBody)) return undefined;
  const parser = atomParserFor(label.name, labelBody);
  if (parser === undefined) return undefined; // a text family with no parser: nothing to judge by
  const names = kind === 'identifier_type';
  const seen = new Map<string, string>();
  for (const member of body.members) {
    let value: unknown;
    try {
      value = parser.read({ text: member, form: 'single-line' });
    } catch (error) {
      if (!(error instanceof TsonAtomParseError || error instanceof TsonAtomValidationError)) {
        throw error;
      }
      return (
        `'${name}': member '${member}' is not a value of its type '${body.type}': ` +
        error.message +
        (names ? " -- members that are any text are a '!text_enum [...]'" : '')
      );
    }
    // Text values are one when they are NFC-equal, each in its type's form (§5.5).
    const identity = nfcFloor(typeof value === 'string' ? value : member);
    const earlier = seen.get(identity);
    if (earlier !== undefined) {
      return (
        `'${name}': members '${earlier}' and '${member}' are one value of its type ` +
        `'${body.type}' (§7.4)`
      );
    }
    seen.set(identity, member);
  }
  return undefined;
}
