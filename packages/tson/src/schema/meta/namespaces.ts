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
