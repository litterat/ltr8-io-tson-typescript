/**
 * Namespace types (Part 2 §4.1): `meta.namespace` is a refinement of `meta.map` whose instances are
 * maps keyed by names, a schema map and an author's own (`api => !meta.namespace { key_type:
 * meta.identifier  value_type: method }`) alike. A value of one is a {@link Namespace}, and a
 * qualified name enters a namespace value and nothing else (§5.12).
 */
import type { NamespaceBody } from './bodies.js';
import type { Top } from './typedef.js';
import { isTemplateBody } from './typedef.js';
import { metaName } from './kernel.js';

/** The kernel's constructor whose instances are namespace types. */
export const NAMESPACE_KIND = metaName('namespace');

/** The facets a namespace type states beyond `meta.map`'s own pinned ones. */
export const NAMESPACE_FACETS: readonly string[] = ['key_type', 'value_type', 'ordered'];

/** Whether `value` is a namespace type: an instance of `meta.namespace`, whose values are maps keyed by names. */
export function isNamespaceType(value: Top | undefined): value is NamespaceBody {
  return value !== undefined && !isTemplateBody(value) && value.kind === 'namespace';
}

/** What reading a namespace value needs of its type (§4.1): the family its keys are names of, the type of its values, and whether key order is part of a value. */
export interface NamespaceMap {
  readonly keyType: string;
  readonly valueType: string;
  readonly ordered: boolean;
}

/** The map `namespace` describes: keys of `key_type`, values of `value_type`, never void. */
export function namespaceMapOf(namespace: NamespaceBody): NamespaceMap {
  return {
    keyType: namespace.keyType.name,
    valueType: namespace.valueType.name,
    ordered: namespace.ordered,
  };
}
