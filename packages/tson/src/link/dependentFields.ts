/**
 * [TSON-SCHEMA] §5.2's rules for a dependent field, `v?: kind!`, checked at the declaration against the
 * flattened record: a field whose type is a sibling reference, read per instance against the type its
 * sibling's value names. The linker asks {@link checkDependentFields} of every closed record, so a record
 * template's member is judged once its application closes it.
 *
 * - **The sibling is declared before the dependent field.** The fields are a telescope: a field depends only
 *   on the fields before it, in the order of `fields`, so no cycle can form and none is looked for.
 *   Flattening puts inherited fields first, so a base's sibling precedes a subtype's dependent field.
 * - **The sibling is typed by a reference to types**: past its alias hops a reference over a constructor (or
 *   `top`), so every value it holds names a type. One that allows a sibling reference is admitted, as
 *   `record_field.type` is; a sibling reference as its value is refused where the dependent field is read.
 * - **The sibling is there to read whenever the dependent field is**: required, defaulted, pinned, or a
 *   member of a field group with the dependent field optional, a group's own member being declared optional.
 *   A sibling that is optional with no default, or voidable, is refused, as is a member beside a required
 *   dependent field.
 * - **A sibling's default or pin names a type a value can be read against**: a template, which no value is
 *   read against until it is applied, is refused, a record template among them, and so is a sibling
 *   reference. That it is a member of the sibling's reference is the field-value check's.
 * - **A dependent field is never voidable and carries no default or pin**: its type is not fixed at its
 *   declaration, so neither is the type a value of it would be read against.
 *
 * A dependent field restated only as itself is {@link restatesDependent}'s rule, which the restated-field
 * check asks. This is a rule of the schema, not of an encoding, so it lives in `link/`, where both
 * encodings' schema loads reach it.
 */
import { TsonAtomParseError, TsonSchemaValidationError } from '../core/errors.js';
import { parseReference } from '../atom/referenceGrammar.js';
import type { RecordBody, RecordField, ReferenceBody } from '../schema/meta/bodies.js';
import { isGroupMember } from '../schema/meta/bodies.js';
import type { Reference, Top, TypeRef } from '../schema/meta/typedef.js';
import { referenceEntryOf } from '../schema/meta/referenceIndex.js';
import { referenceFromAst } from '../schema/referenceAtoms.js';
import { isOpen, isTemplateBody, referenceText } from '../schema/meta/typedef.js';
import type { Reference as AstReference } from '../ast/reference.js';
import { terminal, type EntryLookup } from './aliasChain.js';
import { namesTypes as constructorNamesTypes } from './kindMembers.js';

/** Refuses the first of `record`'s dependent fields, in declaration order, that breaks one of the rules. */
export function checkDependentFields(
  entryName: string,
  record: RecordBody,
  namespace: ReadonlyMap<string, Top>,
): void {
  const order = [...record.fields.entries.keys()];
  for (const [at, name] of order.entries()) {
    const field = record.fields.entries.get(name);
    if (field?.type.kind !== 'sibling') continue;
    const sibling = field.type;
    const dependent = `'${entryName}': field '${name}' is typed '${referenceText(sibling)}'`;
    if (field.voidable) {
      throw new TsonSchemaValidationError(
        `${dependent}, a dependent field, and is voidable -- a dependent field may be optional but is ` +
          `never voidable: when present it has a value, read against the type its sibling names, and ` +
          `'_' is no value of that type (§5.2)`,
      );
    }
    if (field.value !== undefined) {
      throw new TsonSchemaValidationError(
        `${dependent}, a dependent field, and carries ${field.role === 'FIXED' ? 'a pin' : 'a default'} ` +
          `-- a dependent field's type is not fixed at its declaration, so neither is the type a value ` +
          `of it would be read against; pin the sibling '${sibling.field}' instead (§5.2)`,
      );
    }
    const siblingAt = order.indexOf(sibling.field);
    if (siblingAt < 0) {
      throw new TsonSchemaValidationError(
        `${dependent}, but '${entryName}' has no field '${sibling.field}' -- a sibling reference names a ` +
          `field of the same record, never a schema entry; it declares ${order.join(', ')} (§5.2)`,
      );
    }
    if (siblingAt >= at) {
      throw new TsonSchemaValidationError(
        `${dependent}, but '${sibling.field}' is declared ${siblingAt === at ? 'as the field itself' : 'after it'} ` +
          `-- a record's fields are a telescope, each depending only on the fields declared before it, ` +
          `so the sibling precedes its dependent field (§5.2)`,
      );
    }
    checkSibling(entryName, name, sibling.field, record, namespace);
  }
}

