/**
 * [TSON-SCHEMA] §5.10's written bounds, judged once every declaration is ready.
 *
 * **A bound is written.** A declaration writes one after the parameter's name (`<T: text>`), which names a type;
 * otherwise the parameter is unbounded, and nothing about a parameter is inferred from its uses. A bound naming a
 * constructor admits no argument, a type argument naming a type and no type being IS-A a constructor (§4.1); an
 * incomplete entry is no type (§5.5). Each is refused at the declaration.
 *
 * **A parameter passed on keeps its callee's bound.** One passed as an argument to a bounded parameter of another
 * parametric record is itself written with a bound that IS-A that one, so `rebox => <T> { b: boxed<T> }` over
 * `boxed => <T: text> { v: T }` is refused at `rebox`. Each declaration is judged once against the bounds its
 * callees wrote, so no order among parametric records is needed.
 */
import { TsonSchemaValidationError } from '../core/errors.js';
import type { Param, Top, TypeRef } from '../schema/meta/typedef.js';
import { isParametric, parametersOf, supertypesOf } from '../schema/meta/typedef.js';
import { metaName } from '../schema/meta/kernel.js';
import { applicationsOf } from '../schema/meta/typeInline.js';
import { terminal } from '../link/aliasChain.js';
import { noType } from './incompleteEntries.js';
import type { DefinitionGetter } from './resolverTypes.js';

const TOP = metaName('top');

/** Where a declaration whose parameters are refused is reported. */
export type BoundFailureReporter = (entryName: string, error: TsonSchemaValidationError) => void;

/**
 * Checks each of `local`'s parametric records in `entries` -- the whole namespace, imports included, since a local
 * parametric record may pass a parameter to an imported one -- and returns the names refused. `meta` is where a
 * bound's name is read when the schema does not hold it.
 */
export function checkParameterBounds(
  entries: ReadonlyMap<string, Top>,
  local: ReadonlySet<string>,
  meta: DefinitionGetter,
  report: BoundFailureReporter,
): Set<string> {
  const refused = new Set<string>();
  const lookup: DefinitionGetter = (name) => entries.get(name);
  const judged: string[] = [];
  for (const [name, definition] of entries) {
    if (!local.has(name) || !isParametric(definition)) continue;
    try {
      for (const parameter of parametersOf(definition)) {
        if (parameter.bound !== undefined) requireType(parameter.bound, lookup);
      }
      judged.push(name);
    } catch (error: unknown) {
      if (!(error instanceof TsonSchemaValidationError)) throw error;
      refused.add(name);
      report(name, error);
    }
  }
  for (const name of judged) {
    const definition = entries.get(name);
    if (definition === undefined) continue;
    const mine = new Map(parametersOf(definition).map((parameter) => [parameter.name, parameter]));
    try {
      for (const application of applicationsOf(definition)) {
        const head = application.head.name;
        const callee = entries.get(head);
        const theirs = isParametric(callee) && !refused.has(head) ? parametersOf(callee) : [];
        application.arguments.forEach((argument, index) => {
          const passed = mine.get(argument.name);
          const bounded = theirs[index];
          if (passed === undefined || bounded?.bound === undefined) return;
          requireBound(passed, head, bounded.name, bounded.bound, local.has(head), lookup, meta);
        });
      }
    } catch (error: unknown) {
      if (!(error instanceof TsonSchemaValidationError)) throw error;
      refused.add(name);
      report(name, error);
    }
  }
  return refused;
}

/**
 * A written bound names a type: it resolves in the schema's namespace and names no constructor and no incomplete
 * entry. A bound is a name, `meta.param.bound` being `meta.type_ref` (§4.2).
 */
function requireType(bound: TypeRef, lookup: DefinitionGetter): void {
  const name = bound.name;
  const named = lookup(name);
  if (named === undefined) {
    throw new TsonSchemaValidationError(
      `the bound '${name}': '${name}' names no type in this schema or its imports (§5.10)`,
    );
  }
  if (name === TOP || supertypesOf(named).includes(TOP)) {
    throw new TsonSchemaValidationError(
      `the bound '${name}' names '${name}', and '${name}' is a constructor, not a type (§4.1); a bound names a ` +
        'type, which every argument must IS-A (§5.10)',
    );
  }
  const end = lookup(terminal(name, lookup));
  if (end?.kind === 'incomplete') {
    throw new TsonSchemaValidationError(
      `the bound '${name}' names '${name}', ${noType(name, end)}; a bound names a type, which every argument ` +
        'must IS-A, and no type IS-A an incomplete entry (§5.10)',
    );
  }
}

/** `mine`, passed to `callee`'s `theirs` bounded by `bound`: written with a bound that IS-A it. */
function requireBound(
  mine: Param,
  callee: string,
  theirs: string,
  bound: TypeRef,
  calleeLocal: boolean,
  lookup: DefinitionGetter,
  meta: DefinitionGetter,
): void {
  const required = `'${callee}', which declares '${theirs}: ${bound.name}'`;
  if (mine.bound === undefined) {
    throw new TsonSchemaValidationError(
      `parameter '${mine.name}' is passed to ${required}, and is written with no bound -- a parameter passed to ` +
        `a bounded parameter is written with a bound that IS-A it, '<${mine.name}: ${bound.name}>' (§5.10)`,
    );
  }
  const own = mine.bound;
  if (!isA(own, true, bound, calleeLocal, lookup, meta)) {
    throw new TsonSchemaValidationError(
      `parameter '${mine.name}' is declared '${mine.name}: ${own.name}' and passed to ${required}, and ` +
        `${own.name} is not a type that IS-A ${bound.name} (§5.10)`,
    );
  }
}

/**
 * Whether bound `a` IS-A bound `b`: one name, one terminal past alias hops (§8.3), or `b` among the supertypes `a`'s
 * terminal records. Each is looked up first where its own parametric record resolves: a local one's in the schema,
 * an imported one's among the imports.
 */
function isA(
  a: TypeRef,
  aLocal: boolean,
  b: TypeRef,
  bLocal: boolean,
  lookup: DefinitionGetter,
  meta: DefinitionGetter,
): boolean {
  if (a.name === b.name) return true;
  const find =
    (preferLocal: boolean): DefinitionGetter =>
    (name) =>
      preferLocal ? (lookup(name) ?? meta(name)) : (meta(name) ?? lookup(name));
  const aTerminal = terminal(a.name, find(aLocal));
  const bTerminal = terminal(b.name, find(bLocal));
  if (aTerminal === bTerminal) return true;
  const definition = find(aLocal)(aTerminal);
  if (definition === undefined) return false;
  const supertypes = supertypesOf(definition);
  return supertypes.includes(bTerminal) || supertypes.includes(b.name);
}
