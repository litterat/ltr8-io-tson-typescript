/**
 * What a written parent contributes to an IS-A chain ([TSON-SCHEMA] §5.8): the one rule a closed
 * declaration's chain is built by at its declaration, and a record template's application's when
 * materialisation closes it (`templates.ts`).
 *
 * **A closed parent** contributes itself, the end of its reference chain (§8.3: the terminal is
 * the same type under another name, so IS-A reaches it) and that entry's own chain. **An
 * application** denotes no entry at the position that writes it -- its fields are absorbed by
 * value -- so it contributes its template's ancestors, and nothing for the template, which §5.10
 * makes no type. The edge to the entry a closed application denotes is `schemaResolver.ts`'s to
 * fold, once every declaration has resolved; until then the application is kept in the chain's
 * `parents`, the one list that holds applications.
 *
 * A template's ancestors are its own chain's `supertypes`: the closed entries its written parents
 * reach, computed when it was declared, so an imported template yields them as a local one does.
 *
 * @module
 */
import type { Top, TypeChain, TypeRef } from '../schema/meta/typedef.js';
import { isOpen, supertypesOf, typeChain } from '../schema/meta/typedef.js';
import { terminal } from '../link/referenceChain.js';

/** A name's entry, or `undefined` where nothing is declared under it. */
export type AncestryLookup = (name: string) => Top | undefined;

/** A closed parent's contribution: itself, the end of its reference chain, and that entry's chain. */
export function ofParent(parent: string, lookup: AncestryLookup): string[] {
  const names = [parent];
  const end = terminal(parent, lookup);
  if (end !== parent) names.push(end);
  names.push(...supertypesOf(lookup(end)));
  return names;
}

/**
 * What an application of the template `head` contributes: the ancestors its own written parents
 * reach, and nothing for the template itself. Empty for a head that is no template.
 */
export function ofTemplate(head: string, lookup: AncestryLookup): readonly string[] {
  const template = lookup(head);
  return isOpen(template) ? supertypesOf(template) : [];
}

/**
 * The chain a closed record's written parents reach: every closed parent's contribution and every
 * application's, with each application kept in `parents` for the fold.
 */
export function chainOfParents(written: readonly TypeRef[], lookup: AncestryLookup): TypeChain {
  const applied: TypeRef[] = [];
  const names: string[] = [];
  for (const parent of written) {
    if (parent.arguments.length > 0) {
      names.push(...ofTemplate(parent.name, lookup));
      applied.push(parent);
      continue;
    }
    names.push(...ofParent(parent.name, lookup));
  }
  return typeChain(names, applied);
}
