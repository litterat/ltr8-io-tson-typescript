/**
 * The link's half of an extern ([TSON-SCHEMA] §5.13): each local extern attached to the entry it lands on in its
 * foreign schema's namespace, that schema loaded with the imports of the schema declaring it (§3.4.1). An extern
 * names a type a value can have, anywhere in its schema's closure; anything else is refused against the extern,
 * naming the foreign entry, and stays unattached, a use of it then landing nowhere.
 */
import { TsonSchemaValidationError } from '../core/errors.js';
import type { Top } from '../schema/meta/typedef.js';
import { isConstructor, isParametric } from '../schema/meta/typedef.js';
import { isNestedMap } from '../schema/meta/schemaPaths.js';
import { terminal } from './aliasChain.js';
import { describeExtern } from './externs.js';
import type { ExternTarget } from './externTarget.js';
import { canonicalizeIdentity } from './identity.js';
import type { LinkedSchema } from './link.js';

/** Where an extern's foreign schema is obtained: loaded with the imports, by canonical identity. */
export type ExternSchemaLoader = (identity: string) => LinkedSchema | undefined;

/**
 * Attaches each extern among `localNames` to its landing, into `externs`, reporting each one refused through
 * `refuse` (which may throw). `loader` absent loads nothing, so every extern is refused as not loaded.
 */
export function attachExterns(
  merged: ReadonlyMap<string, Top>,
  localNames: ReadonlySet<string>,
  loader: ExternSchemaLoader | undefined,
  externs: Map<string, ExternTarget>,
  refuse: (name: string, error: TsonSchemaValidationError) => void,
): void {
  for (const name of localNames) {
    const extern = merged.get(name);
    if (extern?.kind !== 'extern') continue;
    let identity: string;
    try {
      identity = canonicalizeIdentity(extern.schema);
    } catch (error: unknown) {
      refuse(
        name,
        new TsonSchemaValidationError(
          `'${name}' is ${describeExtern(extern)}, whose schema is no identity -- ` +
            (error instanceof Error ? error.message : String(error)),
        ),
      );
      continue;
    }
    const foreign = loader?.(identity);
    if (foreign === undefined) {
      refuse(
        name,
        new TsonSchemaValidationError(
          `'${name}' is ${describeExtern(extern)}, whose schema is not loaded -- an extern's schema loads with ` +
            'the imports of the schema declaring it ([TSON-SCHEMA] §3.4.1, §5.13)',
        ),
      );
      continue;
    }
    const target: ExternTarget = { foreign, type: extern.type };
    const refusal = externRefusal(target);
    if (refusal !== undefined) {
      refuse(
        name,
        new TsonSchemaValidationError(
          `'${name}' is ${describeExtern(extern)}, which ${refusal} -- an extern names a type a value can ` +
            "have, declared anywhere in its schema's closure ([TSON-SCHEMA] §5.13)",
        ),
      );
      continue;
    }
    externs.set(name, target);
  }
}

/** Why the foreign entry `target` names is no type an extern may name, or `undefined` where it is one. */
function externRefusal(target: ExternTarget): string | undefined {
  const foreign = target.foreign;
  const there = (entry: string): Top | undefined => foreign.entries.get(entry);
  const name = target.type;
  const definition = there(name);
  if (definition === undefined) return "that schema's closure does not hold";
  if (definition.kind === 'extern') {
    return foreign.externs?.has(name) === true
      ? undefined
      : "is an extern that schema's link refused";
  }
  const what = noType(name, definition);
  if (what !== undefined || definition.kind !== 'alias') return what;
  const end = terminal(name, there);
  const atEnd = there(end);
  if (atEnd?.kind === 'extern') {
    return foreign.externs?.has(end) === true
      ? undefined
      : `is an alias of '${end}', an extern that schema's link refused`;
  }
  const reason = atEnd === undefined ? 'names nothing' : noType(end, atEnd);
  return reason === undefined ? undefined : `is an alias of '${end}', which ${reason}`;
}

/** What makes the foreign entry `name` no type a value can have, or `undefined` where it is one. */
function noType(name: string, definition: Top): string | undefined {
  if (isNestedMap(definition)) return 'is a schema map, and an extern names one type';
  if (definition.kind === 'value_entry') return 'is a value entry, which is a value and no type';
  if (definition.kind === 'incomplete') {
    return 'is an incomplete entry, which is no type until it is completed';
  }
  if (isParametric(definition)) {
    return 'is a parametric record, which denotes no type until it is applied (§5.10)';
  }
  if (definition.kind !== 'alias' && isConstructor(definition, name)) {
    return 'is a constructor, whose values are types and which an extern can neither apply nor extend';
  }
  return undefined;
}
