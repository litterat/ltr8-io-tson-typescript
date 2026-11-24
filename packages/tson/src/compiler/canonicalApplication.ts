/**
 * An application of a parametric record in canonical form ([TSON-SCHEMA] §8.2): what decides whether two
 * applications are one, where an applied parent's edge looks up the declaration naming its application and §5.10.1's
 * recursion ties a nested application to the declaration closing it. The caller follows each argument's alias chain
 * first.
 *
 * **Compared as structure**: the head and the arguments, each a name, as plain references carrying no annotation, so
 * two spellings of one application are one value. A `Map` keyed on an object compares by identity, so the canonical
 * application is also given as a string key ({@link key}), the one thing a map here is keyed on.
 *
 * @module
 */
import type { ApplyBody, TypeRef } from '../schema/meta/typedef.js';

/** `head` applied to `args`, each already past its alias chain, as one comparable value. */
export function of(head: string, args: readonly TypeRef[]): ApplyBody {
  return {
    kind: 'apply',
    head: { name: head, annotations: [] },
    arguments: args.map((argument) =>
      argument.param === true
        ? { name: argument.name, annotations: [], param: true }
        : { name: argument.name, annotations: [] },
    ),
  };
}

/** `application`'s identity as a string: its head and its arguments, a parameter told from a name. */
export function key(application: Pick<ApplyBody, 'head' | 'arguments'>): string {
  return JSON.stringify([
    application.head.name,
    ...application.arguments.map((argument) =>
      argument.param === true ? `#${argument.name}` : argument.name,
    ),
  ]);
}
