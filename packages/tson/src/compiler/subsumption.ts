/**
 * §7.2's rule that a value's own type annotation must be admitted by the position it stands in:
 * "at a position whose declared type is `T`, a value annotated `!S` is valid if and only if,
 * after reference flattening of both (§8.3), `S` is `T` or `T` appears in `S`'s transitive
 * `type_definition.supertypes`". Ported from the reference implementation's `Subsumption`
 * (`tson-compiler/.../reader/Subsumption.java`) and the dispatch half of its
 * `VariantSchemaReader`; see those files' own module docs for the exhaustive rationale.
 *
 * **The guard follows the body, not `definition.kind`.** {@link TypeDefinition.kind} and
 * {@link TypeDefinition.body} are two independent facts about one entry -- a hand-built entry can
 * carry a `ChoiceBody` while claiming `kind: 'PRODUCT'` -- and only an `Atom` or `Product` (record,
 * array, map, tuple) body takes this guard. §7.2 excludes every other shape by name: a `choice`
 * discriminates by variant membership (§5.4) and an `extern` by the foreign schema's namespace
 * (§7.8), each with its own dispatcher whose membership this guard must not override, and a value
 * is never typed by a `Reference` position at all -- every use site is flattened past one (§8.3).
 *
 * **An entry's aliases are the entry.** §7.2 compares "after reference flattening of *both*", so
 * `!created` at a `created`-typed position, where `created => event_created` aliases another
 * entry, names the position's own type even though the reader running there belongs to
 * `event_created`'s own instantiation. The accepted set -- `name` plus every entry that flattens
 * to it -- is computed once, at compile time, since the reader itself cannot know which of its
 * aliases a given position was written as.
 */
import type { Task } from '../io/bytes.js';
import type { ReadContext, TypeReader } from '../reader/contracts.js';
import { lookingAhead } from '../reader/context.js';
import { skipAnnotations, skipDataValue } from '../reader/tree/grammar.js';
import type { Reference, Top, TypeDefinition } from '../schema/meta/typedef.js';
import type { Value } from '../tree/nodes.js';
import { absentNode } from '../tree/nodes.js';
import { isAtom } from './atomChecks.js';

function isReferenceBody(body: Top): body is Reference {
  return 'kind' in body && body.kind === 'reference';
}

const PRODUCT_KINDS: ReadonlySet<string> = new Set(['record', 'array', 'map', 'tuple']);

/** Whether `body` is `Atom`- or `Product`-shaped -- the only bodies §7.2's rule governs. */
function isGuardedBody(body: Top): boolean {
  if (isAtom(body)) return true;
  return 'kind' in body && PRODUCT_KINDS.has(body.kind);
}

/**
 * `name`'s reference chain followed to its end: the first entry that either isn't a bare
 * `REFERENCE` (§8.3's alias form, `x => y` with no `<...>` application) or applies arguments of
 * its own. A cycle stops at whichever name re-enters it rather than spinning -- an unsatisfiable
 * alias loop is a linking-time verdict (`link.ts`), not this pass's to give.
 */
function flatten(name: string, entries: ReadonlyMap<string, TypeDefinition>): string {
  const walked = new Set<string>();
  let current = name;
  while (!walked.has(current)) {
    walked.add(current);
    const definition = entries.get(current);
    if (
      definition === undefined ||
      !isReferenceBody(definition.body) ||
      definition.body.target.arguments.length > 0
    ) {
      return current;
    }
    current = definition.body.target.name;
  }
  return current;
}

/** The written names that mean `name`: itself, plus every entry that {@link flatten}s to it. */
function selfNames(
  name: string,
  entries: ReadonlyMap<string, TypeDefinition>,
): ReadonlySet<string> {
  const names = new Set<string>([name]);
  for (const alias of entries.keys()) {
    if (flatten(alias, entries) === name) {
      names.add(alias);
    }
  }
  return names;
}

/**
 * Looks ahead past a data-value's leading annotations for its own `!type-ref`, without consuming
 * anything -- so whichever reader ultimately runs (the position's own, or a subtype's) sees the
 * whole value, framing included, exactly as it would if nothing had dispatched first.
 */
function* typeRefAhead(ctx: ReadContext): Task<string | undefined> {
  return yield* lookingAhead(ctx, function* (aheadCtx): Task<string | undefined> {
    yield* skipAnnotations(aheadCtx);
    const peeked = yield* aheadCtx.peek();
    return peeked.kind === 'type-ref' ? peeked.name : undefined;
  });
}

/**
 * `reader` guarded by §7.2, or `reader` unchanged where the body it was built for is not one the
 * rule governs ({@link isGuardedBody}). `entries` is the whole linked schema's own namespace
 * (imports merged, §2.2.3), consulted only to compute {@link selfNames} -- the same set every
 * position built against this `name` shares, so `entries` is expected to be the caller's
 * whole-schema map rather than one recomputed per call.
 *
 * A value with no leading `!type-ref`, or one naming a member of `selfNames`, reads straight
 * through `reader` -- the position's own type is always admitted (§7.2's "S is T"). A value naming
 * one of `definition.subtypes` dispatches to that subtype's own compiled reader via `resolve`,
 * read against the same, still-unconsumed value. Anything else is `UNKNOWN_TYPE_REF`, with a
 * message distinguishing a position whose type has no subtypes at all from one whose subtypes just
 * don't include what was named -- and the whole value is discarded, since nothing consumed it.
 */
export function guardSubsumption(
  name: string,
  definition: TypeDefinition,
  reader: TypeReader<Value>,
  entries: ReadonlyMap<string, TypeDefinition>,
  resolve: (name: string) => TypeReader<Value>,
): TypeReader<Value> {
  if (!isGuardedBody(definition.body)) {
    return reader;
  }
  const own = selfNames(name, entries);
  const subtypeNames = definition.subtypes;
  const subtypeSet = new Set(subtypeNames);
  const subtypeList = subtypeNames.join(', ');

  return {
    *read(ctx: ReadContext): Task<Value> {
      const ref = yield* typeRefAhead(ctx);
      if (ref === undefined || own.has(ref)) {
        return yield* reader.read(ctx);
      }
      if (subtypeSet.has(ref)) {
        return yield* resolve(ref).read(ctx);
      }
      ctx.report(
        'UNKNOWN_TYPE_REF',
        subtypeNames.length === 0
          ? `'!${ref}' is not valid at a '${name}' position -- a type annotation must name the ` +
              `position's own type, which has no subtypes (§7.2)`
          : `'!${ref}' is not a known subtype of '${name}' (§7.2) -- expected one of (${subtypeList})`,
        subtypeNames.length === 0 ? `'${name}'` : `one of (${subtypeList})`,
        `!${ref}`,
      );
      yield* skipDataValue(ctx); // framing included: nothing consumed it, this value being unreadable
      return absentNode();
    },
  };
}
