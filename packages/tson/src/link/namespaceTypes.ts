/**
 * The declaration-side rules for kinds, references and namespace types (Part 2 §4.1, §4.2, §5.12),
 * judged when the declaring schema links -- the counterparts of the reference implementation's
 * `TsonSchemaLinker.readAsMaps` and the `KindBody`/`RefBody` arms of its `validateBody`.
 *
 * - **A kind's `of`** resolves in the structure namespace, as every constructor role does
 *   (§3.3.1), and names `type`, `namespace` or a constructor below either: anything else
 *   (`kind<reference>`) would hold no type a value can have, and is refused at the declaration
 *   rather than read as an empty kind.
 * - **A reference's `of`** names a type of the writer's own namespace or a namespace type, never a
 *   constructor of types: the names of the types built with a constructor are a kind, and
 *   `kind<record>` is that spelling. A reference names an entry holding a value, which only a
 *   schema the meta-kernel governs declares, so a reference declared anywhere else names nothing.
 * - **A namespace type** IS-A `top`, so only a schema the meta-kernel governs declares one
 *   (§2.2.2), and it is the map its facets describe: it declares nothing beside `key_type`,
 *   `value_type` and `ordered`, blamed on the namespace type that declares the field and not again
 *   on a subtype inheriting it, and one that is not abstract pins both of the first two.
 * - **A field pinned at a kind-typed slot** (`key_type: = verb`, `name_type?: = text_identifier`)
 *   holds a type's name, a member of the slot's kind, judged over the closure that links it.
 *
 * Local entries only: an imported entry was judged when its own schema linked.
 */
import type { DiagnosticsReceiver } from '../core/diagnostic.js';
import { TsonSchemaValidationError } from '../core/errors.js';
import type { RecordBody } from '../schema/meta/bodies.js';
import { namedFields } from '../schema/meta/bodies.js';
import type { EntryFacts, KindBody, RefBody, Top } from '../schema/meta/typedef.js';
import { isOpen, isTemplateBody, supertypesOf } from '../schema/meta/typedef.js';
import {
  NAMESPACE_FACETS,
  NAMESPACE_KIND,
  isNamespaceType,
  namespaceMapOf,
} from '../schema/meta/namespaces.js';
import { schemaPositionOf } from './facts.js';
import { isKindMember } from './kindMembers.js';
import { terminal, type EntryLookup } from './referenceChain.js';

const TYPE = 'type';
const TOP = 'top';

/** Dependencies {@link checkKindsReferencesAndNamespaceTypes} needs beyond the merged namespace. */
export interface NamespaceTypeOptions {
  readonly schemaId: string;
  readonly facts: ReadonlyMap<string, EntryFacts>;
  /** The governing meta's namespace -- absent while the meta-kernel links itself. */
  readonly structureNamespace?: ReadonlyMap<string, Top>;
  /**
   * Whether the schema linking is governed by the meta-kernel, the one level where an entry holds a
   * value (§2.2.2, §4.1). `false` refuses every reference the schema declares; absent, the level is
   * unknown and no reference is refused for it.
   */
  readonly kernelGoverned?: boolean;
  readonly receiver?: DiagnosticsReceiver;
}

