/**
 * Construct `C` from a base with data where the base or the result is an {@link IncompleteEntry} (§5.5):
 * `!C ^ { … }`, `!X ^ { … }` and the completion of `X`. All of it is on the binding record as written, an
 * incomplete entry having no bound body.
 *
 * **A field is written once.** A refinement or a completion of an incomplete entry writes only fields the entry
 * has not written, and one written again is refused whatever its value: narrowing is a relation between types,
 * judged by a facet's kind once the entry is complete, and an incomplete entry only accumulates.
 */
import { TsonInternalError, TsonSchemaValidationError } from '../core/errors.js';
import type { DataValue, RecordField } from '../ast/value.js';
import type { RecordBody } from '../schema/meta/bodies.js';
import type { IncompleteEntry } from '../schema/meta/typedef.js';

/** Why `name`, naming `incomplete`, is refused where a type is named. */
export function noType(name: string, incomplete: IncompleteEntry): string {
  return (
    `an incomplete '${incomplete.head}' with [${incomplete.absent.join(', ')}] absent, which is no type -- ` +
    `complete it where it is used ('!${name} { ... }'), or declare its completion and name that`
  );
}

/** `constructor`'s fields a construction writes, in declaration order: neither optional nor pinned. */
export function required(constructor: RecordBody): string[] {
  const found: string[] = [];
  for (const [name, field] of constructor.fields.entries) {
    if (!field.optional && field.role === 'FREE') found.push(name);
  }
  return found;
}

/** The binding record `incomplete` writes. */
export function writtenValue(incomplete: IncompleteEntry): DataValue {
  return incomplete.written as DataValue;
}

/** The fields `incomplete` writes, in the order written. */
export function written(incomplete: IncompleteEntry): Map<string, DataValue> {
  const fields = braced(writtenValue(incomplete));
  if (fields === undefined) {
    throw new TsonInternalError('an incomplete entry holds a value that is no binding record');
  }
  return fields;
}

/** A binding record's fields by name, `undefined` where `body` is no braced record. */
export function braced(body: DataValue): Map<string, DataValue> | undefined {
  const core = body.coreValue;
  if (core.kind === 'empty-brace') return new Map();
  if (core.kind !== 'record') return undefined;
  return new Map(core.fields.map((field) => [field.name, field.value] as const));
}

/** The binding record tagged `tag` writing `fields`. */
export function record(
  annotated: DataValue,
  tag: string,
  fields: ReadonlyMap<string, DataValue>,
): DataValue {
  const writtenFields: RecordField[] = [...fields].map(([name, value]) => ({ name, value }));
  return {
    annotations: annotated.annotations,
    typeRef: tag,
    coreValue:
      writtenFields.length === 0
        ? { kind: 'empty-brace' }
        : { kind: 'record', fields: writtenFields },
  };
}

/** Refuses a field of `fields` that `constructor` does not declare, or fixes: a pinned field is the constructor's. */
export function requireWritable(
  name: string,
  constructorName: string,
  constructor: RecordBody,
  fields: ReadonlyMap<string, DataValue>,
): void {
  requireDeclared(name, constructorName, constructor, fields);
  for (const field of fields.keys()) {
    if (constructor.fields.entries.get(field)?.role === 'FIXED') {
      throw new TsonSchemaValidationError(
        `'${name}': '${field}' is fixed by '${constructorName}', and no construction writes it (§5.5)`,
      );
    }
  }
}

/** Refuses a field of `fields` that `constructor` does not declare. */
export function requireDeclared(
  name: string,
  constructorName: string,
  constructor: RecordBody,
  fields: ReadonlyMap<string, DataValue>,
): void {
  for (const field of fields.keys()) {
    if (!constructor.fields.entries.has(field)) {
      throw new TsonSchemaValidationError(
        `'${name}': '${field}' is no field of the constructor '${constructorName}' (§5.5)`,
      );
    }
  }
}

