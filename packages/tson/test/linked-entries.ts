import type { LinkedSchema } from '../src/link/link.js';
import type { NamespaceBody, RecordBody, ReferenceBody } from '../src/schema/meta/bodies.js';
import type { Top } from '../src/schema/meta/typedef.js';
import { isTemplateBody } from '../src/schema/meta/typedef.js';

/** The kind of the body `name` holds in `linked`, `'template'` for a held body, `undefined` where there is no such entry. */
export function kindOfEntry(linked: LinkedSchema, name: string): string | undefined {
  const entry: Top | undefined = linked.entries.get(name);
  if (entry === undefined) return undefined;
  return isTemplateBody(entry) ? 'template' : entry.kind;
}

/** `name`'s record body, or a thrown error naming what it is instead. */
export function recordEntry(linked: LinkedSchema, name: string): RecordBody {
  const entry = linked.entries.get(name);
  if (entry === undefined || isTemplateBody(entry) || entry.kind !== 'record') {
    throw new Error(`'${name}' is ${kindOfEntry(linked, name) ?? 'no entry'}, not a record`);
  }
  return entry;
}

/** `name`'s reference body, or a thrown error naming what it is instead. */
export function referenceEntry(linked: LinkedSchema, name: string): ReferenceBody {
  const entry = linked.entries.get(name);
  if (entry === undefined || isTemplateBody(entry) || entry.kind !== 'reference_type') {
    throw new Error(`'${name}' is ${kindOfEntry(linked, name) ?? 'no entry'}, not a reference`);
  }
  return entry;
}

/** `name`'s namespace body, or a thrown error naming what it is instead. */
export function namespaceEntry(linked: LinkedSchema, name: string): NamespaceBody {
  const entry = linked.entries.get(name);
  if (entry === undefined || isTemplateBody(entry) || entry.kind !== 'namespace') {
    throw new Error(
      `'${name}' is ${kindOfEntry(linked, name) ?? 'no entry'}, not a namespace type`,
    );
  }
  return entry;
}

/** The name `record`'s field `field` is typed by, or a thrown error where it is typed by a sibling reference. */
export function fieldTypeName(record: RecordBody, field: string): string {
  const type = record.fields.entries.get(field)?.type;
  if (type === undefined || type.kind === 'sibling') {
    throw new Error(`'${field}' is no field typed by a name`);
  }
  return type.name;
}
