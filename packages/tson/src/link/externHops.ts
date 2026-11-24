/**
 * One namespace's judgements through its externs ([TSON-SCHEMA] §5.13, §8.3): an extern is another name for the
 * foreign entry it lands on, so every question asked of it is asked of that entry, in the namespace that holds it,
 * and every comparison is by identity -- the declaring schema and the path -- never by spelling, the two namespaces
 * spelling their names independently.
 *
 * Every answer is the plain one where the namespace holds no extern, so a caller passes hops unconditionally.
 */
import type { Top } from '../schema/meta/typedef.js';
import {
  constructorOf,
  isConstructor,
  isParametric,
  supertypesOf,
} from '../schema/meta/typedef.js';
import { terminal, type EntryLookup } from './aliasChain.js';
import { discriminationClassOf, type DiscriminationClass } from './disjointness.js';
import {
  declaringIdentity,
  landingDefinition,
  landingOf,
  type ExternTarget,
  type Landing,
} from './externTarget.js';
import type { LinkedSchema } from './link.js';

/** One namespace's hops through its externs. */
export interface ExternHops {
  /** Whether the namespace holds an attached extern at all: every answer below is the plain one where it holds none. */
  any(): boolean;
  /** The foreign entry `name` lands on past its alias hops, or `undefined` where it names no attached extern. */
  landing(name: string): Landing | undefined;
  /**
   * The identity of the type `name` denotes: the schema declaring the entry at the end of its hops, alias and
   * extern alike, and its path there.
   */
  identity(name: string): string;
  /**
   * Whether `name`, landing through an extern, is a member of the reference over the constructor `of` named in
   * this namespace: the foreign entry's constructor, or one on that constructor's chain, is `of` by identity (§4.2).
   * `undefined` where `name` lands through no extern, the plain walk answering.
   */
  membership(name: string, of: string): boolean | undefined;
  /**
   * The discrimination class of what `name` lands on, classified in the namespace holding it (§5.4); the outer
   * `undefined` where `name` lands through no extern, `{ class: undefined }` where what it lands on has none.
   */
  discrimination(name: string): { readonly class: DiscriminationClass | undefined } | undefined;
}

/** No namespace's hops: every answer is the plain one. */
export const NO_HOPS: ExternHops = {
  any: () => false,
  landing: () => undefined,
  identity: (name) => name,
  membership: () => undefined,
  discrimination: () => undefined,
};

/**
 * The hops of a namespace whose entries `entries` holds, each declared in `originOf(name)` (canonical), its
 * attached externs `targets`.
 */
export function externHops(
  entries: EntryLookup,
  originOf: (name: string) => string,
  targets: ReadonlyMap<string, ExternTarget>,
): ExternHops {
  function landing(name: string): Landing | undefined {
    const end = terminal(name, entries);
    if (entries(end)?.kind !== 'extern') return undefined;
    const target = targets.get(end);
    return target === undefined ? undefined : landingOf(target);
  }

  function identity(name: string): string {
    const end = landing(name);
    if (end !== undefined) return `${declaringIdentity(end.in, end.name)}#${end.name}`;
    const last = terminal(name, entries);
    return `${originOf(last)}#${last}`;
  }

  function membership(name: string, of: string): boolean | undefined {
    const end = landing(name);
    if (end === undefined) return undefined;
    const definition = landingDefinition(end);
    if (
      definition === undefined ||
      isParametric(definition) ||
      definition.kind === 'value_entry' ||
      definition.kind === 'incomplete'
    ) {
      return false;
    }
    const there: EntryLookup = (entry) => end.in.entries.get(entry);
    const head = terminal(end.in.facts.get(end.name)?.head ?? constructorOf(definition), there);
    let headDefinition: Top | undefined = there(head);
    let declaredBy = (entry: string): string => declaringIdentity(end.in, entry);
    if (headDefinition === undefined) {
      // A schema whose closure holds no kernel writes the processor's own kernel's forms (§3.3.1), which this
      // namespace holds.
      headDefinition = entries(head);
      declaredBy = originOf;
    }
    if (headDefinition !== undefined && !isConstructor(headDefinition, head)) return false;
    const constructors = new Set<string>([`${declaredBy(head)}#${head}`]);
    for (const supertype of supertypesOf(headDefinition)) {
      constructors.add(`${declaredBy(supertype)}#${supertype}`);
    }
    return constructors.has(identity(of));
  }

  function discrimination(
    name: string,
  ): { readonly class: DiscriminationClass | undefined } | undefined {
    const end = landing(name);
    if (end === undefined) return undefined;
    // The landing itself may be another namespace's extern-free entry; it is classified there.
    return { class: discriminationClassOf(end.name, end.in.entries, externHopsOf(end.in)) };
  }

  return {
    any: () => targets.size > 0,
    landing,
    identity,
    membership,
    discrimination,
  };
}

/** The hops of `linked`'s namespace. */
export function externHopsOf(linked: LinkedSchema): ExternHops {
  const targets = linked.externs;
  if (targets === undefined || targets.size === 0) return NO_HOPS;
  return externHops(
    (name) => linked.entries.get(name),
    (name) => declaringIdentity(linked, name),
    targets,
  );
}

/**
 * §7.2's IS-A between two names of one namespace, through its hops ([TSON-SCHEMA] §5.13, §8.3): past their alias
 * hops they are one entry, or the first's chain lists the second; and, through an extern, the two reach one entry by
 * identity, or the entry the first reaches lists, in the namespace holding it, an entry of the second's identity.
 * With no hops this is the plain walk.
 */
export function isAThroughHops(
  sub: string,
  sup: string,
  entries: EntryLookup,
  hops: ExternHops,
): boolean {
  const wanted = terminal(sup, entries);
  const end = terminal(sub, entries);
  if (end === wanted) return true;
  if (supertypesOf(entries(end)).some((supertype) => terminal(supertype, entries) === wanted)) {
    return true;
  }
  if (!hops.any()) return false;
  const identity = hops.identity(sup);
  if (hops.identity(sub) === identity) return true;
  const landing = hops.landing(sub);
  // A supertype is a name of the namespace holding the entry, so its identity is read there.
  return landing === undefined
    ? supertypesOf(entries(end)).some((supertype) => hops.identity(supertype) === identity)
    : supertypesOf(landingDefinition(landing)).some(
        (supertype) => `${declaringIdentity(landing.in, supertype)}#${supertype}` === identity,
      );
}