/** Judges the rules this module's top note lists over every local entry of `merged`. */
export function checkKindsReferencesAndNamespaceTypes(
  merged: ReadonlyMap<string, Top>,
  localNames: ReadonlySet<string>,
  options: NamespaceTypeOptions,
): void {
  const local: EntryLookup = (name) => merged.get(name);
  const structureNamespace = options.structureNamespace;
  const structure: EntryLookup = (name) => structureNamespace?.get(name);
  const inReach: EntryLookup = (name) => merged.get(name) ?? structureNamespace?.get(name);
  const heads = (name: string): string | undefined => options.facts.get(name)?.head;
  for (const name of localNames) {
    const value = merged.get(name);
    if (value === undefined || isTemplateBody(value) || isOpen(value)) continue;
    try {
      switch (value.kind) {
        case 'kind_type':
          if (structureNamespace !== undefined) checkKindOf(name, value, structure);
          break;
        case 'ref_type':
          if (options.kernelGoverned === false) throw referenceOutsideTheKernelLevel(name, options);
          checkReferenceOf(name, value, local, structure);
          break;
        case 'record':
          if (isKernelNamespaceType(value, name, inReach)) {
            if (options.kernelGoverned === false)
              throw namespaceTypeOutsideTheKernelLevel(name, options);
            checkNamespaceType(name, value, merged, inReach);
          }
          checkKindPins(name, value, inReach, local, heads, structure);
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

/** `of` names `type`, `namespace`, or a constructor below either, in the structure namespace (§4.2). */
function checkKindOf(name: string, kind: KindBody, structure: EntryLookup): void {
  const end = terminal(kind.of, structure);
  const constructor = structure(end);
  if (
    constructor === undefined ||
    (!isTemplateBody(constructor) && constructor.kind === 'reference')
  ) {
    throw new TsonSchemaValidationError(
      `'${name}' is a kind, but its 'of' names '${kind.of}', which the structure namespace does not ` +
        'declare -- a kind names a constructor of the governing meta, as a constructor role does ' +
        "(§3.3.1), and never a type of this schema's own namespace",
    );
  }
  const supertypes = supertypesOf(constructor);
  if (
    end === TYPE ||
    end === NAMESPACE_KIND ||
    supertypes.includes(TYPE) ||
    supertypes.includes(NAMESPACE_KIND)
  ) {
    return;
  }
  throw new TsonSchemaValidationError(
    `'${name}' is a kind, but its 'of' names '${kind.of}', which is not 'type', 'namespace' or a ` +
      'constructor below either, so no value has a type built with it and the kind could have no ' +
      "members -- name 'type', a base kind, 'namespace', or a constructor that IS-A one (§4.2)",
  );
}

/**
 * `of` names a type of the writer's namespace, or a namespace type, never a constructor of types
 * (§5.12). In an ordinary schema's namespace no constructor is held, so there a constructor is
 * the name the structure namespace holds.
 */
function checkReferenceOf(
  name: string,
  reference: RefBody,
  local: EntryLookup,
  structure: EntryLookup,
): void {
  const end = terminal(reference.of, local);
  const of = local(end);
  if (of === undefined) {
    const constructor = structure(reference.of);
    if (
      constructor !== undefined &&
      (reference.of === TYPE || supertypesOf(constructor).includes(TYPE))
    ) {
      throw referenceToAConstructor(name, reference);
    }
    throw new TsonSchemaValidationError(
      `'${name}' has an unresolved reference '${reference.of}' in its 'of'`,
    );
  }
  if (end === TYPE || supertypesOf(of).includes(TYPE))
    throw referenceToAConstructor(name, reference);
  if (isOpen(of) || isTemplateBody(of)) {
    throw new TsonSchemaValidationError(
      `'${name}' is a reference whose 'of' names '${reference.of}', an open entry: a template ` +
        'denotes no type until it is applied (§5.10)',
    );
  }
}

function referenceToAConstructor(name: string, reference: RefBody): TsonSchemaValidationError {
  return new TsonSchemaValidationError(
    `'${name}' is a reference whose 'of' names '${reference.of}', a constructor -- a reference ` +
      '(ref<T>) names a value of the type T, and the names of the types built with a constructor ' +
      `are a kind: write kind<${reference.of}> (§4.2, §5.12)`,
  );
}

function referenceOutsideTheKernelLevel(
  name: string,
  options: NamespaceTypeOptions,
): TsonSchemaValidationError {
  return new TsonSchemaValidationError(
    `'${name}' is a reference (ref_type), but '${options.schemaId}' is not governed by the ` +
      'meta-kernel -- a reference names an entry holding a value, and only a schema the meta-kernel ' +
      'governs has one (§2.2.2, §4.1); a schema governing data declares only types, so a reference ' +
      'there names nothing',
  );
}

function namespaceTypeOutsideTheKernelLevel(
  name: string,
  options: NamespaceTypeOptions,
): TsonSchemaValidationError {
  return new TsonSchemaValidationError(
    `'${name}' is a namespace type, which IS-A 'top', but '${options.schemaId}' is not governed by ` +
      'the meta-kernel -- a constructor is declared only by a meta-schema (§2.2.2, §4.1); declare ' +
      'the namespace type in a meta layer, and hold its values in the schemas that layer governs',
  );
}

/**
 * Whether `record` is a namespace type, the `namespace` it IS-A being the kernel's own: judged by
 * where the base kind is defined, never by its spelling, so a schema's own record called
 * `namespace` composed into another leaves that one a product (§4.1).
 */
function isKernelNamespaceType(record: RecordBody, name: string, inReach: EntryLookup): boolean {
  if (!isNamespaceType(record, name)) return false;
  const base = name === NAMESPACE_KIND ? record : inReach(NAMESPACE_KIND);
  return base !== undefined && supertypesOf(base).includes(TOP);
}

/** A namespace type declares only its facets, and one that is not abstract pins both of the first two (§4.1). */
function checkNamespaceType(
  name: string,
  record: RecordBody,
  merged: ReadonlyMap<string, Top>,
  inReach: EntryLookup,
): void {
  const beside = namedFields(record)
    .map((field) => field.name)
    .filter((field) => !NAMESPACE_FACETS.includes(field))
    .filter(
      (field) =>
        !supertypesOf(record).some((supertype) => {
          const parent = merged.get(supertype) ?? inReach(supertype);
          return (
            parent !== undefined &&
            isNamespaceType(parent, supertype) &&
            parent.fields.entries.has(field)
          );
        }),
    );
  if (beside.length > 0) {
    const fields = beside.map((field) => `'${field}'`).join(', ');
    throw new TsonSchemaValidationError(
      `'${name}' is a namespace type, so a value of it is the map its 'key_type' and 'value_type' ` +
        `describe, and it declares ${beside.length === 1 ? 'the field' : 'the fields'} ${fields} ` +
        `beside them, which no value can carry -- declare a record holding ${fields} beside a field ` +
        'typed by the map, and hold that record under a key of a namespace type (§4.1)',
    );
  }
  if (namespaceMapOf(record) === undefined && record.extension !== 'ABSTRACT') {
    throw new TsonSchemaValidationError(
      `'${name}' is a namespace type, so a value of it is a map, and it leaves its 'key_type' or ` +
        "'value_type' open -- pin both by composition ('key_type: = K  value_type: = V', or " +
        "'key_type?: ~ K' for keys whose family the host supplies), or declare it abstract (§4.1)",
    );
  }
}

/**
 * A field whose type is a kind and that carries a value (`key_type: = verb`) holds a type's name,
 * and the name is a member of the kind (§4.2).
 */
function checkKindPins(
  name: string,
  record: RecordBody,
  inReach: EntryLookup,
  local: EntryLookup,
  heads: (name: string) => string | undefined,
  structure: EntryLookup,
): void {
  for (const field of namedFields(record)) {
    const value = field.value;
    if (value?.form !== 'UNQUOTED') continue;
    const kind = inReach(terminal(field.type.name, inReach));
    if (kind === undefined || isTemplateBody(kind) || kind.kind !== 'kind_type') continue;
    if (isKindMember(value.text, kind.of, local, heads, structure)) continue;
    throw new TsonSchemaValidationError(
      `'${name}': field '${field.name}' is typed '${field.type.name}', the names of the types built ` +
        `with '${kind.of}', and its ${field.role === 'DEFAULT' ? 'default' : 'fixed value'} ` +
        `'${value.text}' is no member of it (§4.2)`,
    );
  }
}
