/**
 * The dependent fields' values a schema's value entries hold as written ([TSON-SCHEMA] §5.2), judged when the
 * schema links against the type each one's sibling names.
 *
 * **Why at link, and not at the read.** A value entry's payload is read by the layer governing the document,
 * and the type a sibling names is one of the reading schema's namespace -- its own entries and its whole
 * import closure -- which that layer's readers do not hold. So the read holds the value as written
 * (`schema/namespaceReader.ts`, a `MetaHeldValue`) and the linker judges it, as a default or pin is judged
 * when the schema links; a held value orders nothing, and the wait order is unchanged.
 *
 * **The judgement is a read.** Once the rest of the link is clean, the linked schema is compiled and each held
 * value is read again, through the reader of the type its sibling names: every refusal that read reports is a
 * schema error at the entry, the slot and the dependent field, and a gap it reports (`NOT_IMPLEMENTED`) is the
 * gap. What the type is follows the read path's rule (`link/dependentFields.ts`, `typeNamed`): the sibling's
 * pin, the value it holds, or its default, naming a type a value can be read against. A dependent field
 * inside the value is read by that type's own reader, the namespace being whole by now.
 *
 * Local value entries only: an imported one was judged when its own schema linked.
 */
import type { DataValue } from '../ast/value.js';
import { collector } from '../core/diagnostic.js';
import { TsonNotImplementedError, TsonSchemaValidationError } from '../core/errors.js';
import { runSync } from '../io/bytes.js';
import { typeNamedIn } from '../link/valuesByName.js';
import type { LinkedSchema } from '../link/link.js';
import { createReadContext } from '../reader/context.js';
import type { MetaHeldValue, MetaValue } from '../schema/meta/typedef.js';
import { isValueEntry } from '../schema/meta/typedef.js';
import { listEventSource } from '../stream/listSource.js';
import { dataValueEvents } from './dataValueEvents.js';
import { compile, type CompiledSchema } from './compile.js';
import { DEFAULT_IDENTIFIER_POLICY, type IdentifierPolicy } from '../unicode/policy.js';

/** One held value with where it sits in its entry. */
interface Held {
  readonly path: readonly string[];
  readonly value: MetaHeldValue;
}

/** Every dependent value `value` holds as written, with its path from the entry's root. */
function heldIn(value: MetaValue, path: readonly string[], found: Held[]): void {
  switch (value.form) {
    case 'held':
      found.push({ path, value });
      return;
    case 'list':
      value.elements.forEach((element, index) => {
        heldIn(element, [...path, String(index)], found);
      });
      return;
    case 'map':
      value.entries.forEach(([key, entry], index) => {
        heldIn(entry, [...path, key.form === 'token' ? key.token.text : String(index)], found);
      });
      return;
    case 'record':
      for (const [name, field] of value.fields) heldIn(field, [...path, name], found);
      return;
    case 'namespace':
      for (const [key, entry] of value.value.entries) heldIn(entry, [...path, key], found);
      return;
    case 'token':
    case 'void':
    case 'schema_map':
      return;
  }
}

/** A slot as an RFC 6901 pointer into the body. */
function pointer(steps: readonly string[]): string {
  return steps.map((step) => `/${step.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

/** Whether any of `localNames` is a value entry that holds a dependent value as written, so a schema holding none is never compiled here. */
export function anyHeldValue(linked: LinkedSchema, localNames: ReadonlySet<string>): boolean {
  for (const name of localNames) {
    const entry = linked.entries.get(name);
    if (entry === undefined || !isValueEntry(entry)) continue;
    const found: Held[] = [];
    heldIn(entry.value, [], found);
    if (found.length > 0) return true;
  }
  return false;
}

/**
 * Judges every dependent value each local value entry of `linked` holds as written, each refusal handed to
 * `report` with the entry holding it, and each gap likewise.
 */
export function judgeHeldValues(
  linked: LinkedSchema,
  localNames: ReadonlySet<string>,
  report: (entry: string, error: TsonSchemaValidationError | TsonNotImplementedError) => void,
  identifierPolicy: IdentifierPolicy = DEFAULT_IDENTIFIER_POLICY,
): void {
  let compiled: CompiledSchema | undefined;
  for (const entryName of localNames) {
    const entry = linked.entries.get(entryName);
    if (entry === undefined || !isValueEntry(entry)) continue;
    const found: Held[] = [];
    heldIn(entry.value, [], found);
    for (const held of found) {
      const where = `'${entryName}' at ${pointer(held.path)}`;
      try {
        compiled ??= compile(linked, { identifierPolicy });
        judge(where, held.value, linked, compiled);
      } catch (error) {
        if (!(
          error instanceof TsonSchemaValidationError || error instanceof TsonNotImplementedError
        )) {
          throw error;
        }
        report(entryName, error);
      }
    }
  }
}

/** Reads `held` against the type its sibling names, refusing as a {@link TsonSchemaValidationError} opening with `where`. */
function judge(
  where: string,
  held: MetaHeldValue,
  linked: LinkedSchema,
  compiled: CompiledSchema,
): void {
  if (held.named === undefined) return; // the sibling holds no reference: its read, or its absence, is refused at the read
  const naming = `${where} is the dependent field '${held.field}', typed by its sibling '${held.sibling}'`;
  const typed = typeNamedIn(held.named, held.declared, linked.entries);
  if (typed.kind === 'none') {
    throw new TsonSchemaValidationError(
      `${naming}, which holds ${typed.held} -- so its value has no type to be read against`,
    );
  }
  const problems = collector();
  const ctx = createReadContext(
    listEventSource(dataValueEvents(held.written as DataValue), `${where}'s held value`),
    problems,
  );
  runSync(compiled.reader(typed.name).read(ctx));
  for (const problem of problems.diagnostics) {
    const path =
      problem.path === undefined || problem.path === '' || problem.path === '/'
        ? ''
        : ` at ${problem.path}`;
    const message =
      `${naming}, whose value is read against '${typed.name}', the type the sibling names, and ` +
      `refused${path} -- ${problem.message}`;
    if (problem.code === 'NOT_IMPLEMENTED') throw new TsonNotImplementedError(message);
    throw new TsonSchemaValidationError(message);
  }
}
