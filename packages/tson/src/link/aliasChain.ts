/**
 * Following a chain of `ALIAS` entries to the type at the end of it -- [TSON-SCHEMA] §8.3's
 * walk, stated once.
 *
 * **Why this is a shared module rather than a loop each caller writes.** Resolved output states
 * the chain as the author wrote it: a use site naming an alias names the alias, and a processor
 * collapses the chain only when it actually needs the type at the end of it. That makes the walk
 * the only mechanism -- several passes need it: subsumption's own admissible-name set
 * (`subsumption.ts`), a choice variant's distinctness and its void check (`link/
 * referenceValidation.ts`), a field's stated value checked against its declared type
 * (`link/referenceValidation.ts`, §5.2), a discrimination class (`link/disjointness.ts`, §5.4),
 * and a constructor-application head (`definitionResolver.ts`'s `resolveConstructorTarget`,
 * §5.5). One decision lives inside it -- where the walk stops -- and a copy of the loop per
 * caller would be that decision restated per caller, free to drift.
 *
 * **The walk stops at three things**, and the second is the one worth knowing:
 * - an entry whose body is not an {@link Alias} -- the type at the end;
 * - a name the namespace does not declare, and a cycle. {@link terminal} answers both with the
 *   name it stopped at (an undeclared name may be a parameter of the record naming it, and a
 *   cycle's answer depends on where the walk began, so no false equality follows from it);
 *   {@link terminalDefinition} answers both with `undefined`, having been asked for an entry and
 *   having none to give.
 *
 * **[TSON-SCHEMA] §11.5's "alias chain" limit lives here**, since every caller shares this
 * one walk: a chain that has not reached a terminal (or an undeclared name, or closed a cycle
 * `walked` would otherwise catch for free) within {@link DEFAULT_MAX_ALIAS_CHAIN} hops is a
 * limit refusal (`core/limits.ts`'s own `aliasChainLimitRefusal`), not a resolver error --
 * this deployment declined to spend the resources walking it, distinct from the chain being
 * genuinely broken. `maxHops` defaults from that constant rather than being threaded through
 * every caller; see `core/limits.ts`'s own top note on why the §11.5 schema-side limits are not
 * independently configurable here yet.
 */
import { DEFAULT_MAX_ALIAS_CHAIN, aliasChainLimitRefusal } from '../core/limits.js';
import type { Alias, Top } from '../schema/meta/typedef.js';

/** A single-name lookup -- a finished `Map`'s `get`, or a namespace still being built one declaration at a time (`definitionResolver.ts`'s own `DefinitionGetter`). */
export type EntryLookup = (name: string) => Top | undefined;

/** Where the walk stopped, and whether it stopped on a type rather than on nothing or on itself. */
interface Stop {
  readonly name: string;
  readonly reached: boolean;
}

// An `Alias` value is a hop by its shape alone, with no further lookup needed.
function isAliasBody(body: Top): body is Alias {
  return body.kind === 'alias';
}

function walk(name: string, entries: EntryLookup, maxHops: number = DEFAULT_MAX_ALIAS_CHAIN): Stop {
  const walked = new Set<string>();
  let current = name;
  while (!walked.has(current)) {
    if (walked.size > maxHops) {
      throw aliasChainLimitRefusal(maxHops, name);
    }
    walked.add(current);
    const definition = entries(current);
    if (definition === undefined) {
      return { name: current, reached: false };
    }
    const body = definition;
    if (isAliasBody(body)) {
      current = body.target.name;
      continue;
    }
    return { name: current, reached: true };
  }
  return { name: current, reached: false }; // a cycle has no terminal
}

/**
 * The name at the end of `name`'s alias chain -- `name` itself when it does not start one,
 * and the name the walk stopped at when it cannot reach a type (an undeclared name, or a cycle;
 * see this module's own top note).
 *
 * @throws TsonLimitRefusedError when the chain has not reached a terminal within `maxHops`
 *   (default {@link DEFAULT_MAX_ALIAS_CHAIN}) -- [TSON-SCHEMA] §11.5.
 */
export function terminal(
  name: string,
  entries: EntryLookup,
  maxHops: number = DEFAULT_MAX_ALIAS_CHAIN,
): string {
  return walk(name, entries, maxHops).name;
}

/**
 * The entry at the end of `name`'s chain, or `undefined` where the walk reaches no type.
 *
 * @throws TsonLimitRefusedError when the chain has not reached a terminal within `maxHops`
 *   (default {@link DEFAULT_MAX_ALIAS_CHAIN}) -- [TSON-SCHEMA] §11.5.
 */
export function terminalDefinition(
  name: string,
  entries: EntryLookup,
  maxHops: number = DEFAULT_MAX_ALIAS_CHAIN,
): Top | undefined {
  const stop = walk(name, entries, maxHops);
  return stop.reached ? entries(stop.name) : undefined;
}

/**
 * Whether `name`'s alias chain (§8.3) terminates at an instance of the atom constructor
 * `constructor` (`void_type`, §4.2) -- recognised by the body's constructor, never
 * by the declared name, so `nothing => void` and a schema's own `!void_type {}` instance are the
 * same type as the kernel's `void`.
 */
export function resolvesToConstructor(
  name: string,
  entries: EntryLookup,
  constructor: 'void_type',
): boolean {
  const definition = terminalDefinition(name, entries);
  return definition?.kind === constructor;
}

/**
 * Whether `name`'s alias chain (§8.3) terminates at a `declared_type` instance (§7.8) -- the open sum a
 * value of which names its own type by its tag. An undeclared name and a cycle both read as "no".
 */
export function resolvesToDeclared(name: string, entries: EntryLookup): boolean {
  const definition = terminalDefinition(name, entries);
  return definition?.kind === 'declared_type';
}

// ── §7.2's alias flattening: the written names that mean one declared type ─────────────────────
//
// Both encodings' `$type`/`!type-ref` admission tests need "every name that means this one" --
// [TSON-SCHEMA] §7.2's own "after following the alias chain of both to its terminal" -- so
// this is the one definition, shared rather than restated per encoding (`compiler/subsumption.ts`
// imports it for the text reader's own admission test, `json/schema/dispatchTag.ts`/
// `dispatchMember.ts`/`json/schema/record.ts`/`atoms.ts` for the JSON one, none of which may
// depend on the others -- `link/` is the one zone both sides already reach).

/** The written names that mean `name`: itself, plus every entry whose own alias chain (§8.3) terminates at it. */
export function selfNames(name: string, entries: ReadonlyMap<string, Top>): ReadonlySet<string> {
  const lookup: EntryLookup = (n) => entries.get(n);
  const names = new Set<string>([name]);
  for (const alias of entries.keys()) {
    if (terminal(alias, lookup) === name) names.add(alias);
  }
  return names;
}

/** {@link selfNames}, unioned over every name in `names` -- a family base's own aliases plus every subtype's. */
export function admitting(
  names: readonly string[],
  entries: ReadonlyMap<string, Top>,
): ReadonlySet<string> {
  const all = new Set<string>();
  for (const name of names) {
    for (const alias of selfNames(name, entries)) all.add(alias);
  }
  return all;
}
