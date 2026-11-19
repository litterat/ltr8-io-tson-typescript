/**
 * What a reference read in data denotes in the closure its slot was linked over (Part 2 §4.2, §8.2):
 * the model's side of the {@link ReferenceIndex} the linker derives.
 */
import type { ReferenceBody } from './bodies.js';
import type { TypeArgument, TypeRef } from './typedef.js';
import { referenceText } from './typedef.js';

/**
 * The entry `reference` denotes in the closure `of` was linked over. A name is its own entry, and an
 * application resolves bottom-up by structural identity (§8.2): each argument that is itself an application
 * first, to the entry the closure closed it to, then the application over those entries, against the
 * applications the closure closed. Each argument is compared after following its alias chain, as §8.2
 * compares an application's arguments, so over `user_id => uuid` the data reference `box<user_id>` denotes
 * what `box<uuid>` does: the key resolution recorded for every application it closed. `undefined` where
 * nothing in the closure closed it, or where the reference is not linked.
 */
export function referenceEntryOf(of: ReferenceBody, reference: TypeRef): string | undefined {
  const index = of.index;
  if (index === undefined) return undefined;
  if (reference.arguments.length === 0) return reference.name;
  const direct = index.applications.get(referenceText(reference));
  if (direct !== undefined) return direct;
  const closed: TypeArgument[] = [];
  for (const argument of reference.arguments) {
    if (argument.kind !== 'ref') {
      closed.push(argument);
      continue;
    }
    const inner =
      argument.ref.arguments.length === 0 ? argument.ref.name : referenceEntryOf(of, argument.ref);
    if (inner === undefined) return undefined;
    closed.push({
      kind: 'ref',
      ref: { name: index.aliases.get(inner) ?? inner, arguments: [], annotations: [] },
    });
  }
  return index.applications.get(
    referenceText({ name: reference.name, arguments: closed, annotations: [] }),
  );
}
