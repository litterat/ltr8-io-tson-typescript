/**
 * What a written parent contributes to an IS-A chain ([TSON-SCHEMA] §5.8): the one rule a closed declaration's
 * chain is built by at its declaration. **A closed parent** contributes itself, the end of its alias chain (§8.3:
 * the terminal is the same type under another name, so IS-A reaches it) and that entry's own chain.
 *
 * @module
 */
import type { Top } from '../schema/meta/typedef.js';
import { supertypesOf } from '../schema/meta/typedef.js';
import { terminal } from '../link/aliasChain.js';

/** A name's entry, or `undefined` where nothing is declared under it. */
export type AncestryLookup = (name: string) => Top | undefined;

/** A closed parent's contribution: itself, the end of its alias chain, and that entry's chain. */
export function ofParent(parent: string, lookup: AncestryLookup): string[] {
  const names = [parent];
  const end = terminal(parent, lookup);
  if (end !== parent) names.push(end);
  names.push(...supertypesOf(lookup(end)));
  return names;
}
