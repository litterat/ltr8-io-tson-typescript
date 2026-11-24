/**
 * One schema's declarations made ready in [TSON-SCHEMA] §3.4.1's wait order: the {@link DefinitionGetter} every lookup
 * of a resolution goes through, so an entry is made ready the first time anything asks for it.
 *
 * - **The rule.** Reading a value against a type waits on that type being ready, and on each type a part of the value
 *   is read against as the read reaches it; a declaration waits as well on its atom refinement source, its `&`
 *   operands and the types of its annotations, an alias on its target. Each such wait is a lookup here made while
 *   another entry is being made ready ({@link WaitOrder.current}). A value placed by its pins waits on each
 *   declaration that may be its member ({@link WaitOrder.joiners}, `familyJoiners.ts`).
 * - **Cycles.** An entry reached again while it is being made ready waits on itself: a
 *   {@link TsonSchemaValidationError} naming the entries on the cycle in wait order (`'a' waits on 'b' waits on 'a'`).
 * - **Wait depth.** The longest chain of waits from an entry is its wait depth: none for an entry that waits on
 *   nothing of this document, one more than the deepest entry it waits on otherwise. An import is ready before the
 *   resolution starts, so a wait ends at one. A chain past `maxWaitDepth` (§11.5) refuses the entry at its head, as
 *   soon as the entries being made ready form one, so recursion never runs deeper than the limit.
 *
 * Source order is never consulted for the verdict or the output: the order entries are reached in changes nothing
 * else. The reference reads each value at a checkpoint compile and starts a read again once what it stopped at is
 * ready; here a read looks a name up through this order and the entry is made ready where the read stands, so a
 * read never starts again.
 *
 * @module
 */
import { TsonInternalError, TsonSchemaValidationError } from '../core/errors.js';
import { waitDepthLimitRefusal } from '../core/limits.js';
import type { Declaration } from '../ast/schema/document.js';
import type { Top } from '../schema/meta/typedef.js';
import { isParametric } from '../schema/meta/typedef.js';
import { typeParamsOf } from './desugar.js';
import { familyJoiners } from './familyJoiners.js';
import type { DefinitionGetter, MemberJoiners } from './resolverTypes.js';

/** How one declaration is made ready, and what is left in its place when that fails. */
export interface Readiness {
  /** The value `declaration` resolves to; every lookup it makes goes through the order. */
  resolve(name: string, declaration: Declaration): Top;
  /** What making `name` ready failing with `error` leaves: `error` rethrown, or the failure reported and a stand-in. */
  failed(name: string, declaration: Declaration, error: unknown): Top;
}

export interface WaitOrder {
  /** `name`'s entry, made ready on first asking; `undefined` for a name no entry or declaration holds. */
  readonly definition: DefinitionGetter;
  /** Supplies how a declaration is made ready; once, before the first lookup. */
  readyWith(readiness: Readiness): void;
  /** The entry being made ready innermost, `undefined` when none is. */
  readonly current: () => string | undefined;
  /**
   * Whether `head`, past its alias hops, is a parametric record, asked without making anything ready: a parametric
   * record's application orders nothing (§3.4.1). A declaration not yet ready answers by its parameter list.
   */
  readonly opens: (head: string) => boolean;
  /** The declarations a value placed by its pins at a family may wait on (§3.4.1, `familyJoiners.ts`). */
  readonly joiners: MemberJoiners;
}

/**
 * The wait order over `declarations`, filling `entries` as each is made ready: everything ready before resolution
 * starts -- the imports -- is in it already.
 */
