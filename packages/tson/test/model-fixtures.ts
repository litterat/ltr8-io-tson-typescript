/**
 * Small builders for hand-made resolved-schema values in unit tests: an entry is its value (Part 2
 * §8.1), a type carries its chain (§4.1), and a record's fields are a map keyed by name (§5.2).
 */
import type { NamedField, RecordBody, RecordField } from '../src/schema/meta/bodies.js';
import { fieldMapOf, namedFields } from '../src/schema/meta/bodies.js';
import type { Top } from '../src/schema/meta/typedef.js';
import {
  isTemplateBody,
  subtypesOf,
  supertypesOf,
  typeChain,
  withChain,
} from '../src/schema/meta/typedef.js';

export { fieldMapOf };

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

/** `body`'s fields with their names, in declaration order. */
export function fieldsOf(body: Top | undefined): readonly NamedField[] {
  if (body === undefined || isTemplateBody(body) || body.kind !== 'record') return [];
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

/** `value`'s closed IS-A chain (§4.1), empty for no value at all. */
export function supertypesIn(value: Top | undefined): readonly string[] {
  return value === undefined ? [] : supertypesOf(value);
}

/** `value`'s linker-derived subtypes (§8.1), empty for no value at all. */
export function subtypesIn(value: Top | undefined): readonly string[] {
  return value === undefined ? [] : subtypesOf(value);
}
