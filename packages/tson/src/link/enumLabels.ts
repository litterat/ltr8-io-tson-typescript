/**
 * What an enum's `name_type` obliges ([TSON-SCHEMA] §7.4): that it names an identifier family -- a
 * member of `identifier_kind`, whose form implies NFC (`nameType.ts`'s `nameTypeFormRefusal`) --
 * that each member is a value of it, and that no two members are one value under its equality --
 * and, because the answer lives in a namespace the body cannot see, where `name_type` resolves at
 * all. `fieldNames.ts` holds a record's field names to the same three.
 *
 * **Why the linker and not the body.** `EnumBody` holds `nameType` as a name, and what the name
 * denotes -- which family, which parser, which equality -- lives in a namespace the body cannot
 * see: the schema's own, where an author-written `name_type` resolves, or the governing meta's,
 * where a value the constructor pinned (`enum`'s `name_type: identifier`) was written. The linked
 * closure is the first place both are present.
 *
 * **Where `name_type` resolves.** A value `name_type` takes from a constructor resolves where that
 * constructor is declared: `!enum [A B]` names the kernel's `identifier` whatever the schema
 * declares or imports. An author-written `name_type` resolves in the schema's own namespace, so a
 * schema may enumerate labels of a naming vocabulary it declares itself -- and a schema's own
 * `identifier` does not retype `!enum`. Which constructor an enum applied is its entry's `head`
 * fact, which the caller supplies with the value.
 *
 * **An identifier family is a type built with `identifier_type`**: an instance, a refinement of
 * one, an instantiation of a template over the constructor, and an alias of any of them. An enum's
 * members are names under a naming vocabulary's equality, and carry §8.2's per-name rules under its
 * profile; a closed set of values on any other family, `text` included, is that family's own
 * `members` facet.
 */
import { atomParserFor } from '../atom/forType.js';
import { TsonAtomParseError, TsonAtomValidationError } from '../core/errors.js';
import { isHeldBody } from '../compiler/heldBody.js';
import type { Normalization } from '../schema/meta/atoms-text.js';
import type { EnumBody } from '../schema/meta/bodies.js';
import type { Top } from '../schema/meta/typedef.js';
import { isTemplateBody } from '../schema/meta/typedef.js';
import { identifierProfileOf, type IdentifierProfile } from '../unicode/identifier-profile.js';
import { nfcFloor } from '../unicode/normalization.js';
import { nameTypeFormRefusal } from './nameType.js';
import { terminal } from './referenceChain.js';

/** Looks an entry up by name; `undefined` for a name that resolves nowhere. */
export type EntryGetter = (name: string) => Top | undefined;

/** Looks up the constructor an entry's value applies (its `head` fact), by name. */
export type HeadGetter = (name: string) => string | undefined;

/** An enum entry as these checks read it: its value, and the constructor its tag names. */
export interface EnumEntry {
  readonly value: Top;
  readonly head?: string;
}

/** An enum's label type: its definition, and the namespace the definition's own names resolve in. */
export interface EnumLabel {
  /** The terminal entry's name. */
  readonly name: string;
  readonly definition: Top;
  readonly lookup: EntryGetter;
}

function enumBodyOf(value: Top): EnumBody | undefined {
  return !isTemplateBody(value) && value.kind === 'enum' ? value : undefined;
}

/**
 * `enumeration`'s label type, given the schema's own namespace and the governing meta's (`structure`,
 * absent for the meta-kernel bootstrap). `undefined` for a body that is not an enum and for a `type`
 * that resolves in neither.
 */
export function enumLabelType(
  enumeration: EnumEntry,
  local: EntryGetter,
  structure: EntryGetter | undefined,
  heads: HeadGetter = () => undefined,
): EnumLabel | undefined {
  const body = enumBodyOf(enumeration.value);
  if (body === undefined) return undefined;
  const both: EntryGetter = (name) => local(name) ?? structure?.(name);
  if (
    structure !== undefined &&
    pinned(enumeration.head, body, both, heads) &&
    structure(body.nameType) !== undefined
  ) {
    const name = terminal(body.nameType, structure);
    const definition = structure(name);
    return definition === undefined ? undefined : { name, definition, lookup: structure };
  }
  if (local(body.nameType) !== undefined) {
    const name = terminal(body.nameType, local);
    const definition = local(name);
    return definition === undefined ? undefined : { name, definition, lookup: both };
  }
  return undefined;
}

/**
 * Whether `body.nameType` is the value the enum's constructor pins -- found through its `head`,
 * through a template's held body to the constructor it applies (an entry instantiating `names =>
 * <M> !enum [a b M]` records the template as its head and not `enum`), and through an enum entry
 * it refines to the constructor that entry applied.
 */
function pinned(
  first: string | undefined,
  body: EnumBody,
  lookup: EntryGetter,
  heads: HeadGetter,
): boolean {
  let head = first;
  const seen = new Set<string>();
  while (head !== undefined && !seen.has(head)) {
    seen.add(head);
    const constructor = lookup(head);
    if (constructor === undefined) return false;
    if (isTemplateBody(constructor)) {
      head = isHeldBody(constructor) ? constructor.application.typeRef : undefined;
      continue;
    }
    if (constructor.kind === 'enum') {
      head = heads(head);
      continue;
    }
    if (constructor.kind !== 'record') return false;
    const field = constructor.fields.entries.get('name_type');
    return field?.role === 'FIXED' && field.value?.text === body.nameType;
  }
  return false;
}

