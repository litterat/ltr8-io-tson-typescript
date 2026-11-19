/**
 * The declaration-side rules for references and namespace types (Part 2 §4.1, §4.2, §5.12), judged when
 * the declaring schema links -- the counterparts of the reference implementation's `TsonSchemaLinker`
 * arms for `ReferenceBody` and `NamespaceBody`.
 *
 * - **A reference's `of`** resolves in the schema's one namespace, as every name does, and names a type or
 *   a constructor of one; an open entry denotes no type until applied (§5.10) and a name that resolves to
 *   nothing is no name. Over a constructor the reference holds a type's name, over any other type a
 *   value's qualified name (§4.2).
 * - **A namespace type's** `key_type` and `value_type` resolve (§4.1).
 * - **A field pinned at a reference-typed slot over a constructor** (`key_type: = verb`, `name_type?: =
 *   meta.identifier`) holds a type's name, a member of the slot's reference, judged over the closure that
 *   links it.
 *
 * Local entries only: an imported entry was judged when its own schema linked.
 */
import type { DiagnosticsReceiver } from '../core/diagnostic.js';
import { TsonSchemaValidationError } from '../core/errors.js';
import type { NamespaceBody, RecordBody, ReferenceBody } from '../schema/meta/bodies.js';
import { namedFields, typeNameOf } from '../schema/meta/bodies.js';
import type { EntryFacts, Top } from '../schema/meta/typedef.js';
import { isOpen, isTemplateBody } from '../schema/meta/typedef.js';
import { schemaPositionOf, spellingOf } from './facts.js';
import { isKindMember, namesTypes } from './kindMembers.js';
import { terminal, type EntryLookup } from './referenceChain.js';

/** Dependencies {@link checkKindsReferencesAndNamespaceTypes} needs beyond the merged namespace. */
export interface NamespaceTypeOptions {
  readonly schemaId: string;
  readonly facts: ReadonlyMap<string, EntryFacts>;
  /** The schema's one namespace -- the merged entries a name resolves in. */
  readonly structureNamespace?: ReadonlyMap<string, Top>;
  readonly receiver?: DiagnosticsReceiver;
}

/** Judges the rules this module's top note lists over every local entry of `merged`. */
export function checkKindsReferencesAndNamespaceTypes(
  merged: ReadonlyMap<string, Top>,
  localNames: ReadonlySet<string>,
  options: NamespaceTypeOptions,
): void {
  const local: EntryLookup = (name) => merged.get(name);
  const heads = (name: string): string | undefined => options.facts.get(name)?.head;
  const spelled = (name: string): string => spellingOf(name, merged.get(name), options.facts);
  for (const name of localNames) {
    const value = merged.get(name);
    if (value === undefined || isTemplateBody(value) || isOpen(value)) continue;
    try {
      switch (value.kind) {
        case 'reference_type':
          checkReferenceOf(spelled(name), value, local);
          break;
        case 'namespace':
          checkNamespaceType(spelled(name), value, local);
          break;
        case 'record':
          checkReferencePins(name, value, local, heads, spelled);
          break;
        default:
          break;
      }
    } catch (error) {
      if (!(error instanceof TsonSchemaValidationError) || options.receiver === undefined)
        throw error;
      options.receiver.report({
        code: 'SCHEMA_ERROR',
        message: error.message,
        schemaId: options.schemaId,
        schemaPointer: `/${name}`,
        ...schemaPositionOf(options.facts, name),
      });
    }
  }
}

/** `of` names a type or a constructor of the schema's namespace -- never an open entry or nothing (§4.2). */
function checkReferenceOf(name: string, reference: ReferenceBody, local: EntryLookup): void {
  const end = terminal(reference.of.name, local);
  const of = local(end);
  if (of === undefined) {
    throw new TsonSchemaValidationError(
      `'${name}' has an unresolved reference '${reference.of.name}' in its 'of'`,
    );
  }
  if (isOpen(of) || isTemplateBody(of)) {
    throw new TsonSchemaValidationError(
      `'${name}' is a reference whose 'of' names '${reference.of.name}', an open entry: a template ` +
        'denotes no type until it is applied (§5.10)',
    );
  }
}

/** A namespace type's `key_type` and `value_type` name entries of the schema's namespace (§4.1). */
function checkNamespaceType(name: string, namespace: NamespaceBody, local: EntryLookup): void {
  for (const [slot, type] of [
    ['key_type', namespace.keyType],
    ['value_type', namespace.valueType],
  ] as const) {
    if (local(terminal(type.name, local)) === undefined) {
      throw new TsonSchemaValidationError(
        `'${name}' is a namespace type whose '${slot}' names '${type.name}', which the schema's ` +
          'namespace does not declare (§4.1)',
      );
    }
  }
}

/**
 * A field whose type is a reference over a constructor and that carries a value (`key_type: = verb`)
 * holds a type's name, and the name is a member of the reference (§4.2).
 */
function checkReferencePins(
  name: string,
  record: RecordBody,
  local: EntryLookup,
  heads: (name: string) => string | undefined,
  spelled: (name: string) => string,
): void {
  for (const field of namedFields(record)) {
    const value = field.value;
    if (value?.form !== 'UNQUOTED') continue;
    const reference = local(terminal(typeNameOf(field), local));
    if (
      reference === undefined ||
      isTemplateBody(reference) ||
      reference.kind !== 'reference_type' ||
      !namesTypes(reference.of.name, local)
    ) {
      continue;
    }
    if (isKindMember(value.text, reference.of.name, local, heads)) continue;
    throw new TsonSchemaValidationError(
      `'${name}': field '${field.name}' is typed '${spelled(typeNameOf(field))}', the names of the types built ` +
        `with '${reference.of.name}', and its ${field.role === 'DEFAULT' ? 'default' : 'fixed value'} ` +
        `'${value.text}' is no member of it (§4.2)`,
    );
  }
}
