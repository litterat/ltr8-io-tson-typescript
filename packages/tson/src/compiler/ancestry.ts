/**
 * What a written parent contributes to an IS-A chain ([TSON-SCHEMA] §5.8): the one rule a closed declaration's
 * chain is built by at its declaration and a parametric record's application's when materialisation closes it.
 *
 * **A closed parent** contributes itself, the end of its alias chain (§8.3: the terminal is the same type under
 * another name, so IS-A reaches it) and that entry's own chain. **An application** denotes no entry at the position
 * that writes it -- its fields are absorbed by value -- so it contributes its head's ancestors, and nothing for the
 * head itself, an applied parent reaching the entry its arguments name and never its head (§5.8). The edge to the
 * entry a closed application denotes is `schemaResolver.ts`'s to fold, once every declaration has resolved; until
 * then the application is kept in the chain's `parents`, the one list that holds applications.
 *
 * **A parametric record's ancestors are its own chain's `supertypes`**: the closed entries its written parents reach,
 * computed when it was declared, so an imported parametric record yields them as a local one does.
 *
 * @module
 */
import { TsonInternalError } from '../core/errors.js';
import type { Top, TypeChain, TypeExpr } from '../schema/meta/typedef.js';
import { isParametric, supertypesOf, typeChain } from '../schema/meta/typedef.js';
import { typeExprText } from '../schema/meta/bodies.js';
import { terminal } from '../link/aliasChain.js';

/** A name's entry, or `undefined` where nothing is declared under it. */
export type AncestryLookup = (name: string) => Top | undefined;

/** A closed parent's contribution: itself, the end of its alias chain, and that entry's chain. */
export function ofParent(parent: string, lookup: AncestryLookup): string[] {
  const names = [parent];
  const end = terminal(parent, lookup);
  if (end !== parent) names.push(end);
  names.push(...closedNames(lookup(end)));
  return names;
}

/** The names `value`'s chain already holds -- all of it once resolution is done. */
export function closedNames(value: Top | undefined): readonly string[] {
  return supertypesOf(value);
}

/**
 * What an application of the parametric record `head` contributes: the ancestors its own written parents reach, and
 * nothing for the parametric record itself. Empty for a head that is no parametric record.
 */
export function ofApplication(head: string, lookup: AncestryLookup): readonly string[] {
  const record = lookup(parametricHead(head, lookup));
  return isParametric(record) ? supertypesOf(record) : [];
}

/**
 * The parametric record an application's `head` names: the head itself, or, where it is an alias of a parametric
 * record (`pet_of => pet_box`), the parametric record at the end of its alias chain, the alias being the same entry
 * under another name (§8.3). `head` itself where the chain ends at anything else.
 */
export function parametricHead(head: string, lookup: AncestryLookup): string {
  const end = terminal(head, lookup);
  return end !== head && isParametric(lookup(end)) ? end : head;
}

/**
 * The chain a closed record's written parents reach: every closed parent's contribution and every application's,
 * deduplicated, with each application kept in `parents` for the fold.
 */
export function chainOf(written: readonly TypeExpr[], lookup: AncestryLookup): TypeChain {
  const applied: TypeExpr[] = [];
  const names = new Set<string>();
  for (const parent of written) {
    if (parent.kind !== 'inline') {
      for (const name of ofParent(parent.name, lookup)) names.add(name);
      continue;
    }
    if (parent.of.kind !== 'apply') {
      throw new TsonInternalError(
        `a parent is a name or an application, never '${typeExprText(parent)}'`,
      );
    }
    for (const name of ofApplication(parent.of.head.name, lookup)) names.add(name);
    applied.push(parent);
  }
  return typeChain([...names], applied);
}
