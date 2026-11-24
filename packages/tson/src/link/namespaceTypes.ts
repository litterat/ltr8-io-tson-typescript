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
import type { NamespaceBody, RecordBody, RefBody } from '../schema/meta/bodies.js';
import { namedFields, typeNameOf } from '../schema/meta/bodies.js';
import type { EntryFacts, Top } from '../schema/meta/typedef.js';
import { isParametric, supertypesOf } from '../schema/meta/typedef.js';
import { kernelName, UNICODE_MAP } from '../schema/meta/kernel.js';
import { schemaPositionOf, spellingOf } from './facts.js';
import { isKindMember, namesTypes, ofRefusal } from './kindMembers.js';
import { isA } from './restatedFields.js';
import { terminal, type EntryLookup } from './aliasChain.js';
import { nameTypeDotRefusal } from './nameType.js';
import type { ExternHops } from './externHops.js';

/** The constructor whose instances an identifier family is (§7.7): what a namespace's `key_type` must be built with. */
const IDENTIFIER_TYPE = kernelName(UNICODE_MAP, 'identifier_type');

/** Dependencies {@link checkKindsReferencesAndNamespaceTypes} needs beyond the merged namespace. */
export interface NamespaceTypeOptions {
  readonly schemaId: string;
  readonly facts: ReadonlyMap<string, EntryFacts>;
  /** The schema's one namespace -- the merged entries a name resolves in. */
  readonly structureNamespace?: ReadonlyMap<string, Top>;
  readonly receiver?: DiagnosticsReceiver;
  /** The namespace's externs, each a member of a reference where the entry it lands on is (§5.13). */
  readonly hops?: ExternHops;
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
    if (value === undefined || isParametric(value)) continue;
    try {
      switch (value.kind) {
        case 'ref':
          checkReferenceOf(spelled(name), value, local, options.hops);
          break;
        case 'namespace':
          checkNamespaceType(spelled(name), value, local, heads);
          break;
        case 'record':
          checkReferencePins(name, value, local, heads, spelled, options.hops);
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

/**
 * `of` names a type or a constructor of the schema's namespace -- never a parametric record, an incomplete
 * entry, a value entry or nothing (§4.2) -- and a refinement of a reference narrows `of` (§5.7): the refined `of` is its source's or
 * IS-A it, so every name the refinement admits the source admits too.
 */
function checkReferenceOf(
  name: string,
  reference: RefBody,
  local: EntryLookup,
  hops: ExternHops | undefined,
): void {
  const end = terminal(reference.of.name, local);
  const of = local(end);
  if (of === undefined) {
    throw new TsonSchemaValidationError(
      `'${name}' has an unresolved reference '${reference.of.name}' in its 'of'`,
    );
  }
  const refusal = ofRefusal(reference, local);
  if (refusal !== undefined) {
    throw new TsonSchemaValidationError(`'${name}' is a reference, but ${refusal}`);
  }
  checkReferenceNarrows(name, reference, local, hops);
}

/**
 * §5.7's rule for a refinement of a reference, `!meta.type_ref ^ { of: ... }`: its `of` is its source's or
 * IS-A it. The resolver binds the refinement before the names `of` holds need be resolved, so the IS-A is
 * asked here, over the one namespace both resolve in, through its hops; the source is the reference the
 * refinement's chain names, past its alias hops.
 */
function checkReferenceNarrows(
  name: string,
  reference: RefBody,
  local: EntryLookup,
  hops: ExternHops | undefined,
): void {
  for (const supertype of supertypesOf(reference)) {
    const source = local(terminal(supertype, local));
    if (source?.kind !== 'ref') continue;
    if (!isA(reference.of.name, source.of.name, local, hops)) {
      throw new TsonSchemaValidationError(
        `'${name}': not a valid refinement of '!${supertype}' (§5.7): of '${reference.of.name}' is not ` +
          `'${source.of.name}' or IS-A it, so the refinement admits names the source refuses -- ` +
          "a refinement narrows 'of' (§5.7)",
      );
    }
  }
}

/**
 * A namespace type's `key_type` and `value_type` name entries of the schema's namespace (§4.1), and its keys
 * are names: `key_type` is typed `meta.identifier_ref` (§7.4), a member of which is a type built with
 * `identifier_type` -- what a qualified name's segment is -- so an enum-keyed map is no namespace.
 */
function checkNamespaceType(
  name: string,
  namespace: NamespaceBody,
  local: EntryLookup,
  heads: (name: string) => string | undefined,
): void {
  for (const [slot, type] of [
    ['key_type', namespace.keyType],
    ['value_type', namespace.valueType],
  ] as const) {
    if (type.kind === 'inline') continue;
    if (local(terminal(type.name, local)) === undefined) {
      throw new TsonSchemaValidationError(
        `'${name}' is a namespace type whose '${slot}' names '${type.name}', which the schema's ` +
          'namespace does not declare (§4.1)',
      );
    }
  }
  const key = namespace.keyType.name;
  if (local(IDENTIFIER_TYPE) !== undefined && !isKindMember(key, IDENTIFIER_TYPE, local, heads)) {
    throw new TsonSchemaValidationError(
      `'${name}' key_type names '${key}', which is no identifier family -- a namespace's keys are names, so its ` +
        'key type is a member of meta.identifier_ref, a type built with identifier_type; a closed set of names ' +
        'is an identifier family with members (§4.2, §7.4)',
    );
  }
  const family = local(terminal(key, local));
  const dot = family?.kind === 'identifier_type' ? nameTypeDotRefusal(family) : undefined;
  if (dot !== undefined) {
    throw new TsonSchemaValidationError(
      `'${name}' key_type names '${key}', which cannot name a namespace's keys -- ${dot} ([TSON-SCHEMA] §4.2)`,
    );
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
  hops: ExternHops | undefined,
): void {
  for (const field of namedFields(record)) {
    const value = field.value;
    if (value?.form !== 'UNQUOTED') continue;
    const reference =
      field.type.kind === 'inline' ? field.type.of : local(terminal(typeNameOf(field), local));
    if (reference?.kind !== 'ref' || !namesTypes(reference.of.name, local)) {
      continue;
    }
    if (isKindMember(value.text, reference.of.name, local, heads, hops)) continue;
    throw new TsonSchemaValidationError(
      `'${name}': field '${field.name}' is typed '${spelled(typeNameOf(field))}', the names of the types built ` +
        `with '${reference.of.name}', and its ${field.role === 'DEFAULT' ? 'default' : 'fixed value'} ` +
        `'${value.text}' is no member of it (§4.2)`,
    );
  }
}