/** The kind of the atom body `definition` holds, or `undefined` for a held template or a namespace value. */
function bodyKindOf(definition: Top): string | undefined {
  return isTemplateBody(definition) || definition.kind === 'namespace'
    ? undefined
    : definition.kind;
}

/**
 * Whether `enumeration`'s members are names: its `type` is an identifier family. A type that
 * resolves to nothing is taken to have names, the stricter reading -- the unresolved name is
 * reported on its own -- so every per-name rule still applies.
 */
export function membersAreNames(
  enumeration: EnumEntry,
  local: EntryGetter,
  structure: EntryGetter | undefined,
  heads?: HeadGetter,
): boolean {
  if (enumBodyOf(enumeration.value) === undefined) return false;
  const label = enumLabelType(enumeration, local, structure, heads);
  return label === undefined ? true : bodyKindOf(label.definition) === 'identifier_type';
}

/**
 * The form `enumeration` matches its members in: its label type's `normalization` ([TSON-SCHEMA]
 * §5.5), followed into the governing meta where the enum's constructor pinned the type. `NONE` for
 * a body that is not an enum, a type that resolves to nothing, or one that is not a text family --
 * each refused or reported on its own.
 */
export function enumLabelForm(
  enumeration: EnumEntry,
  local: EntryGetter,
  structure: EntryGetter | undefined,
  heads?: HeadGetter,
): Normalization {
  const label = enumLabelType(enumeration, local, structure, heads);
  if (label === undefined) return 'NONE';
  const body = label.definition;
  if (isTemplateBody(body) || body.kind === 'namespace') return 'NONE';
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
  enumeration: EnumEntry,
  local: EntryGetter,
  structure: EntryGetter | undefined,
  heads?: HeadGetter,
): EnumLabelProfile | undefined {
  const label = enumLabelType(enumeration, local, structure, heads);
  const body = label?.definition;
  if (body === undefined || isTemplateBody(body) || body.kind === 'namespace') return undefined;
  if (body.kind !== 'identifier_type') return undefined;
  return { profile: identifierProfileOf(body), form: body.normalization };
}

/** One problem, and the entry it is reported against -- always one this schema declares. */
export interface EnumLabelViolation {
  readonly entry: string;
  readonly message: string;
}

/**
 * Every enum among `localNames` whose `name_type` is not an identifier family that can judge names,
 * whose members are not all values of it, or two of whose members are one value under its equality
 * -- the first problem of each enum, in `localNames`' order.
 */
export function checkEnumLabels(
  merged: ReadonlyMap<string, Top>,
  localNames: Iterable<string>,
  structure: EntryGetter | undefined,
  heads: HeadGetter = () => undefined,
): EnumLabelViolation[] {
  const violations: EnumLabelViolation[] = [];
  const local: EntryGetter = (name) => merged.get(name);
  for (const name of localNames) {
    const definition = merged.get(name);
    const body = definition === undefined ? undefined : enumBodyOf(definition);
    if (definition === undefined || body === undefined) continue;
    const head = heads(name);
    const entry: EnumEntry =
      head === undefined ? { value: definition } : { value: definition, head };
    const message = checkEnum(name, entry, body, local, structure, heads);
    if (message !== undefined) violations.push({ entry: name, message });
  }
  return violations;
}

function checkEnum(
  name: string,
  definition: EnumEntry,
  body: EnumBody,
  local: EntryGetter,
  structure: EntryGetter | undefined,
  heads: HeadGetter,
): string | undefined {
  const label = enumLabelType(definition, local, structure, heads);
  if (label === undefined) {
    return `'${name}': its name_type '${body.nameType}' names nothing in scope (§7.4)`;
  }
  const labelBody = label.definition;
  if (isTemplateBody(labelBody) || labelBody.kind !== 'identifier_type') {
    return (
      `'${name}': its name_type '${body.nameType}' is not an identifier family -- an enum's ` +
      'members are names drawn from an atom-family instance whose constructor IS-A ' +
      "identifier_type (§7.4). A closed set of values on another family is that family's own " +
      "'members' facet: '!text ^ { members: [...] }' or '!integer ^ { members: [80 443] }', not " +
      'an enum'
    );
  }
  const form = nameTypeFormRefusal(labelBody);
  if (form !== undefined) {
    return `'${name}': its name_type '${body.nameType}' cannot judge names -- ${form} (§7.4)`;
  }
  const parser = atomParserFor(label.name, labelBody);
  if (parser === undefined) return undefined; // a family with no parser: nothing to judge by
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
        `'${name}': member '${member}' is not a value of its name_type '${body.nameType}': ` +
        error.message +
        " -- a closed set of text that is no name is '!text ^ { members: [...] }'"
      );
    }
    // Text values are one when they are NFC-equal, each in its type's form (§5.5).
    const identity = nfcFloor(typeof value === 'string' ? value : member);
    const earlier = seen.get(identity);
    if (earlier !== undefined) {
      return (
        `'${name}': members '${earlier}' and '${member}' are one value of its name_type ` +
        `'${body.nameType}' (§7.4)`
      );
    }
    seen.set(identity, member);
  }
  return undefined;
}