/** Refuses a field `fields` writes that `base`, named `baseName`, has written already. */
export function requireWrittenOnce(
  name: string,
  baseName: string,
  base: IncompleteEntry,
  fields: ReadonlyMap<string, DataValue>,
): void {
  const held = written(base);
  const again = [...fields.keys()].filter((field) => held.has(field));
  if (again.length === 0) return;
  throw new TsonSchemaValidationError(
    `'${name}': [${again.join(', ')}] ${again.length === 1 ? 'is' : 'are'} written by '${baseName}' already, ` +
      'and a field of an incomplete entry is written once, whatever the value (§5.5) -- to narrow it, ' +
      `complete '${baseName}' and refine that type`,
  );
}

/**
 * `!X ^ { … }`: what `base` writes and `fields`, which it has not written, adds, leaving a required field
 * absent. One writing the last is refused, a refinement keeping what its base is.
 */
export function refined(
  name: string,
  baseName: string,
  base: IncompleteEntry,
  payload: DataValue,
  fields: ReadonlyMap<string, DataValue>,
  closed: string,
): IncompleteEntry {
  const absent = base.absent.filter((field) => !fields.has(field));
  if (absent.length === 0) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${baseName} ^ { ... }' writes [${base.absent.join(', ')}], every required field ` +
        `'${baseName}' leaves absent, so nothing is left open and '^' keeps what its base is -- complete it ` +
        `with '!${baseName} { ... }'`,
    );
  }
  const merged = new Map(written(base));
  for (const [field, value] of fields) merged.set(field, value);
  return {
    kind: 'incomplete',
    head: base.head,
    absent,
    written: record(payload, base.head, merged),
    bases: closedThrough(closed, base),
  };
}

/**
 * The completion of `base` by `payload`: the binding record of `base`'s constructor writing what `base` writes
 * and what `payload` adds, every required field among them. A payload that is no braced record is the value of
 * the one required field `base` leaves absent, §5.6's positional form: `!nonempty text` is `!nonempty {
 * element_type: text }`.
 */
export function completed(
  name: string,
  baseName: string,
  base: IncompleteEntry,
  constructor: RecordBody,
  payload: DataValue,
): DataValue {
  const fields = braced(payload) ?? positional(name, baseName, base, payload);
  requireWritable(name, base.head, constructor, fields);
  requireWrittenOnce(name, baseName, base, fields);
  const missing = base.absent.filter((field) => !fields.has(field));
  if (missing.length > 0) {
    throw new TsonSchemaValidationError(
      `'${name}': completing '${baseName}' writes every required field it leaves absent, and ` +
        `[${missing.join(', ')}] ${missing.length === 1 ? 'is' : 'are'} not written -- write ` +
        `${missing.length === 1 ? 'it' : 'them'} in '!${baseName} { ... }', or leave the entry open with ` +
        `'!${baseName} ^ { ... }' (§5.5)`,
    );
  }
  const merged = new Map(written(base));
  for (const [field, value] of fields) merged.set(field, value);
  return record(payload, base.head, merged);
}

/**
 * The incomplete entries a construction from `base`, the entry named `closed` past its alias hops, is built
 * through: `closed`, then `base`'s own bases, nearest first.
 */
export function closedThrough(closed: string, base: IncompleteEntry): string[] {
  return [closed, ...base.bases];
}

function positional(
  name: string,
  baseName: string,
  base: IncompleteEntry,
  payload: DataValue,
): Map<string, DataValue> {
  const only = base.absent[0];
  if (base.absent.length !== 1 || only === undefined) {
    throw new TsonSchemaValidationError(
      `'${name}': '${baseName}' leaves [${base.absent.join(', ')}] absent, and a completion is braced, ` +
        `'!${baseName} { ... }' -- the positional form '!${baseName} value' completes only an entry leaving ` +
        'one required field absent (§5.5, §5.6)',
    );
  }
  return new Map([[only, { annotations: [], coreValue: payload.coreValue }]]);
}
