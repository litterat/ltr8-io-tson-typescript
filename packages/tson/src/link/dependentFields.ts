/**
 * [TSON-SCHEMA] §5.2's rules for a dependent field, `v?: kind!`, checked at the declaration against the flattened
 * record: a field whose type is a `meta.dependent` written in place, read per instance against the type its
 * sibling's value names. The linker asks {@link checkDependentFields} of every closed record.
 *
 * - **The sibling is declared before the dependent field.** The fields are a telescope: a field depends only on
 *   the fields before it, in the order of `fields`, so no cycle can form and none is looked for.
 * - **The sibling is typed by a reference to types**: past its alias hops a reference over a constructor (or
 *   `top`), written by name or in place, or the kernel's `meta.type_expr`, what a type slot holds -- whose names
 *   are a reference naming types and whose other variant, a type written in place, names no entry.
 * - **The sibling is there to read whenever the dependent field is**: required, defaulted, pinned, or a member of
 *   a field group with the dependent field optional.
 * - **A sibling's default or pin names a type a value can be read against**: a parametric record, which no value
 *   is read against until it is applied, is refused.
 * - **A dependent field is never voidable and carries no default or pin.**
 *
 * A dependent field restated only as itself is {@link restatesDependent}'s rule.
 */
import { TsonAtomParseError, TsonSchemaValidationError } from '../core/errors.js';
import { parseReference } from '../atom/referenceGrammar.js';
import type { RecordBody, RecordField, RefBody } from '../schema/meta/bodies.js';
import { isGroupMember, typeExprText } from '../schema/meta/bodies.js';
import type { Top, TypeExpr, TypeRef } from '../schema/meta/typedef.js';
import { dependentOn, isParametric } from '../schema/meta/typedef.js';
import { sameTypeExpr } from '../schema/meta/typeInline.js';
import { metaName } from '../schema/meta/kernel.js';
import { terminal, type EntryLookup } from './aliasChain.js';
import { namesTypes as constructorNamesTypes } from './kindMembers.js';

/** The kernel's choice a type slot is typed by: a type's name, or a type written in place. */
const TYPE_EXPR = metaName('type_expr');