export function createWaitOrder(
  entries: Map<string, Top>,
  declarations: ReadonlyMap<string, Declaration>,
  maxWaitDepth: number,
): WaitOrder {
  let readiness: Readiness | undefined;
  /** The entries being made ready, innermost last: each waits on the next. */
  const resolving = new Set<string>();
  /** For each entry being made ready, the declarations of this document it has waited on so far. */
  const waits = new Map<string, Set<string>>();
  /** Each ready declaration's wait depth. */
  const depths = new Map<string, number>();

  /** Records that the entry being made ready waits on `name`, one of this document's declarations. */
  const waited = (name: string): void => {
    const waiting = [...resolving].at(-1);
    if (waiting !== undefined && waiting !== name && declarations.has(name)) {
      waits.get(waiting)?.add(name);
    }
  };

  /** `name`'s wait depth, from the depths of the entries it waited on, refused past the limit. */
  const measure = (name: string): void => {
    let depth = 0;
    for (const on of waits.get(name) ?? []) {
      depth = Math.max(depth, (depths.get(on) ?? 0) + 1);
    }
    if (depth > maxWaitDepth) throw waitDepthLimitRefusal(maxWaitDepth, name);
    depths.set(name, depth);
  };

  const definition: DefinitionGetter = (name) => {
    const already = entries.get(name);
    if (already !== undefined) {
      waited(name);
      return already;
    }
    const declaration = declarations.get(name);
    if (declaration === undefined) {
      return undefined; // a name no entry holds yet: a reference a later phase judges
    }
    if (resolving.has(name)) {
      // An entry reached again while it is being made ready waits on itself: the cycle, from its first wait.
      const chain = [...resolving];
      const cycle = [...chain.slice(chain.indexOf(name)), name];
      throw new TsonSchemaValidationError(
        `${cycle.map((entry) => `'${entry}'`).join(' waits on ')}: entries waiting on each other are never ` +
          "ready -- an entry's declaration is read against its head, the types of its annotations, its " +
          "refinement source and its '&' operands, and every type a part of it is read against, each of " +
          'which must be ready first ([TSON-SCHEMA] §3.4.1). A name at a type position orders nothing: ' +
          'type a field by the entry instead of reading a value against it',
      );
    }
    waited(name);
    if (resolving.size > maxWaitDepth) {
      // The entries being made ready are a chain of waits, and this one lengthens it past the limit: refused at
      // its head, which no order can make shallower, before the recursion runs any deeper.
      throw waitDepthLimitRefusal(maxWaitDepth, [...resolving][0] ?? name);
    }
    if (readiness === undefined) {
      throw new TsonInternalError(
        'a wait order was asked for an entry before it was told how to ready one',
      );
    }
    resolving.add(name);
    waits.set(name, new Set());
    let resolved: Top;
    try {
      resolved = readiness.resolve(name, declaration);
      measure(name);
    } catch (error: unknown) {
      resolved = readiness.failed(name, declaration, error);
      depths.set(name, 0);
    } finally {
      resolving.delete(name);
      waits.delete(name);
    }
    entries.set(name, resolved);
    return resolved;
  };

  const opens = (head: string): boolean => {
    const seen = new Set<string>();
    for (let at: string | undefined = head; at !== undefined && !seen.has(at);) {
      seen.add(at);
      const ready = entries.get(at);
      if (ready !== undefined) {
        if (ready.kind !== 'alias') return isParametric(ready);
        at = ready.target.name;
        continue;
      }
      const declaration = declarations.get(at);
      if (declaration === undefined) return false;
      if (typeParamsOf(declaration.typeDef).length > 0) return true;
      const typeDef = declaration.typeDef;
      at =
        typeDef.kind === 'typeExprDef' && typeDef.ref.kind === 'nameRef'
          ? typeDef.ref.name
          : undefined;
    }
    return false;
  };

  // A declaration being made ready is no candidate: waiting on it would be waiting on itself.
  const joiners: MemberJoiners = (base, pins) =>
    familyJoiners(
      base,
      pins.keys(),
      (selector, pin) => pins.get(selector) === pin,
      declarations,
      (name) => entries.get(name),
      (name) => !resolving.has(name),
    );

  return {
    definition,
    readyWith(given: Readiness): void {
      readiness = given;
    },
    current: () => [...resolving].at(-1),
    opens,
    joiners,
  };
}