/** The rules a dependent field's sibling answers to: typed by a reference to types, and there to read. */
function checkSibling(
  entryName: string,
  dependent: string,
  siblingName: string,
  record: RecordBody,
  namespace: ReadonlyMap<string, Top>,
): void {
  const field = record.fields.entries.get(siblingName);
  const dependentField = record.fields.entries.get(dependent);
  if (field === undefined || dependentField === undefined) return;
  const about = `'${entryName}': field '${dependent}' takes its type from '${siblingName}'`;
  if (field.type.kind === 'sibling') {
    throw new TsonSchemaValidationError(
      `${about}, which is itself a dependent field ('${referenceText(field.type)}') and names no types ` +
        `-- a sibling is typed by a reference whose values name types, meta.type_ref or a ` +
        `meta.ref<C> over a constructor (§5.2)`,
    );
  }
  const type = field.type;
  if (!namesTypes(type, namespace)) {
    throw new TsonSchemaValidationError(
      `${about}, which is typed '${referenceText(type)}' -- a sibling is typed by a reference whose ` +
        `values name types, meta.type_ref, a meta.ref<C> over a constructor, or a refinement of ` +
        `either, so that every value it holds names a type to read '${dependent}' against (§5.2)`,
    );
  }
  if (field.voidable) {
    throw new TsonSchemaValidationError(
      `${about}, which is voidable -- '_' names no type, so a '${dependent}' written beside it would ` +
        `have none to be read against; a sibling is there to read whenever its dependent field is (§5.2)`,
    );
  }
  const member = isGroupMember(record.groups, siblingName);
  if (member && !dependentField.optional) {
    throw new TsonSchemaValidationError(
      `${about}, which is a member of a field group, and '${dependent}' is required -- a member is ` +
        `present only when its option is chosen and is never supplied, so '${dependent}' could have ` +
        `no type to be read against; a group member is the sibling of an optional dependent field ` +
        `alone (§5.2, §5.11)`,
    );
  }
  if (!member && field.optional && field.value === undefined) {
    throw new TsonSchemaValidationError(
      `${about}, which is optional with no default -- a '${dependent}' written without it would have ` +
        `no type; a sibling is there to read whenever its dependent field is: required, defaulted, ` +
        `pinned, or a field group's member beside an optional dependent field (§5.2)`,
    );
  }
  if (field.value !== undefined) checkSiblingValue(about, field, field.value.text, namespace);
}

/**
 * A sibling's default or pin names a type a value can be read against. A template is refused, a record
 * template among them although the kernel makes it a family base: its members are its applications, which
 * are not values of the sibling's type until applied, and reading never starts a materialisation.
 */
function checkSiblingValue(
  about: string,
  field: RecordField,
  text: string,
  namespace: ReadonlyMap<string, Top>,
): void {
  const noun = field.role === 'FIXED' ? 'pin' : 'default';
  let named: AstReference;
  try {
    named = parseReference(text);
  } catch (error) {
    if (error instanceof TsonAtomParseError) return; // no reference at all: the field-value check refuses it
    throw error;
  }
  if (named.kind === 'sibling') {
    throw new TsonSchemaValidationError(
      `${about}, whose ${noun} is the sibling reference '${named.field}!', which names no type a value ` +
        `can be read against (§5.2)`,
    );
  }
  if (named.kind === 'application') return; // judged a member, through the entry it denotes, by the field-value check
  const lookup: EntryLookup = (name) => namespace.get(name);
  const target = namespace.get(terminal(named.name, lookup));
  if (target !== undefined && isOpen(target)) {
    throw new TsonSchemaValidationError(
      `${about}, whose ${noun} '${named.name}' is a template -- no value is read against a template ` +
        `until it is applied, so an instance omitting the sibling would have no type to read by; name ` +
        `a type, or an application this schema closes (§5.2)`,
    );
  }
}

/** Whether a field typed `type` holds names of types: past its alias hops, a reference over a constructor. */
function namesTypes(type: TypeRef, namespace: ReadonlyMap<string, Top>): boolean {
  if (type.arguments.length > 0) return false; // a closed record names an application's entry bare
  const lookup: EntryLookup = (name) => namespace.get(name);
  const target = namespace.get(terminal(type.name, lookup));
  return (
    target !== undefined &&
    !isTemplateBody(target) &&
    target.kind === 'reference_type' &&
    constructorNamesTypes(target.of.name, lookup)
  );
}

/**
 * Why `restated` is no restatement of `inherited` where either is a dependent field, or `undefined` where
 * neither is or the two agree: a dependent field is restated only as itself, its marks moving along §5.7's
 * order as any field's do. Its type stays the sibling reference on every member of the family, and pinning
 * the sibling is what fixes the type.
 */
export function restatesDependent(
  fieldName: string,
  inherited: RecordField,
  restated: RecordField,
): string | undefined {
  const wasDependent = inherited.type.kind === 'sibling';
  const isDependent = restated.type.kind === 'sibling';
  if (!wasDependent && !isDependent) return undefined;
  if (referenceText(inherited.type) === referenceText(restated.type)) return undefined;
  return wasDependent
    ? `field '${fieldName}' is the dependent field '${referenceText(inherited.type)}' and is restated ` +
        `'${referenceText(restated.type)}' -- a dependent field is restated only as itself; to fix ` +
        `its type, pin its sibling '${(inherited.type as { field: string }).field}' (§5.2)`
    : `field '${fieldName}' is typed '${referenceText(inherited.type)}' and is restated as the ` +
        `dependent field '${referenceText(restated.type)}', which is not '${referenceText(inherited.type)}' or IS-A it`;
}

