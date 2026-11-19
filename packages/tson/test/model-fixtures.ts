/**
 * Small builders for hand-made resolved-schema values in unit tests: an entry is its value (Part 2
 * §8.1), a type carries its chain (§4.1), and a record's fields are a map keyed by name (§5.2).
 */
import type {
  NamedField,
  RecordBody,
  RecordField,
  RecordTemplateBody,
  RecordTemplateField,
} from '../src/schema/meta/bodies.js';
import { fieldMapOf, namedFields } from '../src/schema/meta/bodies.js';
import type {
  MetaValue,
  Namespace,
  Reference,
  Top,
  ValueEntry,
} from '../src/schema/meta/typedef.js';
import {
  isTemplateBody,
  namespaceOf,
  subtypesOf,
  supertypesOf,
  typeChain,
  withChain,
} from '../src/schema/meta/typedef.js';

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
 * `<params> => { field: type ... }` -- a record template (§5.10): its fields label a parameter standing for
 * a whole type (`type_param`), and it carries its parameters.
 */
export function recordTemplate(
  parameters: readonly string[],
  body: RecordBody,
): RecordTemplateBody {
  const fields = [...body.fields.entries].map(([name, f]): [string, RecordTemplateField] => {
    const { type, ...rest } = f;
    return [
      name,
      type.kind !== 'sibling' && type.arguments.length === 0 && parameters.includes(type.name)
        ? { ...rest, typeParam: type.name }
        : { ...rest, type },
    ];
  });
  return {
    kind: 'record_template',
    fields: namespaceOf(body.fields.type, fields, body.fields.keyAnnotations),
    groups: body.groups,
    extension: body.extension,
    ...(body.discriminators === undefined ? {} : { discriminators: body.discriminators }),
    parameters: parameters.map((name) => ({
      name,
      type: { name: 'meta.type_ref', arguments: [], annotations: [] },
    })),
  };
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

/** The name of the type `field` names, `undefined` for no field or a dependent one, whose type is its sibling's value (§5.2). */
export function fieldTypeName(
  field: { readonly type?: Reference } | undefined,
): string | undefined {
  return field?.type === undefined || field.type.kind === 'sibling' ? undefined : field.type.name;
}

/** `value`'s closed IS-A chain (§4.1), empty for no value at all. */
export function supertypesIn(value: Top | undefined): readonly string[] {
  return value === undefined ? [] : supertypesOf(value);
}

/** `value`'s linker-derived subtypes (§8.1), empty for no value at all. */
export function subtypesIn(value: Top | undefined): readonly string[] {
  return value === undefined ? [] : subtypesOf(value);
}