/** Refuses the first of `record`'s dependent fields, in declaration order, that breaks one of the rules. */
export function checkDependentFields(
  entryName: string,
  record: RecordBody,
  namespace: ReadonlyMap<string, Top>,
): void {
  const order = [...record.fields.entries.keys()];
  for (const [at, name] of order.entries()) {
    const field = record.fields.entries.get(name);
    const sibling = field === undefined ? undefined : dependentOn(field.type);
    if (field === undefined || sibling === undefined) continue;
    const dependent = `'${entryName}': field '${name}' is typed '${typeExprText(field.type)}'`;
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
          `of it would be read against; pin the sibling '${sibling}' instead (§5.2)`,
      );
    }
    const siblingAt = order.indexOf(sibling);
    if (siblingAt < 0) {
      throw new TsonSchemaValidationError(
        `${dependent}, but '${entryName}' has no field '${sibling}' -- a dependent type names a field of the ` +
          `same record, never a schema entry; it declares ${order.join(', ')} (§5.2)`,
      );
    }
    if (siblingAt >= at) {
      throw new TsonSchemaValidationError(
        `${dependent}, but '${sibling}' is declared ${siblingAt === at ? 'as the field itself' : 'after it'} ` +
          `-- a record's fields are a telescope, each depending only on the fields declared before it, ` +
          `so the sibling precedes its dependent field (§5.2)`,
      );
    }
    checkSibling(entryName, name, sibling, record, namespace);
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
  if (dependentOn(field.type) !== undefined) {
    throw new TsonSchemaValidationError(
      `${about}, which is itself a dependent field ('${typeExprText(field.type)}') and names no types ` +
        `-- a sibling is typed by a reference whose values name types, meta.type_ref or a ` +
        `meta.ref<C> over a constructor (§5.2)`,
    );
  }
  if (!namesTypes(field.type, namespace)) {
    throw new TsonSchemaValidationError(
      `${about}, which is typed '${typeExprText(field.type)}' -- a sibling is typed by a reference whose ` +
        `values name types, meta.type_ref, a meta.ref<C> over a constructor, or a refinement of either, or ` +
        `by what a type slot holds (meta.type_expr), so that every value it holds names a type to read ` +
        `'${dependent}' against (§5.2)`,
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
 * A sibling's default or pin names a type a value can be read against. A parametric record is refused: no
 * position names one bare (§5.10), and reading never starts a materialisation.
 */
function checkSiblingValue(
  about: string,
  field: RecordField,
  text: string,
  namespace: ReadonlyMap<string, Top>,
): void {
  const noun = field.role === 'FIXED' ? 'pin' : 'default';
  let named: string;
  try {
    named = parseReference(text);
  } catch (error) {
    if (error instanceof TsonAtomParseError) return; // no reference at all: the field-value check refuses it
    throw error;
  }
  const lookup: EntryLookup = (name) => namespace.get(name);
  const target = namespace.get(terminal(named, lookup));
  if (target !== undefined && isParametric(target)) {
    throw new TsonSchemaValidationError(
      `${about}, whose ${noun} '${named}' is a parametric record -- no value is read against a parametric ` +
        'record until it is applied, so an instance omitting the sibling would have no type to read by; ' +
        'name a type, or an application this schema closes (§5.2)',
    );
  }
}

/**
 * Whether a sibling typed `type` holds type names: a reference naming types, written by name or in place
 * (`meta.ref<C>`), or the kernel's `meta.type_expr`.
 */
function namesTypes(type: TypeExpr, namespace: ReadonlyMap<string, Top>): boolean {
  const lookup: EntryLookup = (name) => namespace.get(name);
  let target: Top | undefined;
  if (type.kind === 'inline') {
    target = type.of;
  } else {
    const end = terminal(type.name, lookup);
    target = namespace.get(end === TYPE_EXPR ? metaName('type_ref') : end);
  }
  return target?.kind === 'ref' && constructorNamesTypes(target.of.name, lookup);
}

/**
 * Why `restated` is no restatement of `inherited` where either is a dependent field, or `undefined` where
 * neither is or the two agree: a dependent field is restated only as itself. Its type stays the dependent type
 * on every member of the family, and pinning the sibling is what fixes the type.
 */
export function restatesDependent(
  fieldName: string,
  inherited: RecordField,
  restated: RecordField,
): string | undefined {
  const wasDependent = dependentOn(inherited.type);
  const isDependent = dependentOn(restated.type) !== undefined;
  if ((wasDependent === undefined && !isDependent) || sameTypeExpr(inherited.type, restated.type)) {
    return undefined;
  }
  return wasDependent !== undefined
    ? `field '${fieldName}' is the dependent field '${typeExprText(inherited.type)}' and is restated ` +
        `'${typeExprText(restated.type)}' -- a dependent field is restated only as itself; to fix ` +
        `its type, pin its sibling '${wasDependent}' (§5.2)`
    : `field '${fieldName}' is typed '${typeExprText(inherited.type)}' and is restated as the ` +
        `dependent field '${typeExprText(restated.type)}', which is not '${typeExprText(inherited.type)}' or IS-A it`;
}

// ── Reading a dependent field: the type a sibling's value names ─────────────────────────────────

/** What a sibling's value types its dependent field by: the entry a value is read against, or why there is none. */
export type TypeNamed =
  | { readonly kind: 'entry'; readonly name: string }
  | { readonly kind: 'none'; readonly held: string };

/**
 * The reference typing the sibling `declared`, past its alias hops in `entries`; `undefined` where the sibling is
 * typed by no reference, which the linker refuses.
 */
export function siblingType(declared: RecordField, entries: EntryLookup): RefBody | undefined {
  if (declared.type.kind === 'inline') {
    return declared.type.of.kind === 'ref' ? declared.type.of : undefined;
  }
  const end = terminal(declared.type.name, entries);
  const target = entries(end === TYPE_EXPR ? metaName('type_ref') : end);
  return target?.kind === 'ref' ? target : undefined;
}

/**
 * What a sibling holding `named` types its dependent field by (§5.2): the entry a value is read against, or why
 * there is none. `entries` is the namespace the entry is found in, `undefined` where none is known and the entry
 * is taken as named. Both encodings' readers, and a value entry's dependent field judged at link, decide by this
 * one rule.
 */
export function typeNamed(
  named: TypeRef,
  sibling: RefBody | undefined,
  entries: EntryLookup | undefined,
): TypeNamed {
  void sibling;
  const entry = named.name;
  const body = entries === undefined ? undefined : entries(terminal(entry, entries));
  if (entries !== undefined && body === undefined) {
    return { kind: 'none', held: `'${entry}', which names no type of this schema` };
  }
  if (body !== undefined && isParametric(body)) {
    return {
      kind: 'none',
      held: `'${entry}', a parametric record, which no value is read against until it is applied`,
    };
  }
  return { kind: 'entry', name: entry };
}

/**
 * The reference the text a sibling's read produced spells; `undefined` where there is no text or it spells none.
 */
export function referenceIn(text: string | undefined): TypeRef | undefined {
  if (text === undefined) return undefined;
  try {
    return { name: parseReference(text), annotations: [] };
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