// ── Reading a dependent field: the type a sibling's value names ─────────────────────────────────

/** What a sibling's value types its dependent field by: the entry a value is read against, or why there is none. */
export type TypeNamed =
  | { readonly kind: 'entry'; readonly name: string }
  | { readonly kind: 'none'; readonly held: string };

/**
 * The reference typing the sibling `declared`, past its alias hops in `entries`: what an application the
 * sibling's value writes resolves through ({@link typeNamed}). `undefined` where the sibling is typed by no
 * reference, which the linker refuses.
 */
export function siblingType(
  declared: RecordField,
  entries: EntryLookup,
): ReferenceBody | undefined {
  if (declared.type.kind === 'sibling') return undefined;
  const target = entries(terminal(declared.type.name, entries));
  return target !== undefined && !isTemplateBody(target) && target.kind === 'reference_type'
    ? target
    : undefined;
}

/**
 * What a sibling holding `named` types its dependent field by (§5.2): the entry a value is read against, or
 * why there is none. `siblingType` resolves an application ({@link siblingType}), and `entries` is the
 * namespace the entry is found in, `undefined` where none is known and the entry is taken as named. Both
 * encodings' readers, and a value entry's dependent field judged at link, decide by this one rule.
 */
export function typeNamed(
  named: Reference,
  sibling: ReferenceBody | undefined,
  entries: EntryLookup | undefined,
): TypeNamed {
  if (named.kind === 'sibling') {
    return {
      kind: 'none',
      held: `the sibling reference '${referenceText(named)}', which names a field and no type`,
    };
  }
  const entry =
    named.arguments.length === 0
      ? named.name
      : sibling === undefined
        ? undefined
        : referenceEntryOf(sibling, named);
  if (entry === undefined) {
    return {
      kind: 'none',
      held: `'${referenceText(named)}', which names no type this schema closes`,
    };
  }
  const body = entries === undefined ? undefined : entries(terminal(entry, entries));
  if (entries !== undefined && body === undefined) {
    return { kind: 'none', held: `'${referenceText(named)}', which names no type of this schema` };
  }
  if (body !== undefined && isOpen(body)) {
    return {
      kind: 'none',
      held: `'${referenceText(named)}', a template, which no value is read against until it is applied`,
    };
  }
  return { kind: 'entry', name: entry };
}

/**
 * The reference the text a sibling's read produced spells; `undefined` where there is no text or it spells
 * none. A reference position delivers its value as the canonical text, which is what both encodings' reads
 * of a sibling hand over.
 */
export function referenceIn(text: string | undefined): Reference | undefined {
  if (text === undefined) return undefined;
  try {
    return referenceFromAst(parseReference(text));
  } catch (error) {
    if (error instanceof TsonAtomParseError) return undefined;
    throw error;
  }
}

/** One refusal a dependent field's read yields, in the shape both encodings' readers report. */
export interface DependentRefusal {
  readonly code: 'VALIDATION_ERROR';
  readonly message: string;
  readonly expected: string;
  readonly found: string;
}

/**
 * §2.5 and §5.2: the dependent field `field` is written before `sibling`, the free sibling whose value types
 * it -- the one place a record's field order is significant, so a reader never holds a value it cannot yet
 * type.
 */
export function writtenBeforeItsSibling(
  typeName: string,
  field: string,
  sibling: string,
): DependentRefusal {
  return {
    code: 'VALIDATION_ERROR',
    message:
      `field '${field}' on '${typeName}' is written before '${sibling}', the sibling whose value names its ` +
      `type -- a sibling that is neither pinned nor a discriminator is written before the field that ` +
      `depends on it (§2.5, §5.2)`,
    expected: `'${sibling}' written before '${field}'`,
    found: `'${field}' written first`,
  };
}

/**
 * §5.2 and §5.11: `field` is written and its sibling `sibling`, a field group's member, is absent, another
 * option being chosen or none, so the value has no type to be read against.
 */
export function writtenWithoutItsSibling(
  typeName: string,
  field: string,
  sibling: string,
): DependentRefusal {
  return {
    code: 'VALIDATION_ERROR',
    message:
      `field '${field}' on '${typeName}' is written without '${sibling}', the sibling whose value names its ` +
      `type -- '${sibling}' is a field group's member, supplied by no default or pin, so '${field}' has no ` +
      `type to be read against (§5.2, §5.11)`,
    expected: `'${sibling}' written beside '${field}'`,
    found: `'${field}' written without it`,
  };
}

/**
 * §5.2: `sibling` types the dependent field `field`, which is present, and holds `held`, no type a value can
 * be read against -- reported at the sibling, the value to change, as `written`.
 */
export function siblingNamesNoType(
  typeName: string,
  sibling: string,
  field: string,
  held: string,
  written: string,
): DependentRefusal {
  return {
    code: 'VALIDATION_ERROR',
    message:
      `field '${sibling}' on '${typeName}' types the dependent field '${field}', and holds ${held} -- ` +
      `where the dependent field is present, its sibling names a type a value can be read against (§5.2)`,
    expected: 'the name of a type a value can be read against',
    found: written,
  };
}
