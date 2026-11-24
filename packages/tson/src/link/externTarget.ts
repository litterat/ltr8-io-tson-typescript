/**
 * Where an extern lands ([TSON-SCHEMA] §5.13): the entry its `type` names in the namespace of the linked schema its
 * `schema` names. Linking attaches it (`LinkedSchema.externs`); the extern's value states only what was written, so
 * the landing is a fact of the link and never of the model, which a schema that never links an extern ships without.
 *
 * Every judgement through the hop compares the {@link Landing}: the entry at the end of the foreign alias hops and of
 * any further externs, in the namespace that holds it, so an extern, an import of the entry it names and an extern
 * of that extern are one type (§8.3), compared by identity -- the declaring schema and the path there (§2.2.3, §8.2).
 */
import type { Top } from '../schema/meta/typedef.js';
import { terminal } from './aliasChain.js';
import { canonicalizeIdentity } from './identity.js';
import type { LinkedSchema } from './link.js';

/** An extern attached: the linked schema it names, and the name its `type` writes there. */
export interface ExternTarget {
  readonly foreign: LinkedSchema;
  readonly type: string;
}

/**
 * An entry reached through externs: `name` in the namespace of `in`. Its identity is the schema that declared it and
 * its path there (§8.3).
 */
export interface Landing {
  readonly in: LinkedSchema;
  readonly name: string;
}

/** The canonical identity of the schema that declared `name` in `linked`'s namespace, local or imported (§2.2.3). */
export function declaringIdentity(linked: LinkedSchema, name: string): string {
  // `origins` holds canonical identities already, and a canonical identity is not itself a reference to read.
  return linked.origins.get(name) ?? canonicalizeIdentity(linked.id);
}

/** `landing`'s identity: its declaring schema and its path there. */
export function identityOfLanding(landing: Landing): string {
  return `${declaringIdentity(landing.in, landing.name)}#${landing.name}`;
}

/** The entry `landing` reaches. */
export function landingDefinition(landing: Landing): Top | undefined {
  return landing.in.entries.get(landing.name);
}

/**
 * The entry `target` finally names, or `undefined` where a hop names nothing or the walk closes on itself -- a
 * foreign schema whose link refused such a hop is never attached, so this answers for a well-formed chain.
 */
export function landingOf(target: ExternTarget): Landing | undefined {
  let within = target.foreign;
  let name = target.type;
  const seen = new Set<string>();
  for (;;) {
    const key = `${declaringIdentity(within, name)}#${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const definition = within.entries.get(name);
    if (definition === undefined) return undefined;
    if (definition.kind === 'alias') {
      name = definition.target.name;
      continue;
    }
    if (definition.kind === 'extern') {
      const next = within.externs?.get(name);
      if (next === undefined) return undefined;
      within = next.foreign;
      name = next.type;
      continue;
    }
    return { in: within, name };
  }
}

/**
 * The foreign entry `name` lands on in `linked`'s namespace past its alias hops, or `undefined` where it names no
 * attached extern.
 */
export function landingIn(linked: LinkedSchema, name: string): Landing | undefined {
  const lookup = (entry: string): Top | undefined => linked.entries.get(entry);
  const end = terminal(name, lookup);
  if (lookup(end)?.kind !== 'extern') return undefined;
  const target = linked.externs?.get(end);
  return target === undefined ? undefined : landingOf(target);
}
