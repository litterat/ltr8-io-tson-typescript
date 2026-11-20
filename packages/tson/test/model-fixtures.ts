/**
 * Small builders for hand-made resolved-schema values in unit tests: an entry is its value (Part 2
 * §8.1), a type carries its chain (§4.1), and a record's fields are a map keyed by name (§5.2).
 */
import type { NamedField, RecordBody, RecordField } from '../src/schema/meta/bodies.js';
import { fieldMapOf, namedFields } from '../src/schema/meta/bodies.js';
import type {
  MetaValue,
  Namespace,
  Top,
  TypeExpr,
  ValueEntry,
} from '../src/schema/meta/typedef.js';
import { withParametersMarked } from '../src/schema/meta/typeInline.js';
import { subtypesOf, supertypesOf, typeChain, withChain } from '../src/schema/meta/typedef.js';

export { fieldMapOf };

/** An entry holding `namespace`, a value of a meta layer's namespace type: `myapi => !api { ... }` (§4.1). */
export function namespaceEntry(namespace: Namespace<MetaValue>): ValueEntry {
  return {
    kind: 'value_entry',
    type: namespace.type,
    value: { form: 'namespace', value: namespace },
  };
}

/** `value` with the chain `supertypes`/`subtypes` -- the resolver's and the linker's facts, stated by hand. */
export function entry<T extends Top>(
  value: T,
  supertypes: readonly string[] = [],
  subtypes: readonly string[] = [],
): T {
  return withChain(value, typeChain(supertypes, [], subtypes));
}

/** A record body over `fields`, OPEN and ungrouped unless `extras` says otherwise. */
export function record(
  fields: readonly NamedField[] = [],
  extras: Partial<Omit<RecordBody, 'kind' | 'fields'>> = {},
): RecordBody {
  return { kind: 'record', fields: fieldMapOf(fields), groups: [], extension: 'OPEN', ...extras };
}

/**
 * `name => <params> { field: type ... }` -- a parametric record (§5.10): `body` taking `parameters`, each reference
 * to one of them at any depth marked as that parameter.
 */
export function parametricRecord(parameters: readonly string[], body: RecordBody): RecordBody {
  return withParametersMarked({ ...body, parameters: parameters.map((name) => ({ name })) });
}

/** `body`'s fields with their names, in declaration order. */
export function fieldsOf(body: Top | undefined): readonly NamedField[] {
  if (body?.kind !== 'record') return [];
  return namedFields(body);
}

/** `body`'s field names, in declaration order. */
export function fieldNamesOf(body: Top | undefined): readonly string[] {
  return fieldsOf(body).map((field) => field.name);
}

/** `body`'s field named `name`, with its name. */
export function fieldOf(body: Top | undefined, name: string): NamedField | undefined {
  return fieldsOf(body).find((field) => field.name === name);
}

/** `field` without its name: what a field map holds under it. */
export function unnamedField(field: NamedField): RecordField {
  const { name: _name, ...rest } = field;
  void _name;
  return rest;
}

/**
 * The name of the type `field` names, `undefined` for no field or one typed by a type written in place -- a
 * dependent one among them, whose type is its sibling's value (§5.2).
 */
export function fieldTypeName(field: { readonly type?: TypeExpr } | undefined): string | undefined {
  return field?.type === undefined || field.type.kind === 'inline' ? undefined : field.type.name;
}

/** `value`'s closed IS-A chain (§4.1), empty for no value at all. */
export function supertypesIn(value: Top | undefined): readonly string[] {
  return value === undefined ? [] : supertypesOf(value);
}

/** `value`'s linker-derived subtypes (§8.1), empty for no value at all. */
export function subtypesIn(value: Top | undefined): readonly string[] {
  return value === undefined ? [] : subtypesOf(value);
}

/**
 * What `value` is, as a test states it: an alias, a value entry, an incomplete entry, or a type by the base kind
 * its constructor reaches (§4.1, §5.5, §8.1) -- a record whose chain reaches `meta.atom`, `meta.product` or
 * `meta.sum` classed by it, a constructor of atoms being an atom's kind.
 */
export function entryClass(
  value: Top,
): 'ALIAS' | 'VALUE' | 'INCOMPLETE' | 'EXTERN' | 'ATOM' | 'PRODUCT' | 'SUM' | 'APPLY' {
  switch (value.kind) {
    case 'alias':
      return 'ALIAS';
    case 'value_entry':
      return 'VALUE';
    case 'incomplete':
      return 'INCOMPLETE';
    case 'extern':
      return 'EXTERN';
    case 'apply':
      return 'APPLY';
    case 'record': {
      const supertypes = supertypesOf(value);
      if (supertypes.includes('meta.atom')) return 'ATOM';
      if (supertypes.includes('meta.sum')) return 'SUM';
      return 'PRODUCT';
    }
    case 'array':
    case 'map':
    case 'namespace':
    case 'tuple':
      return 'PRODUCT';
    case 'choice':
    case 'declared_type':
    case 'dependent':
      return 'SUM';
    default:
      return 'ATOM';
  }
}
