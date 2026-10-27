/**
 * Namespace types (Part 2 §4.1): constructors IS-A the kernel's `namespace`, whose values are maps.
 * `namespace => abstract top & { key_type: identifier_kind  value_type: type_kind  ordered?:
 * boolean ~ false }`, and a type composing it pins the facets: `api => namespace & { key_type: =
 * identifier  value_type: = method }`. A value of one is the map its facets describe, never a record
 * of them, so a namespace type declares nothing beside the three.
 */
import type { RecordBody } from './bodies.js';
import type { Top } from './typedef.js';
import { isTemplateBody, supertypesOf } from './typedef.js';

/** The kernel's base kind whose instances are maps (§4.1). */
export const NAMESPACE_KIND = 'namespace';

/** The three facets a namespace type declares, and nothing else (§4.1). */
export const NAMESPACE_FACETS: readonly string[] = ['key_type', 'value_type', 'ordered'];

/**
 * Whether `value`, the entry `name`, is a namespace type: a record IS-A the kernel's `namespace`
 * (§4.1). The kernel's own `namespace` answers for itself by name.
 */
export function isNamespaceType(value: Top | undefined, name?: string): value is RecordBody {
  if (value === undefined || isTemplateBody(value) || value.kind !== 'record') return false;
  return name === NAMESPACE_KIND || supertypesOf(value).includes(NAMESPACE_KIND);
}

/** The map a namespace type's values are: the types its keys and its values are read under. */
export interface NamespaceMap {
  readonly keyType: string;
  readonly valueType: string;
}

/** `namespace`'s pinned `key_type` and `value_type`, or `undefined` where it leaves either open. */
export function namespaceMapOf(namespace: RecordBody): NamespaceMap | undefined {
  const keyType = namespace.fields.entries.get('key_type')?.value?.text;
  const valueType = namespace.fields.entries.get('value_type')?.value?.text;
  return keyType === undefined || valueType === undefined ? undefined : { keyType, valueType };
}

/**
 * What a key of a host-supplied family is read as: its spelling, any token, judged later under the
 * host's own family -- a record's field names, which linking judges by the record's `name_type`.
 */
export const HOST_KEYS = 'text';

/** The map a value of a namespace type is read by ({@link namespaceReadMapOf}). */
export interface NamespaceReadMap {
  /** The keys' type: the pinned `key_type`, or {@link HOST_KEYS} where the family is a default the host supplies. */
  readonly keyType: string;
  /** The values' type: the pinned `value_type`. */
  readonly valueType: string;
  /** Whether entry order is part of the value: the `ordered` facet, `false` where nothing states it. */
  readonly ordered: boolean;
}

/**
 * The map a value of the namespace type `namespace` is read as (§4.1), never a record of its
 * facets: keys of its `key_type`, values of its pinned `value_type`, ordered as `ordered` says.
 * `key_type` is pinned (`key_type: = F`), or stated by default (`key_type?: ~ F`) where the family
 * the keys are names of is the one the value's host supplies -- `field_map`, keyed by its record's
 * `name_type` -- and such a key is read by its spelling alone ({@link HOST_KEYS}). `undefined` where
 * either facet is left open: the abstract `namespace`, or a namespace type leaving one to a subtype,
 * describes no map.
 */
export function namespaceReadMapOf(namespace: RecordBody): NamespaceReadMap | undefined {
  const key = namespace.fields.entries.get('key_type');
  const keyFamily = key === undefined || key.role === 'FREE' ? undefined : key.value?.text;
  const value = namespace.fields.entries.get('value_type');
  const valueType = value?.role === 'FIXED' ? value.value?.text : undefined;
  if (keyFamily === undefined || valueType === undefined) return undefined;
  return {
    keyType: key?.role === 'FIXED' ? keyFamily : HOST_KEYS,
    valueType,
    ordered: namespace.fields.entries.get('ordered')?.value?.text === 'true',
  };
}
